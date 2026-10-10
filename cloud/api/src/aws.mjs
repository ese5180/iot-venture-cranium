/**
 * The AWS adapter: the only module that imports the AWS SDK.
 *
 * Handlers never see an SDK client, command, exception or Date. They call the methods
 * below and get plain values back. Times are epoch milliseconds or null. An outcome a
 * handler has to tell apart (an object or version that already exists, a missing
 * shadow, an unknown job) is a return value. Anything else is thrown as an Error with
 *
 *   name = "AwsError", code = "throttled" | "failed", operation = the AWS operation,
 *   awsError = the AWS error name, awsStatus = the HTTP status or null
 *
 * and a message for the log. test/fake-aws.mjs implements the same interface in
 * memory; keep the two in step.
 *
 * createAws(env) reads AWS_REGION, STATE_TABLE, AUDIT_TABLE, FIRMWARE_BUCKET,
 * THING_GROUP, PRESIGN_ROLE_ARN and USER_POOL_ID.
 *
 * Things and shadows
 *   listGroupThings()             -> string[]        names of all things in the group, any order
 *   listThingPrincipals(thing)    -> string[]        principal ARNs; [] for an unknown thing
 *   getShadow(thing)              -> object | null   the classic shadow document as parsed JSON
 *                                                    ({ state, metadata, version, timestamp });
 *                                                    null when the thing has no shadow
 *
 * Jobs (times in ms; a status is the AWS string, e.g. "IN_PROGRESS")
 *   listJobs()                    -> [{ jobId, status, createdAt, lastUpdatedAt, completedAt }]
 *                                    every job of the account, any order
 *   describeJob(jobId)            -> null for an unknown job, else
 *                                    { jobId, status, description, things: string[],
 *                                      createdAt, lastUpdatedAt, completedAt,
 *                                      forceCanceled: boolean, reasonCode: string | null,
 *                                      counts: { queued, inProgress, succeeded, failed, rejected,
 *                                                canceled, timedOut, removed } }
 *                                    things are the thing names among the job's targets
 *   listJobExecutionsForJob(jobId)
 *                                 -> [{ thing, status, queuedAt, startedAt, lastUpdatedAt,
 *                                       executionNumber }]; [] for an unknown job
 *   describeJobExecution(jobId, thing)
 *                                 -> null if there is none, else
 *                                    { thing, status, statusDetails: { [key]: string },
 *                                      queuedAt, startedAt, lastUpdatedAt, executionNumber,
 *                                      secondsLeft: number | null, forceCanceled: boolean }
 *                                    statusDetails is what the board wrote: untrusted
 *   listJobExecutionsForThing(thing)
 *                                 -> [{ jobId, status, queuedAt, startedAt, lastUpdatedAt,
 *                                       executionNumber }]; [] for an unknown thing
 *   createJob({ jobId, things, document, description, urlExpiresInSec, inProgressTimeoutMinutes })
 *                                 -> { ok: true }
 *                                  | { ok: false, reason: "exists" }            the id is taken
 *                                  | { ok: false, reason: "target_not_found" }  a thing is gone
 *                                    a snapshot job on exactly these things; AWS IoT presigns
 *                                    the download URL in the document with the presign role
 *   cancelJob({ jobId, force, reasonCode, comment })
 *                                 -> { ok: true }
 *                                  | { ok: false, reason: "not_found" }
 *                                  | { ok: false, reason: "refused", detail }   AWS will not
 *                                    cancel the job in the state it is in
 *
 * Firmware objects
 *   putFirmwareObject({ key, body, sha256Base64 })
 *                                 -> { stored: true }
 *                                  | { stored: false, reason: "exists" }        the key is taken;
 *                                    nothing was written
 *   tagFirmwareRevoked(key)       -> { ok: true } | { ok: false, reason: "not_found" }
 *
 * Releases (state table; an item is the release plus pk and sk)
 *   getRelease(sk)                -> object | null   consistent read
 *   listReleases()                -> object[]        highest sk first
 *   registerRelease({ sk, release })
 *                                 -> { ok: true }
 *                                  | { ok: false, reason: "exists" }            this sk is registered
 *                                  | { ok: false, reason: "not_newer", highest } sk is not above the
 *                                    highest sk ever registered (highest: that sk, or null)
 *                                  | { ok: false, reason: "conflict" }          a concurrent write
 *                                    one transaction: the release is stored and the pointer to
 *                                    the highest sk is advanced, or neither happens
 *   markReleaseRevoked({ sk, revoked })
 *                                 -> { ok: true, release }  the item after the change
 *                                  | { ok: false, reason: "not_active" }  no such release, or it
 *                                    is not active
 *
 * Audit (audit table; an item carries sk = "<ISO time>#<request id>")
 *   putAudit(item)                -> { ok: true } | { ok: false, reason: "exists" }
 *   queryAudit({ before, limit }) -> object[]   at most `limit` items, highest sk first, only
 *                                               items with sk below `before` unless it is null
 *
 * Users (Cognito user pool; the username is the token's sub)
 *   getUser(sub)                  -> { enabled: boolean, status: string, email: string } | null
 *   listUserGroups(sub)           -> string[]   [] for an unknown user
 */

import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  AdminGetUserCommand, AdminListGroupsForUserCommand, CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, TransactWriteItemsCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import {
  CancelJobCommand, CreateJobCommand, DescribeJobCommand, DescribeJobExecutionCommand, IoTClient,
  ListJobExecutionsForJobCommand, ListJobExecutionsForThingCommand, ListJobsCommand,
  ListThingPrincipalsCommand, ListThingsInThingGroupCommand,
} from '@aws-sdk/client-iot';
import { GetThingShadowCommand, IoTDataPlaneClient } from '@aws-sdk/client-iot-data-plane';
import { PutObjectCommand, PutObjectTaggingCommand, S3Client } from '@aws-sdk/client-s3';

// The largest page the list operations of AWS IoT allow, and of Cognito for groups.
const PAGE_SIZE = 250;
const GROUP_PAGE_SIZE = 60;
// A list longer than this is not this project's: stop instead of reading for ever.
const MAX_PAGES = 40;

const RELEASE_PK = 'REL';
const POINTER_KEY = Object.freeze({ pk: { S: 'META' }, sk: { S: 'HIGHEST' } });
const AUDIT_PK = 'AUD';

const THROTTLING = new Set([
  'ThrottlingException', 'Throttling', 'ThrottledException', 'TooManyRequestsException',
  'RequestLimitExceeded', 'ProvisionedThroughputExceededException', 'RequestThrottled',
  'RequestThrottledException', 'SlowDown',
]);

/**
 * The version of the SDK that the Lambda runtime provides. It is not pinned by this
 * project, so the log says which one served a request.
 */
async function sdkVersion() {
  try {
    const manifest = await import('@aws-sdk/client-s3/package.json', { with: { type: 'json' } });
    return String(manifest.default.version);
  } catch {
    try {
      return String(createRequire(import.meta.url)('@aws-sdk/client-s3/package.json').version);
    } catch {
      return 'unknown';
    }
  }
}

console.log(JSON.stringify({ event: 'cold_start', sdkVersion: await sdkVersion(), node: process.version }));

function nameOf(cause) {
  return cause !== null && typeof cause === 'object' && typeof cause.name === 'string' ? cause.name : 'Error';
}

function statusOf(cause) {
  const status = cause?.$metadata?.httpStatusCode;
  return Number.isInteger(status) ? status : null;
}

function isThrottling(cause) {
  return THROTTLING.has(nameOf(cause)) || statusOf(cause) === 429 || cause?.$retryable?.throttling === true;
}

/** The error a handler sees for a failure it cannot act on. Carries no SDK object. */
function failure(operation, cause, code) {
  const error = new Error(`${operation}: ${nameOf(cause)}: ${String(cause?.message ?? cause).slice(0, 300)}`);
  error.name = 'AwsError';
  error.code = code ?? (isThrottling(cause) ? 'throttled' : 'failed');
  error.operation = operation;
  error.awsError = nameOf(cause);
  error.awsStatus = statusOf(cause);
  return error;
}

/** Epoch milliseconds for a timestamp of the SDK, or null. */
function millis(value) {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.getTime() : null;
}

function count(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

/** The thing name in a thing ARN, or null for any other ARN. */
function thingOfArn(arn) {
  if (typeof arn !== 'string') return null;
  const at = arn.indexOf(':thing/');
  return at === -1 ? null : arn.slice(at + ':thing/'.length);
}

function executionSummary(summary) {
  return {
    status: typeof summary?.status === 'string' ? summary.status : null,
    queuedAt: millis(summary?.queuedAt),
    startedAt: millis(summary?.startedAt),
    lastUpdatedAt: millis(summary?.lastUpdatedAt),
    executionNumber: Number.isFinite(summary?.executionNumber) ? summary.executionNumber : null,
  };
}

/** Read every page of a list operation. `page(token)` returns { items, next }. */
async function everyPage(operation, page) {
  const all = [];
  let token;
  for (let pages = 0; pages < MAX_PAGES; pages += 1) {
    const { items, next } = await page(token);
    all.push(...items);
    if (next === undefined || next === null || next === '') return all;
    token = next;
  }
  throw failure(operation, new Error(`more than ${MAX_PAGES} pages`), 'failed');
}

// DynamoDB attribute values for the plain data this module stores: text, numbers,
// booleans, null, lists and maps.
function toAttribute(value) {
  if (value === null) return { NULL: true };
  if (typeof value === 'string') return { S: value };
  if (typeof value === 'boolean') return { BOOL: value };
  if (typeof value === 'number' && Number.isFinite(value)) return { N: String(value) };
  if (Array.isArray(value)) return { L: value.map(toAttribute) };
  if (typeof value === 'object') return { M: toItem(value) };
  throw new TypeError(`A value of type ${typeof value} cannot be stored`);
}

function toItem(record) {
  const item = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) item[key] = toAttribute(value);
  }
  return item;
}

function fromAttribute(attribute) {
  if (attribute === null || typeof attribute !== 'object') return null;
  if (typeof attribute.S === 'string') return attribute.S;
  if (typeof attribute.N === 'string') return Number(attribute.N);
  if (typeof attribute.BOOL === 'boolean') return attribute.BOOL;
  if (attribute.M !== undefined && attribute.M !== null) return fromItem(attribute.M);
  if (Array.isArray(attribute.L)) return attribute.L.map(fromAttribute);
  return null;
}

function fromItem(item) {
  return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, fromAttribute(value)]));
}

function required(env, name) {
  const value = env?.[name];
  if (typeof value !== 'string' || value === '') throw new Error(`Environment variable ${name} is missing`);
  return value;
}

/**
 * @param {Record<string, string|undefined>} env  the Lambda environment
 * @returns the adapter described at the top of this file
 */
export function createAws(env) {
  const region = required(env, 'AWS_REGION');
  const stateTable = required(env, 'STATE_TABLE');
  const auditTable = required(env, 'AUDIT_TABLE');
  const bucket = required(env, 'FIRMWARE_BUCKET');
  const thingGroup = required(env, 'THING_GROUP');
  const presignRoleArn = required(env, 'PRESIGN_ROLE_ARN');
  const userPoolId = required(env, 'USER_POOL_ID');

  // Job targets are thing ARNs. The partition and the account are those of the presign
  // role, which the stack creates next to everything else.
  const role = /^arn:([a-z0-9-]+):iam::(\d{12}):role\//.exec(presignRoleArn);
  if (!role) throw new Error('Environment variable PRESIGN_ROLE_ARN is not a role ARN');
  const thingArn = (thing) => `arn:${role[1]}:iot:${region}:${role[2]}:thing/${thing}`;

  const iot = new IoTClient({ region });
  const iotData = new IoTDataPlaneClient({ region });
  const s3 = new S3Client({ region });
  const dynamo = new DynamoDBClient({ region });
  const cognito = new CognitoIdentityProviderClient({ region });

  /** Query one partition, highest sort key first, up to `limit` items. */
  async function queryDescending(table, pk, { before = null, limit = Infinity } = {}) {
    const items = [];
    let start;
    for (let pages = 0; pages < MAX_PAGES; pages += 1) {
      const input = {
        TableName: table,
        KeyConditionExpression: before === null ? '#pk = :pk' : '#pk = :pk AND #sk < :before',
        ExpressionAttributeNames: before === null ? { '#pk': 'pk' } : { '#pk': 'pk', '#sk': 'sk' },
        ExpressionAttributeValues: before === null
          ? { ':pk': { S: pk } }
          : { ':pk': { S: pk }, ':before': { S: before } },
        ScanIndexForward: false,
        ConsistentRead: true,
        ExclusiveStartKey: start,
      };
      if (Number.isFinite(limit)) input.Limit = limit - items.length;
      const out = await dynamo.send(new QueryCommand(input));
      for (const item of out.Items ?? []) items.push(fromItem(item));
      if (items.length >= limit) return items.slice(0, limit);
      if (out.LastEvaluatedKey === undefined || out.LastEvaluatedKey === null) return items;
      start = out.LastEvaluatedKey;
    }
    throw new Error(`more than ${MAX_PAGES} pages`);
  }

  async function highestRegistered() {
    const out = await dynamo.send(new GetItemCommand({
      TableName: stateTable, Key: POINTER_KEY, ConsistentRead: true,
    }));
    const highest = out.Item?.highest?.S;
    return typeof highest === 'string' ? highest : null;
  }

  return Object.freeze({
    async listGroupThings() {
      try {
        return await everyPage('ListThingsInThingGroup', async (nextToken) => {
          const out = await iot.send(new ListThingsInThingGroupCommand({
            thingGroupName: thingGroup, maxResults: PAGE_SIZE, nextToken,
          }));
          return { items: (out.things ?? []).filter((name) => typeof name === 'string'), next: out.nextToken };
        });
      } catch (cause) {
        throw nameOf(cause) === 'AwsError' ? cause : failure('ListThingsInThingGroup', cause);
      }
    },

    async listThingPrincipals(thing) {
      try {
        return await everyPage('ListThingPrincipals', async (nextToken) => {
          const out = await iot.send(new ListThingPrincipalsCommand({
            thingName: thing, maxResults: PAGE_SIZE, nextToken,
          }));
          return { items: (out.principals ?? []).filter((arn) => typeof arn === 'string'), next: out.nextToken };
        });
      } catch (cause) {
        if (nameOf(cause) === 'ResourceNotFoundException') return [];
        throw nameOf(cause) === 'AwsError' ? cause : failure('ListThingPrincipals', cause);
      }
    },

    async getShadow(thing) {
      let payload;
      try {
        ({ payload } = await iotData.send(new GetThingShadowCommand({ thingName: thing })));
      } catch (cause) {
        // 404: the thing has never reported, so there is no shadow.
        if (nameOf(cause) === 'ResourceNotFoundException' || statusOf(cause) === 404) return null;
        throw failure('GetThingShadow', cause);
      }
      try {
        // The payload is the document as bytes.
        return JSON.parse(Buffer.from(payload ?? []).toString('utf8'));
      } catch (cause) {
        throw failure('GetThingShadow', cause, 'failed');
      }
    },

    async listJobs() {
      try {
        return await everyPage('ListJobs', async (nextToken) => {
          const out = await iot.send(new ListJobsCommand({ maxResults: PAGE_SIZE, nextToken }));
          const items = (out.jobs ?? [])
            .filter((job) => typeof job?.jobId === 'string')
            .map((job) => ({
              jobId: job.jobId,
              status: typeof job.status === 'string' ? job.status : null,
              createdAt: millis(job.createdAt),
              lastUpdatedAt: millis(job.lastUpdatedAt),
              completedAt: millis(job.completedAt),
            }));
          return { items, next: out.nextToken };
        });
      } catch (cause) {
        throw nameOf(cause) === 'AwsError' ? cause : failure('ListJobs', cause);
      }
    },

    async describeJob(jobId) {
      let job;
      try {
        ({ job } = await iot.send(new DescribeJobCommand({ jobId })));
      } catch (cause) {
        if (nameOf(cause) === 'ResourceNotFoundException') return null;
        throw failure('DescribeJob', cause);
      }
      if (job === undefined || job === null) return null;
      const progress = job.jobProcessDetails ?? {};
      return {
        jobId: typeof job.jobId === 'string' ? job.jobId : jobId,
        status: typeof job.status === 'string' ? job.status : null,
        description: typeof job.description === 'string' ? job.description : '',
        things: (job.targets ?? []).map(thingOfArn).filter((name) => name !== null),
        createdAt: millis(job.createdAt),
        lastUpdatedAt: millis(job.lastUpdatedAt),
        completedAt: millis(job.completedAt),
        forceCanceled: job.forceCanceled === true,
        reasonCode: typeof job.reasonCode === 'string' ? job.reasonCode : null,
        counts: {
          queued: count(progress.numberOfQueuedThings),
          inProgress: count(progress.numberOfInProgressThings),
          succeeded: count(progress.numberOfSucceededThings),
          failed: count(progress.numberOfFailedThings),
          rejected: count(progress.numberOfRejectedThings),
          canceled: count(progress.numberOfCanceledThings),
          timedOut: count(progress.numberOfTimedOutThings),
          removed: count(progress.numberOfRemovedThings),
        },
      };
    },

    async listJobExecutionsForJob(jobId) {
      try {
        return await everyPage('ListJobExecutionsForJob', async (nextToken) => {
          const out = await iot.send(new ListJobExecutionsForJobCommand({
            jobId, maxResults: PAGE_SIZE, nextToken,
          }));
          const items = [];
          for (const entry of out.executionSummaries ?? []) {
            const thing = thingOfArn(entry?.thingArn);
            if (thing !== null) items.push({ thing, ...executionSummary(entry.jobExecutionSummary) });
          }
          return { items, next: out.nextToken };
        });
      } catch (cause) {
        if (nameOf(cause) === 'ResourceNotFoundException') return [];
        throw nameOf(cause) === 'AwsError' ? cause : failure('ListJobExecutionsForJob', cause);
      }
    },

    async describeJobExecution(jobId, thing) {
      let execution;
      try {
        ({ execution } = await iot.send(new DescribeJobExecutionCommand({ jobId, thingName: thing })));
      } catch (cause) {
        if (nameOf(cause) === 'ResourceNotFoundException') return null;
        throw failure('DescribeJobExecution', cause);
      }
      if (execution === undefined || execution === null) return null;
      // What the board wrote lives one level down, in statusDetails.detailsMap.
      const statusDetails = {};
      for (const [key, value] of Object.entries(execution.statusDetails?.detailsMap ?? {})) {
        if (typeof value === 'string') statusDetails[key] = value;
      }
      const secondsLeft = execution.approximateSecondsBeforeTimedOut;
      return {
        thing,
        ...executionSummary(execution),
        statusDetails,
        secondsLeft: Number.isFinite(secondsLeft) ? secondsLeft : null,
        forceCanceled: execution.forceCanceled === true,
      };
    },

    async listJobExecutionsForThing(thing) {
      try {
        return await everyPage('ListJobExecutionsForThing', async (nextToken) => {
          const out = await iot.send(new ListJobExecutionsForThingCommand({
            thingName: thing, maxResults: PAGE_SIZE, nextToken,
          }));
          const items = [];
          for (const entry of out.executionSummaries ?? []) {
            if (typeof entry?.jobId === 'string') {
              items.push({ jobId: entry.jobId, ...executionSummary(entry.jobExecutionSummary) });
            }
          }
          return { items, next: out.nextToken };
        });
      } catch (cause) {
        if (nameOf(cause) === 'ResourceNotFoundException') return [];
        throw nameOf(cause) === 'AwsError' ? cause : failure('ListJobExecutionsForThing', cause);
      }
    },

    async createJob({ jobId, things, document, description, urlExpiresInSec, inProgressTimeoutMinutes }) {
      try {
        await iot.send(new CreateJobCommand({
          jobId,
          targets: things.map(thingArn),
          targetSelection: 'SNAPSHOT',
          document,
          description,
          presignedUrlConfig: { roleArn: presignRoleArn, expiresInSec: urlExpiresInSec },
          timeoutConfig: { inProgressTimeoutInMinutes: inProgressTimeoutMinutes },
        }));
        return { ok: true };
      } catch (cause) {
        if (nameOf(cause) === 'ResourceAlreadyExistsException') return { ok: false, reason: 'exists' };
        if (nameOf(cause) === 'ResourceNotFoundException') return { ok: false, reason: 'target_not_found' };
        throw failure('CreateJob', cause);
      }
    },

    async cancelJob({ jobId, force, reasonCode, comment }) {
      try {
        await iot.send(new CancelJobCommand({ jobId, force: force === true, reasonCode, comment }));
        return { ok: true };
      } catch (cause) {
        if (nameOf(cause) === 'ResourceNotFoundException') return { ok: false, reason: 'not_found' };
        // The request itself is built from checked values, so a refusal is about the
        // state of the job: it is over, or being deleted.
        if (nameOf(cause) === 'InvalidRequestException' || nameOf(cause) === 'InvalidStateTransitionException') {
          return { ok: false, reason: 'refused', detail: String(cause?.message ?? '').slice(0, 200) };
        }
        throw failure('CancelJob', cause);
      }
    },

    async putFirmwareObject({ key, body, sha256Base64 }) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await s3.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: 'application/octet-stream',
            // S3 checks the bytes it received against this digest before it stores them.
            ChecksumSHA256: sha256Base64,
            // Write once: refuse if the key exists. The bucket policy demands this header.
            IfNoneMatch: '*',
          }));
          return { stored: true };
        } catch (cause) {
          if (statusOf(cause) === 412 || nameOf(cause) === 'PreconditionFailed') {
            return { stored: false, reason: 'exists' };
          }
          // 409: another write to the same key was in flight. S3 says to try again.
          const raced = statusOf(cause) === 409 || nameOf(cause) === 'ConditionalRequestConflict';
          if (!raced || attempt >= 2) throw failure('PutObject', cause);
          await sleep(100 * (attempt + 1));
        }
      }
    },

    async tagFirmwareRevoked(key) {
      try {
        await s3.send(new PutObjectTaggingCommand({
          Bucket: bucket,
          Key: key,
          ChecksumAlgorithm: 'SHA256',
          Tagging: { TagSet: [{ Key: 'revoked', Value: 'true' }] },
        }));
        return { ok: true };
      } catch (cause) {
        if (nameOf(cause) === 'NoSuchKey' || statusOf(cause) === 404) return { ok: false, reason: 'not_found' };
        throw failure('PutObjectTagging', cause);
      }
    },

    async getRelease(sk) {
      try {
        const out = await dynamo.send(new GetItemCommand({
          TableName: stateTable, Key: { pk: { S: RELEASE_PK }, sk: { S: sk } }, ConsistentRead: true,
        }));
        return out.Item === undefined || out.Item === null ? null : fromItem(out.Item);
      } catch (cause) {
        throw failure('GetItem', cause);
      }
    },

    async listReleases() {
      try {
        return await queryDescending(stateTable, RELEASE_PK);
      } catch (cause) {
        throw failure('Query', cause);
      }
    },

    async registerRelease({ sk, release }) {
      const item = toItem({ ...release, pk: RELEASE_PK, sk });
      try {
        await dynamo.send(new TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: stateTable,
                Item: item,
                ConditionExpression: 'attribute_not_exists(#pk)',
                ExpressionAttributeNames: { '#pk': 'pk' },
              },
            },
            {
              Update: {
                TableName: stateTable,
                Key: POINTER_KEY,
                UpdateExpression: 'SET #highest = :sk',
                ConditionExpression: 'attribute_not_exists(#highest) OR #highest < :sk',
                ExpressionAttributeNames: { '#highest': 'highest' },
                ExpressionAttributeValues: { ':sk': { S: sk } },
                ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
              },
            },
          ],
        }));
        return { ok: true };
      } catch (cause) {
        if (nameOf(cause) !== 'TransactionCanceledException') throw failure('TransactWriteItems', cause);
        // One reason per item of the request, in the same order.
        const reasons = Array.isArray(cause.CancellationReasons) ? cause.CancellationReasons : [];
        const [put, pointer] = reasons;
        if (put?.Code === 'ConditionalCheckFailed') return { ok: false, reason: 'exists' };
        if (pointer?.Code === 'ConditionalCheckFailed') {
          let highest = pointer.Item?.highest?.S;
          if (typeof highest !== 'string') {
            try {
              highest = await highestRegistered();
            } catch {
              highest = null;
            }
          }
          return { ok: false, reason: 'not_newer', highest };
        }
        if (reasons.some((reason) => reason?.Code === 'TransactionConflict')) {
          return { ok: false, reason: 'conflict' };
        }
        const throttled = reasons.some((reason) =>
          reason?.Code === 'ThrottlingError' || reason?.Code === 'ProvisionedThroughputExceeded');
        throw failure('TransactWriteItems', cause, throttled ? 'throttled' : 'failed');
      }
    },

    async markReleaseRevoked({ sk, revoked }) {
      const info = toAttribute(revoked);
      try {
        const out = await dynamo.send(new UpdateItemCommand({
          TableName: stateTable,
          Key: { pk: { S: RELEASE_PK }, sk: { S: sk } },
          UpdateExpression: 'SET #status = :revoked, #revoked = :info',
          // False for an item that does not exist, too.
          ConditionExpression: '#status = :active',
          ExpressionAttributeNames: { '#status': 'status', '#revoked': 'revoked' },
          ExpressionAttributeValues: { ':active': { S: 'active' }, ':revoked': { S: 'revoked' }, ':info': info },
          ReturnValues: 'ALL_NEW',
        }));
        return { ok: true, release: out.Attributes ? fromItem(out.Attributes) : null };
      } catch (cause) {
        if (nameOf(cause) === 'ConditionalCheckFailedException') return { ok: false, reason: 'not_active' };
        throw failure('UpdateItem', cause);
      }
    },

    async putAudit(item) {
      const stored = toItem({ ...item, pk: AUDIT_PK });
      try {
        await dynamo.send(new PutItemCommand({
          TableName: auditTable,
          Item: stored,
          ConditionExpression: 'attribute_not_exists(#pk)',
          ExpressionAttributeNames: { '#pk': 'pk' },
        }));
        return { ok: true };
      } catch (cause) {
        if (nameOf(cause) === 'ConditionalCheckFailedException') return { ok: false, reason: 'exists' };
        throw failure('PutItem', cause);
      }
    },

    async queryAudit({ before, limit }) {
      try {
        return await queryDescending(auditTable, AUDIT_PK, { before: before ?? null, limit });
      } catch (cause) {
        throw failure('Query', cause);
      }
    },

    async getUser(sub) {
      try {
        const out = await cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: sub }));
        const email = (out.UserAttributes ?? []).find((attribute) => attribute?.Name === 'email')?.Value;
        return {
          enabled: out.Enabled === true,
          status: typeof out.UserStatus === 'string' ? out.UserStatus : '',
          email: typeof email === 'string' ? email : '',
        };
      } catch (cause) {
        if (nameOf(cause) === 'UserNotFoundException') return null;
        throw failure('AdminGetUser', cause);
      }
    },

    async listUserGroups(sub) {
      try {
        return await everyPage('AdminListGroupsForUser', async (NextToken) => {
          const out = await cognito.send(new AdminListGroupsForUserCommand({
            UserPoolId: userPoolId, Username: sub, Limit: GROUP_PAGE_SIZE, NextToken,
          }));
          const items = (out.Groups ?? []).map((group) => group?.GroupName)
            .filter((name) => typeof name === 'string');
          return { items, next: out.NextToken };
        });
      } catch (cause) {
        if (nameOf(cause) === 'UserNotFoundException') return [];
        throw nameOf(cause) === 'AwsError' ? cause : failure('AdminListGroupsForUser', cause);
      }
    },
  });
}
