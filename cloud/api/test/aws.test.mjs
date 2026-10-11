// Tests for the AWS adapter (src/aws.mjs).
//
// The AWS SDK is not installed where these tests run: the Lambda runtime provides it.
// So that the adapter can be executed anyway, the five SDK packages it imports are
// replaced here, through a module loader hook, by stand-ins that record every command
// and answer with replies the test prepared. The stand-ins also hold the adapter to the
// SDK's reference: REFERENCE below lists, for every command the adapter may send, the
// input members of the AWS SDK for JavaScript v3 (taken from the command sources of
// version 3.1149.0). A command that is not listed, a member that does not exist, or a
// missing required member fails the test.
//
// What these tests cannot show is that AWS behaves as the replies assume. That is what
// the first deployment's smoke test is for.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { register } from 'node:module';
import { test } from 'node:test';

import { accessClaims, apiEvent, createFakeAws, fakeEnv } from './fake-aws.mjs';

const REFERENCE = {
  '@aws-sdk/client-cognito-identity-provider': {
    client: 'CognitoIdentityProviderClient',
    commands: {
      AdminGetUserCommand: {
        required: ['UserPoolId', 'Username'],
        optional: [],
      },
      AdminListGroupsForUserCommand: {
        required: ['Username', 'UserPoolId'],
        optional: [
          'Limit', 'NextToken',
        ],
      },
    },
  },
  '@aws-sdk/client-dynamodb': {
    client: 'DynamoDBClient',
    commands: {
      GetItemCommand: {
        required: ['TableName', 'Key'],
        optional: [
          'AttributesToGet', 'ConsistentRead', 'ReturnConsumedCapacity', 'ProjectionExpression',
          'ExpressionAttributeNames',
        ],
      },
      PutItemCommand: {
        required: ['TableName', 'Item'],
        optional: [
          'Expected', 'ReturnValues', 'ReturnConsumedCapacity', 'ReturnItemCollectionMetrics',
          'ConditionalOperator', 'ConditionExpression', 'ExpressionAttributeNames',
          'ExpressionAttributeValues', 'ReturnValuesOnConditionCheckFailure',
        ],
      },
      QueryCommand: {
        required: ['TableName'],
        optional: [
          'IndexName', 'Select', 'AttributesToGet', 'Limit', 'ConsistentRead', 'KeyConditions',
          'QueryFilter', 'ConditionalOperator', 'ScanIndexForward', 'ExclusiveStartKey',
          'ReturnConsumedCapacity', 'ProjectionExpression', 'FilterExpression', 'KeyConditionExpression',
          'ExpressionAttributeNames', 'ExpressionAttributeValues',
        ],
      },
      TransactWriteItemsCommand: {
        required: ['TransactItems'],
        optional: [
          'ReturnConsumedCapacity', 'ReturnItemCollectionMetrics', 'ClientRequestToken',
        ],
      },
      UpdateItemCommand: {
        required: ['TableName', 'Key'],
        optional: [
          'AttributeUpdates', 'Expected', 'ConditionalOperator', 'ReturnValues', 'ReturnConsumedCapacity',
          'ReturnItemCollectionMetrics', 'UpdateExpression', 'ConditionExpression',
          'ExpressionAttributeNames', 'ExpressionAttributeValues', 'ReturnValuesOnConditionCheckFailure',
        ],
      },
    },
  },
  '@aws-sdk/client-iot': {
    client: 'IoTClient',
    commands: {
      CancelJobCommand: {
        required: ['jobId'],
        optional: [
          'reasonCode', 'comment', 'force',
        ],
      },
      CreateJobCommand: {
        required: ['jobId', 'targets'],
        optional: [
          'documentSource', 'document', 'description', 'presignedUrlConfig', 'targetSelection',
          'jobExecutionsRolloutConfig', 'abortConfig', 'timeoutConfig', 'tags', 'namespaceId',
          'jobTemplateArn', 'jobExecutionsRetryConfig', 'documentParameters', 'schedulingConfig',
          'destinationPackageVersions',
        ],
      },
      DescribeJobCommand: {
        required: ['jobId'],
        optional: [
          'beforeSubstitution',
        ],
      },
      DescribeJobExecutionCommand: {
        required: ['jobId', 'thingName'],
        optional: [
          'executionNumber',
        ],
      },
      ListJobExecutionsForJobCommand: {
        required: ['jobId'],
        optional: [
          'status', 'maxResults', 'nextToken',
        ],
      },
      ListJobExecutionsForThingCommand: {
        required: ['thingName'],
        optional: [
          'status', 'namespaceId', 'maxResults', 'nextToken', 'jobId',
        ],
      },
      ListJobsCommand: {
        required: [],
        optional: [
          'status', 'targetSelection', 'maxResults', 'nextToken', 'thingGroupName', 'thingGroupId',
          'namespaceId',
        ],
      },
      ListThingPrincipalsCommand: {
        required: ['thingName'],
        optional: [
          'nextToken', 'maxResults',
        ],
      },
      ListThingsInThingGroupCommand: {
        required: ['thingGroupName'],
        optional: [
          'recursive', 'nextToken', 'maxResults',
        ],
      },
    },
  },
  '@aws-sdk/client-iot-data-plane': {
    client: 'IoTDataPlaneClient',
    commands: {
      GetThingShadowCommand: {
        required: ['thingName'],
        optional: [
          'shadowName',
        ],
      },
    },
  },
  '@aws-sdk/client-s3': {
    client: 'S3Client',
    commands: {
      PutObjectCommand: {
        required: ['Bucket', 'Key'],
        optional: [
          'ACL', 'Body', 'CacheControl', 'ContentDisposition', 'ContentEncoding', 'ContentLanguage',
          'ContentLength', 'ContentMD5', 'ContentType', 'ChecksumAlgorithm', 'ChecksumCRC32',
          'ChecksumCRC32C', 'ChecksumCRC64NVME', 'ChecksumSHA1', 'ChecksumSHA256', 'ChecksumSHA512',
          'ChecksumMD5', 'ChecksumXXHASH64', 'ChecksumXXHASH3', 'ChecksumXXHASH128', 'Expires', 'IfMatch',
          'IfNoneMatch', 'GrantFullControl', 'GrantRead', 'GrantReadACP', 'GrantWriteACP',
          'WriteOffsetBytes', 'Metadata', 'ServerSideEncryption', 'StorageClass',
          'WebsiteRedirectLocation', 'SSECustomerAlgorithm', 'SSECustomerKey', 'SSECustomerKeyMD5',
          'SSEKMSKeyId', 'SSEKMSEncryptionContext', 'BucketKeyEnabled', 'RequestPayer', 'Tagging',
          'ObjectLockMode', 'ObjectLockRetainUntilDate', 'ObjectLockLegalHoldStatus',
          'ObjectLockEventHold', 'ObjectLockEventHoldDurationDays', 'ObjectLockEventHoldDurationYears',
          'ExpectedBucketOwner',
        ],
      },
      PutObjectTaggingCommand: {
        required: ['Bucket', 'Key'],
        optional: [
          'VersionId', 'ContentMD5', 'ChecksumAlgorithm', 'Tagging', 'ExpectedBucketOwner', 'RequestPayer',
        ],
      },
    },
  },
};

const hooks = `
const REFERENCE = ${JSON.stringify(REFERENCE)};
const PREFIX = 'sdk-stand-in:';

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@aws-sdk/client-s3/package.json') {
    return { url: PREFIX + 'version', importAttributes: context.importAttributes, shortCircuit: true };
  }
  if (Object.hasOwn(REFERENCE, specifier)) {
    return { url: PREFIX + specifier, shortCircuit: true };
  }
  if (specifier.startsWith('@aws-sdk/') || specifier.startsWith('@smithy/')) {
    throw new Error('The adapter may not import ' + specifier);
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === PREFIX + 'version') {
    return { format: 'json', source: '{"version":"3.0.0-stand-in"}', shortCircuit: true };
  }
  if (url.startsWith(PREFIX)) {
    const name = url.slice(PREFIX.length);
    const { client, commands } = REFERENCE[name];
    const lines = ['const hub = globalThis[Symbol.for("cranium.sdk-stand-in")];'];
    lines.push('export class ' + client + ' {');
    lines.push('  constructor(config) { hub.constructed(' + JSON.stringify(name) + ', config); }');
    lines.push('  send(command) { return hub.send(' + JSON.stringify(name) + ', command); }');
    lines.push('}');
    for (const command of Object.keys(commands)) {
      lines.push('export class ' + command + ' { constructor(input) { this.input = input; } }');
    }
    return { format: 'module', source: lines.join('\\n'), shortCircuit: true };
  }
  return nextLoad(url, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);

/** Plain data without undefined members, as the SDK would serialize it. */
function serialized(value) {
  if (value instanceof Uint8Array || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(serialized);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, serialized(entry)]));
  }
  return value;
}

const sdk = {
  clients: [],
  sent: [],
  replies: new Map(),

  reset() {
    this.sent.length = 0;
    this.replies.clear();
  },

  /** Prepare the answers to the next calls of a command: values, or functions of the input. */
  reply(command, ...answers) {
    const queue = this.replies.get(command) ?? [];
    queue.push(...answers);
    this.replies.set(command, queue);
  },

  inputs(command) {
    return this.sent.filter((entry) => entry.command === command).map((entry) => entry.input);
  },
};

globalThis[Symbol.for('cranium.sdk-stand-in')] = {
  constructed(name, config) {
    sdk.clients.push({ package: name, config });
  },
  async send(name, command) {
    const commandName = command.constructor.name;
    const spec = REFERENCE[name].commands[commandName];
    assert.ok(spec, `${commandName} is not a command of ${name} in the reference`);
    const input = serialized(command.input);
    for (const member of Object.keys(input)) {
      assert.ok(spec.required.includes(member) || spec.optional.includes(member),
        `${commandName} has no input member "${member}"`);
    }
    for (const member of spec.required) {
      assert.ok(Object.hasOwn(input, member), `${commandName} needs "${member}"`);
    }
    sdk.sent.push({ package: name, command: commandName, input });
    const queue = sdk.replies.get(commandName) ?? [];
    assert.ok(queue.length > 0, `No reply prepared for ${commandName}`);
    const answer = queue.shift();
    return typeof answer === 'function' ? answer(input) : answer;
  },
};

/** An exception as the SDK throws it. */
function sdkError(name, { status = 400, message = `${name} from the service`, ...extra } = {}) {
  const error = new Error(message);
  error.name = name;
  error.$fault = status >= 500 ? 'server' : 'client';
  error.$metadata = { httpStatusCode: status, requestId: 'SDK-REQUEST-ID', attempts: 1 };
  Object.assign(error, extra);
  return error;
}

const fails = (name, options) => () => {
  throw sdkError(name, options);
};

const ENV = Object.freeze({
  AWS_REGION: 'eu-west-1',
  STATE_TABLE: 'state-table',
  AUDIT_TABLE: 'audit-table',
  FIRMWARE_BUCKET: 'firmware-bucket',
  THING_GROUP: 'cranium-devices',
  PRESIGN_ROLE_ARN: 'arn:aws:iam::000000000000:role/presign-role',
  USER_POOL_ID: 'eu-west-1_Pool',
});

const THING = 'cranium-00000000000000aa';
const THING_ARN = `arn:aws:iot:eu-west-1:000000000000:thing/${THING}`;
const JOB = 'cranium-1-2-3-b4-20261010T221500Z-9f3a';
const T0 = Date.UTC(2026, 9, 10, 22, 15, 0);

// The adapter logs the SDK version when it is loaded. It reads the version from the
// SDK's package.json; Node 22 before 22.12 announces that kind of import as
// experimental, which says nothing about the code under test.
const startup = [];
const realLog = console.log;
const realWarning = process.emitWarning;
console.log = (line) => startup.push(line);
process.emitWarning = (warning, ...rest) => {
  if (!String(warning).includes('Importing JSON modules')) realWarning.call(process, warning, ...rest);
};
const { createAws } = await import('../src/aws.mjs');
console.log = realLog;
process.emitWarning = realWarning;

function adapter(env = ENV) {
  sdk.reset();
  return createAws(env);
}

/** Expect a rejection with the adapter's own error, never the SDK's. */
async function rejectsWith(promise, { code, operation, awsError }) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, 'AwsError');
    assert.equal(Object.getPrototypeOf(error), Error.prototype);
    assert.equal(error.code, code);
    assert.equal(error.operation, operation);
    if (awsError !== undefined) assert.equal(error.awsError, awsError);
    assert.equal(error.cause, undefined);
    assert.equal(Object.hasOwn(error, '$metadata'), false);
    return true;
  });
}

test('the SDK version is logged once when the module is loaded', () => {
  assert.equal(startup.length, 1);
  const line = JSON.parse(startup[0]);
  assert.deepEqual(Object.keys(line), ['event', 'sdkVersion', 'node']);
  assert.equal(line.event, 'cold_start');
  assert.equal(line.sdkVersion, '3.0.0-stand-in');
  assert.equal(line.node, process.version);
});

test('one client per service is created for the function\'s region', () => {
  sdk.clients.length = 0;
  createAws(ENV);
  assert.deepEqual(sdk.clients.map((client) => client.package).sort(), Object.keys(REFERENCE).sort());
  for (const client of sdk.clients) assert.deepEqual(client.config, { region: 'eu-west-1' });

  for (const name of Object.keys(ENV)) {
    assert.throws(() => createAws({ ...ENV, [name]: undefined }), new RegExp(name));
    assert.throws(() => createAws({ ...ENV, [name]: '' }), new RegExp(name));
  }
  assert.throws(() => createAws({ ...ENV, PRESIGN_ROLE_ARN: 'presign-role' }), /PRESIGN_ROLE_ARN/);
  assert.throws(() => createAws(undefined), /AWS_REGION/);
  assert.equal(Object.isFrozen(createAws(ENV)), true);
});

test('the adapter and the in-memory fake have the same methods', () => {
  const real = createAws(ENV);
  const fake = createFakeAws();
  const methods = Object.keys(real).sort();
  assert.deepEqual(methods, [
    'cancelJob', 'createJob', 'describeJob', 'describeJobExecution', 'getRelease', 'getShadow', 'getUser',
    'highestReleaseKey', 'listGroupThings', 'listJobExecutionsForJob', 'listJobExecutionsForThing', 'listJobs', 'listReleases',
    'listThingPrincipals', 'listUserGroups', 'markReleaseRevoked', 'putAudit', 'putFirmwareObject',
    'queryAudit', 'registerRelease', 'tagFirmwareRevoked',
  ]);
  for (const method of methods) {
    assert.equal(typeof real[method], 'function');
    assert.equal(typeof fake[method], 'function', `the fake lacks ${method}`);
  }
});

test('listGroupThings reads every page of the group', async () => {
  const aws = adapter();
  sdk.reply('ListThingsInThingGroupCommand',
    { things: ['cranium-00000000000000bb', THING], nextToken: 'page-2' },
    { things: ['cranium-00000000000000cc'], nextToken: 'page-3' },
    { things: [] });
  assert.deepEqual(await aws.listGroupThings(), ['cranium-00000000000000bb', THING, 'cranium-00000000000000cc']);
  assert.deepEqual(sdk.inputs('ListThingsInThingGroupCommand'), [
    { thingGroupName: 'cranium-devices', maxResults: 250 },
    { thingGroupName: 'cranium-devices', maxResults: 250, nextToken: 'page-2' },
    { thingGroupName: 'cranium-devices', maxResults: 250, nextToken: 'page-3' },
  ]);
  assert.equal(sdk.sent[0].package, '@aws-sdk/client-iot');

  sdk.reset();
  sdk.reply('ListThingsInThingGroupCommand', {});
  assert.deepEqual(await aws.listGroupThings(), []);
});

test('a list that never ends is given up on', async () => {
  const aws = adapter();
  let pages = 0;
  const endless = () => {
    pages += 1;
    return { things: [`thing-${pages}`], nextToken: `page-${pages + 1}` };
  };
  sdk.reply('ListThingsInThingGroupCommand', ...Array.from({ length: 60 }, () => endless));
  await rejectsWith(aws.listGroupThings(), { code: 'failed', operation: 'ListThingsInThingGroup' });
  assert.equal(pages, 40);
});

test('failures are reported as plain errors, throttling marked as such', async () => {
  const aws = adapter();
  sdk.reply('ListThingsInThingGroupCommand', fails('ResourceNotFoundException', { status: 404 }));
  await rejectsWith(aws.listGroupThings(),
    { code: 'failed', operation: 'ListThingsInThingGroup', awsError: 'ResourceNotFoundException' });

  sdk.reply('ListThingsInThingGroupCommand', fails('InternalFailureException', { status: 500 }));
  await assert.rejects(aws.listGroupThings(), (error) => {
    assert.equal(error.code, 'failed');
    assert.equal(error.awsStatus, 500);
    assert.match(error.message, /^ListThingsInThingGroup: InternalFailureException: /);
    return true;
  });

  // The ways AWS says "slow down": by name (IoT answers 400), by status, by the SDK's mark.
  const slow = [
    ['ThrottlingException', { status: 400 }],
    ['TooManyRequestsException', { status: 400 }],
    ['ProvisionedThroughputExceededException', { status: 400 }],
    ['RequestLimitExceeded', { status: 400 }],
    ['SlowDown', { status: 503 }],
    ['SomethingElse', { status: 429 }],
    ['SomethingElse', { status: 400, $retryable: { throttling: true } }],
  ];
  for (const [name, options] of slow) {
    sdk.reply('ListJobsCommand', fails(name, options));
    await rejectsWith(aws.listJobs(), { code: 'throttled', operation: 'ListJobs', awsError: name });
  }
  // A quota is not a rate limit.
  sdk.reply('ListJobsCommand', fails('LimitExceededException', { status: 410 }));
  await rejectsWith(aws.listJobs(), { code: 'failed', operation: 'ListJobs' });

  // Things that are not SDK exceptions at all.
  for (const thrown of [new TypeError('fetch failed'), 'a string', null, undefined, { odd: true }]) {
    sdk.reply('ListJobsCommand', () => {
      throw thrown;
    });
    await rejectsWith(aws.listJobs(), { code: 'failed', operation: 'ListJobs' });
  }
});

test('listThingPrincipals returns the ARNs, or nothing for an unknown thing', async () => {
  const aws = adapter();
  sdk.reply('ListThingPrincipalsCommand',
    { principals: ['arn:aws:iot:eu-west-1:000000000000:cert/aa'], nextToken: 'next' },
    { principals: ['arn:aws:iot:eu-west-1:000000000000:cert/bb'] });
  assert.deepEqual(await aws.listThingPrincipals(THING),
    ['arn:aws:iot:eu-west-1:000000000000:cert/aa', 'arn:aws:iot:eu-west-1:000000000000:cert/bb']);
  assert.deepEqual(sdk.inputs('ListThingPrincipalsCommand'), [
    { thingName: THING, maxResults: 250 },
    { thingName: THING, maxResults: 250, nextToken: 'next' },
  ]);

  sdk.reply('ListThingPrincipalsCommand', fails('ResourceNotFoundException', { status: 404 }));
  assert.deepEqual(await aws.listThingPrincipals(THING), []);
  sdk.reply('ListThingPrincipalsCommand', fails('UnauthorizedException', { status: 401 }));
  await rejectsWith(aws.listThingPrincipals(THING), { code: 'failed', operation: 'ListThingPrincipals' });
});

test('getShadow parses the payload bytes and maps 404 to no shadow', async () => {
  const aws = adapter();
  const document = {
    state: { reported: { fw: { version: '1.0.0+3', confirmed: true }, uptime: 12, note: 'grüße' } },
    metadata: { reported: { uptime: { timestamp: 1790000000 } } },
    version: 7,
    timestamp: 1790000001,
  };
  // The SDK hands the payload over as a Uint8Array.
  sdk.reply('GetThingShadowCommand', { payload: new TextEncoder().encode(JSON.stringify(document)) });
  assert.deepEqual(await aws.getShadow(THING), document);
  // The classic shadow: no shadow name. The data plane client, not the control plane.
  assert.deepEqual(sdk.inputs('GetThingShadowCommand'), [{ thingName: THING }]);
  assert.equal(sdk.sent[0].package, '@aws-sdk/client-iot-data-plane');

  sdk.reply('GetThingShadowCommand', { payload: Buffer.from(JSON.stringify(document)) });
  assert.deepEqual(await aws.getShadow(THING), document);

  sdk.reply('GetThingShadowCommand', fails('ResourceNotFoundException', { status: 404 }));
  assert.equal(await aws.getShadow(THING), null);
  sdk.reply('GetThingShadowCommand', fails('UnknownError', { status: 404 }));
  assert.equal(await aws.getShadow(THING), null);

  for (const [name, status, code] of [['ThrottlingException', 429, 'throttled'], ['InternalFailureException', 500, 'failed'],
    ['UnauthorizedException', 401, 'failed'], ['ServiceUnavailableException', 503, 'failed']]) {
    sdk.reply('GetThingShadowCommand', fails(name, { status }));
    await rejectsWith(aws.getShadow(THING), { code, operation: 'GetThingShadow', awsError: name });
  }
  for (const payload of [new TextEncoder().encode('{not json'), new Uint8Array(), undefined]) {
    sdk.reply('GetThingShadowCommand', { payload });
    await rejectsWith(aws.getShadow(THING), { code: 'failed', operation: 'GetThingShadow' });
  }
});

test('listJobs returns plain summaries with times in milliseconds', async () => {
  const aws = adapter();
  sdk.reply('ListJobsCommand',
    {
      jobs: [
        {
          jobArn: `arn:aws:iot:eu-west-1:000000000000:job/${JOB}`, jobId: JOB, targetSelection: 'SNAPSHOT',
          status: 'IN_PROGRESS', createdAt: new Date(T0), lastUpdatedAt: new Date(T0 + 1500), isConcurrent: false,
        },
      ],
      nextToken: 'more',
    },
    {
      jobs: [
        { jobId: 'factory-test-7', status: 'COMPLETED', createdAt: new Date(T0 - 5000),
          lastUpdatedAt: new Date(T0 - 1000), completedAt: new Date(T0 - 1000) },
        { status: 'CANCELED' },
      ],
    });
  assert.deepEqual(await aws.listJobs(), [
    { jobId: JOB, status: 'IN_PROGRESS', createdAt: T0, lastUpdatedAt: T0 + 1500, completedAt: null },
    { jobId: 'factory-test-7', status: 'COMPLETED', createdAt: T0 - 5000, lastUpdatedAt: T0 - 1000, completedAt: T0 - 1000 },
  ]);
  assert.deepEqual(sdk.inputs('ListJobsCommand'), [{ maxResults: 250 }, { maxResults: 250, nextToken: 'more' }]);
});

test('describeJob reduces a job to what the console needs', async () => {
  const aws = adapter();
  sdk.reply('DescribeJobCommand', {
    documentSource: undefined,
    job: {
      jobArn: `arn:aws:iot:eu-west-1:000000000000:job/${JOB}`,
      jobId: JOB,
      targetSelection: 'SNAPSHOT',
      status: 'CANCELED',
      forceCanceled: true,
      reasonCode: 'CONSOLE_CANCEL',
      comment: 'who',
      targets: [THING_ARN, 'arn:aws:iot:eu-west-1:000000000000:thinggroup/some-group',
        'arn:aws:iot:eu-west-1:000000000000:thing/cranium-00000000000000bb'],
      description: '{"by":"x","sub":"y","note":""}',
      presignedUrlConfig: { roleArn: ENV.PRESIGN_ROLE_ARN, expiresInSec: 600 },
      createdAt: new Date(T0),
      lastUpdatedAt: new Date(T0 + 9000),
      jobProcessDetails: {
        numberOfCanceledThings: 1, numberOfSucceededThings: 2, numberOfFailedThings: 3, numberOfRejectedThings: 4,
        numberOfQueuedThings: 5, numberOfInProgressThings: 6, numberOfRemovedThings: 7, numberOfTimedOutThings: 8,
      },
      timeoutConfig: { inProgressTimeoutInMinutes: 30 },
    },
  });
  assert.deepEqual(await aws.describeJob(JOB), {
    jobId: JOB,
    status: 'CANCELED',
    description: '{"by":"x","sub":"y","note":""}',
    things: [THING, 'cranium-00000000000000bb'],
    createdAt: T0,
    lastUpdatedAt: T0 + 9000,
    completedAt: null,
    forceCanceled: true,
    reasonCode: 'CONSOLE_CANCEL',
    counts: { queued: 5, inProgress: 6, succeeded: 2, failed: 3, rejected: 4, canceled: 1, timedOut: 8, removed: 7 },
  });
  assert.deepEqual(sdk.inputs('DescribeJobCommand'), [{ jobId: JOB }]);

  // A job that has just been created: no counts yet, nothing optional.
  sdk.reply('DescribeJobCommand', { job: { jobId: JOB, status: 'IN_PROGRESS', createdAt: new Date(T0) } });
  assert.deepEqual(await aws.describeJob(JOB), {
    jobId: JOB, status: 'IN_PROGRESS', description: '', things: [], createdAt: T0, lastUpdatedAt: null,
    completedAt: null, forceCanceled: false, reasonCode: null,
    counts: { queued: 0, inProgress: 0, succeeded: 0, failed: 0, rejected: 0, canceled: 0, timedOut: 0, removed: 0 },
  });

  sdk.reply('DescribeJobCommand', fails('ResourceNotFoundException', { status: 404 }));
  assert.equal(await aws.describeJob(JOB), null);
  sdk.reply('DescribeJobCommand', {});
  assert.equal(await aws.describeJob(JOB), null);
  sdk.reply('DescribeJobCommand', fails('ThrottlingException'));
  await rejectsWith(aws.describeJob(JOB), { code: 'throttled', operation: 'DescribeJob' });
});

test('executions of a job are listed by thing name', async () => {
  const aws = adapter();
  sdk.reply('ListJobExecutionsForJobCommand',
    {
      executionSummaries: [
        {
          thingArn: THING_ARN,
          jobExecutionSummary: {
            status: 'IN_PROGRESS', queuedAt: new Date(T0), startedAt: new Date(T0 + 2000),
            lastUpdatedAt: new Date(T0 + 3000), executionNumber: 1, retryAttempt: 0,
          },
        },
      ],
      nextToken: 'next',
    },
    {
      executionSummaries: [
        {
          thingArn: 'arn:aws:iot:eu-west-1:000000000000:thing/cranium-00000000000000bb',
          jobExecutionSummary: { status: 'QUEUED', queuedAt: new Date(T0), lastUpdatedAt: new Date(T0), executionNumber: 1 },
        },
        { jobExecutionSummary: { status: 'QUEUED' } },
      ],
    });
  assert.deepEqual(await aws.listJobExecutionsForJob(JOB), [
    { thing: THING, status: 'IN_PROGRESS', queuedAt: T0, startedAt: T0 + 2000, lastUpdatedAt: T0 + 3000, executionNumber: 1 },
    { thing: 'cranium-00000000000000bb', status: 'QUEUED', queuedAt: T0, startedAt: null, lastUpdatedAt: T0, executionNumber: 1 },
  ]);
  assert.deepEqual(sdk.inputs('ListJobExecutionsForJobCommand'),
    [{ jobId: JOB, maxResults: 250 }, { jobId: JOB, maxResults: 250, nextToken: 'next' }]);

  sdk.reply('ListJobExecutionsForJobCommand', fails('ResourceNotFoundException', { status: 404 }));
  assert.deepEqual(await aws.listJobExecutionsForJob(JOB), []);
  sdk.reply('ListJobExecutionsForJobCommand', fails('ServiceUnavailableException', { status: 503 }));
  await rejectsWith(aws.listJobExecutionsForJob(JOB), { code: 'failed', operation: 'ListJobExecutionsForJob' });
});

test('describeJobExecution finds what the board wrote in statusDetails.detailsMap', async () => {
  const aws = adapter();
  sdk.reply('DescribeJobExecutionCommand', {
    execution: {
      jobId: JOB,
      status: 'IN_PROGRESS',
      forceCanceled: false,
      statusDetails: { detailsMap: { step: 'downloading', odd: 5, running: '1.0.0+3' } },
      thingArn: THING_ARN,
      queuedAt: new Date(T0),
      startedAt: new Date(T0 + 2000),
      lastUpdatedAt: new Date(T0 + 3000),
      executionNumber: 1,
      versionNumber: 3,
      approximateSecondsBeforeTimedOut: 1741,
    },
  });
  assert.deepEqual(await aws.describeJobExecution(JOB, THING), {
    thing: THING,
    status: 'IN_PROGRESS',
    queuedAt: T0,
    startedAt: T0 + 2000,
    lastUpdatedAt: T0 + 3000,
    executionNumber: 1,
    statusDetails: { step: 'downloading', running: '1.0.0+3' },
    secondsLeft: 1741,
    forceCanceled: false,
  });
  assert.deepEqual(sdk.inputs('DescribeJobExecutionCommand'), [{ jobId: JOB, thingName: THING }]);

  // Finished: no time left to report. Queued: no details at all.
  sdk.reply('DescribeJobExecutionCommand', {
    execution: { jobId: JOB, status: 'CANCELED', forceCanceled: true, queuedAt: new Date(T0), lastUpdatedAt: new Date(T0 + 1) },
  });
  assert.deepEqual(await aws.describeJobExecution(JOB, THING), {
    thing: THING, status: 'CANCELED', queuedAt: T0, startedAt: null, lastUpdatedAt: T0 + 1, executionNumber: null,
    statusDetails: {}, secondsLeft: null, forceCanceled: true,
  });

  sdk.reply('DescribeJobExecutionCommand', fails('ResourceNotFoundException', { status: 404 }));
  assert.equal(await aws.describeJobExecution(JOB, THING), null);
  sdk.reply('DescribeJobExecutionCommand', {});
  assert.equal(await aws.describeJobExecution(JOB, THING), null);
  sdk.reply('DescribeJobExecutionCommand', fails('ThrottlingException'));
  await rejectsWith(aws.describeJobExecution(JOB, THING), { code: 'throttled', operation: 'DescribeJobExecution' });
});

test('executions of a thing are listed by job id', async () => {
  const aws = adapter();
  sdk.reply('ListJobExecutionsForThingCommand',
    {
      executionSummaries: [
        { jobId: JOB, jobExecutionSummary: { status: 'QUEUED', queuedAt: new Date(T0), lastUpdatedAt: new Date(T0), executionNumber: 4 } },
      ],
      nextToken: 'next',
    },
    {
      executionSummaries: [
        { jobId: 'factory-test-7', jobExecutionSummary: { status: 'SUCCEEDED', queuedAt: new Date(T0 - 9), startedAt: new Date(T0 - 8), lastUpdatedAt: new Date(T0 - 7), executionNumber: 1 } },
        { jobExecutionSummary: { status: 'QUEUED' } },
      ],
    });
  assert.deepEqual(await aws.listJobExecutionsForThing(THING), [
    { jobId: JOB, status: 'QUEUED', queuedAt: T0, startedAt: null, lastUpdatedAt: T0, executionNumber: 4 },
    { jobId: 'factory-test-7', status: 'SUCCEEDED', queuedAt: T0 - 9, startedAt: T0 - 8, lastUpdatedAt: T0 - 7, executionNumber: 1 },
  ]);
  assert.deepEqual(sdk.inputs('ListJobExecutionsForThingCommand'),
    [{ thingName: THING, maxResults: 250 }, { thingName: THING, maxResults: 250, nextToken: 'next' }]);

  sdk.reply('ListJobExecutionsForThingCommand', fails('ResourceNotFoundException', { status: 404 }));
  assert.deepEqual(await aws.listJobExecutionsForThing(THING), []);
});

test('createJob makes a snapshot job on thing ARNs with a presigned URL role', async () => {
  const aws = adapter();
  const input = {
    jobId: JOB,
    things: [THING, 'cranium-00000000000000bb'],
    document: '{"op":"fw_update"}',
    description: '{"by":"x","sub":"y","note":""}',
    urlExpiresInSec: 600,
    inProgressTimeoutMinutes: 30,
  };
  sdk.reply('CreateJobCommand', { jobArn: `arn:aws:iot:eu-west-1:000000000000:job/${JOB}`, jobId: JOB });
  assert.deepEqual(await aws.createJob(input), { ok: true });
  assert.deepEqual(sdk.inputs('CreateJobCommand'), [{
    jobId: JOB,
    targets: [THING_ARN, 'arn:aws:iot:eu-west-1:000000000000:thing/cranium-00000000000000bb'],
    targetSelection: 'SNAPSHOT',
    document: '{"op":"fw_update"}',
    description: '{"by":"x","sub":"y","note":""}',
    presignedUrlConfig: { roleArn: 'arn:aws:iam::000000000000:role/presign-role', expiresInSec: 600 },
    timeoutConfig: { inProgressTimeoutInMinutes: 30 },
  }]);

  sdk.reply('CreateJobCommand', fails('ResourceAlreadyExistsException', { status: 409 }));
  assert.deepEqual(await aws.createJob(input), { ok: false, reason: 'exists' });
  sdk.reply('CreateJobCommand', fails('ResourceNotFoundException', { status: 404 }));
  assert.deepEqual(await aws.createJob(input), { ok: false, reason: 'target_not_found' });
  for (const [name, code] of [['InvalidRequestException', 'failed'], ['LimitExceededException', 'failed'],
    ['ThrottlingException', 'throttled'], ['ServiceUnavailableException', 'failed'], ['AccessDeniedException', 'failed']]) {
    sdk.reply('CreateJobCommand', fails(name));
    await rejectsWith(aws.createJob(input), { code, operation: 'CreateJob', awsError: name });
  }

  // The partition and the account of the targets are those of the presign role.
  const elsewhere = adapter({ ...ENV, AWS_REGION: 'us-gov-west-1', PRESIGN_ROLE_ARN: 'arn:aws-us-gov:iam::999999999999:role/path/presign' });
  sdk.reply('CreateJobCommand', {});
  await elsewhere.createJob(input);
  assert.equal(sdk.inputs('CreateJobCommand')[0].targets[0], `arn:aws-us-gov:iot:us-gov-west-1:999999999999:thing/${THING}`);
});

test('cancelJob passes the force flag, the reason code and the comment', async () => {
  const aws = adapter();
  sdk.reply('CancelJobCommand', { jobId: JOB }, { jobId: JOB });
  assert.deepEqual(await aws.cancelJob({ jobId: JOB, force: true, reasonCode: 'RELEASE_REVOKED', comment: 'who' }), { ok: true });
  assert.deepEqual(await aws.cancelJob({ jobId: JOB, force: false, reasonCode: 'CONSOLE_CANCEL', comment: 'who' }), { ok: true });
  assert.deepEqual(sdk.inputs('CancelJobCommand'), [
    { jobId: JOB, force: true, reasonCode: 'RELEASE_REVOKED', comment: 'who' },
    { jobId: JOB, force: false, reasonCode: 'CONSOLE_CANCEL', comment: 'who' },
  ]);
  // Anything but true is not forced.
  sdk.reply('CancelJobCommand', {});
  await aws.cancelJob({ jobId: JOB, force: 'yes', reasonCode: 'CONSOLE_CANCEL', comment: 'who' });
  assert.equal(sdk.inputs('CancelJobCommand')[2].force, false);

  const request = { jobId: JOB, force: true, reasonCode: 'CONSOLE_CANCEL', comment: 'who' };
  sdk.reply('CancelJobCommand', fails('ResourceNotFoundException', { status: 404 }));
  assert.deepEqual(await aws.cancelJob(request), { ok: false, reason: 'not_found' });
  sdk.reply('CancelJobCommand', fails('InvalidRequestException', { message: 'Job is in a terminal state' }));
  assert.deepEqual(await aws.cancelJob(request), { ok: false, reason: 'refused', detail: 'Job is in a terminal state' });
  sdk.reply('CancelJobCommand', fails('ThrottlingException'));
  await rejectsWith(aws.cancelJob(request), { code: 'throttled', operation: 'CancelJob' });
  sdk.reply('CancelJobCommand', fails('LimitExceededException', { status: 410 }));
  await rejectsWith(aws.cancelJob(request), { code: 'failed', operation: 'CancelJob' });
});

test('putFirmwareObject writes once, with the SHA-256 for S3 to check', async () => {
  const aws = adapter();
  const body = Buffer.from('firmware image bytes');
  const sha256Base64 = createHash('sha256').update(body).digest('base64');
  const key = `firmware/${'ab'.repeat(32)}.bin`;

  sdk.reply('PutObjectCommand', { ETag: '"etag"', VersionId: 'v1', ChecksumSHA256: sha256Base64 });
  assert.deepEqual(await aws.putFirmwareObject({ key, body, sha256Base64 }), { stored: true });
  assert.deepEqual(sdk.inputs('PutObjectCommand'), [{
    Bucket: 'firmware-bucket',
    Key: key,
    Body: body,
    ContentType: 'application/octet-stream',
    ChecksumAlgorithm: 'SHA256',
    ChecksumSHA256: sha256Base64,
    IfNoneMatch: '*',
  }]);
  assert.equal(sdk.sent[0].package, '@aws-sdk/client-s3');

  // 412: the key is taken. Recognized by status or by name.
  sdk.reply('PutObjectCommand', fails('PreconditionFailed', { status: 412 }));
  assert.deepEqual(await aws.putFirmwareObject({ key, body, sha256Base64 }), { stored: false, reason: 'exists' });
  sdk.reply('PutObjectCommand', fails('UnknownError', { status: 412 }));
  assert.deepEqual(await aws.putFirmwareObject({ key, body, sha256Base64 }), { stored: false, reason: 'exists' });
  sdk.reply('PutObjectCommand', fails('PreconditionFailed', { status: undefined }));
  assert.deepEqual(await aws.putFirmwareObject({ key, body, sha256Base64 }), { stored: false, reason: 'exists' });

  // 409: a concurrent write to the same key. Tried again, a limited number of times.
  sdk.reset();
  sdk.reply('PutObjectCommand', fails('ConditionalRequestConflict', { status: 409 }),
    fails('ConditionalRequestConflict', { status: 409 }), fails('PreconditionFailed', { status: 412 }));
  assert.deepEqual(await aws.putFirmwareObject({ key, body, sha256Base64 }), { stored: false, reason: 'exists' });
  assert.equal(sdk.inputs('PutObjectCommand').length, 3);
  sdk.reset();
  sdk.reply('PutObjectCommand', ...Array.from({ length: 5 }, () => fails('ConditionalRequestConflict', { status: 409 })));
  await rejectsWith(aws.putFirmwareObject({ key, body, sha256Base64 }),
    { code: 'failed', operation: 'PutObject', awsError: 'ConditionalRequestConflict' });
  assert.equal(sdk.inputs('PutObjectCommand').length, 3);

  // Refused by the bucket policy, a wrong digest, throttling.
  sdk.reset();
  for (const [name, status, code] of [['AccessDenied', 403, 'failed'], ['BadDigest', 400, 'failed'], ['SlowDown', 503, 'throttled']]) {
    sdk.reply('PutObjectCommand', fails(name, { status }));
    await rejectsWith(aws.putFirmwareObject({ key, body, sha256Base64 }), { code, operation: 'PutObject', awsError: name });
  }
});

test('tagFirmwareRevoked sets the tag the bucket policy looks for', async () => {
  const aws = adapter();
  const key = `firmware/${'ab'.repeat(32)}.bin`;
  sdk.reply('PutObjectTaggingCommand', { VersionId: 'v1' });
  assert.deepEqual(await aws.tagFirmwareRevoked(key), { ok: true });
  assert.deepEqual(sdk.inputs('PutObjectTaggingCommand'), [{
    Bucket: 'firmware-bucket',
    Key: key,
    ChecksumAlgorithm: 'SHA256',
    Tagging: { TagSet: [{ Key: 'revoked', Value: 'true' }] },
  }]);

  sdk.reply('PutObjectTaggingCommand', fails('NoSuchKey', { status: 404 }));
  assert.deepEqual(await aws.tagFirmwareRevoked(key), { ok: false, reason: 'not_found' });
  sdk.reply('PutObjectTaggingCommand', fails('AccessDenied', { status: 403 }));
  await rejectsWith(aws.tagFirmwareRevoked(key), { code: 'failed', operation: 'PutObjectTagging' });
});

const RELEASE = Object.freeze({
  version: '1.2.3+4',
  size: 1264,
  sha256: 'ab'.repeat(32),
  filename: 'zephyr.signed.bin',
  notes: '',
  uploadedBy: { sub: 'who', email: 'address' },
  uploadedAt: '2026-10-10T22:15:00.000Z',
  status: 'active',
  revoked: null,
});
const SK = '001.002.00003.0000000004';
const RELEASE_ITEM = Object.freeze({
  pk: { S: 'REL' },
  sk: { S: SK },
  version: { S: '1.2.3+4' },
  size: { N: '1264' },
  sha256: { S: 'ab'.repeat(32) },
  filename: { S: 'zephyr.signed.bin' },
  notes: { S: '' },
  uploadedBy: { M: { sub: { S: 'who' }, email: { S: 'address' } } },
  uploadedAt: { S: '2026-10-10T22:15:00.000Z' },
  status: { S: 'active' },
  revoked: { NULL: true },
});

test('getRelease reads one item consistently and turns it into plain data', async () => {
  const aws = adapter();
  sdk.reply('GetItemCommand', { Item: RELEASE_ITEM });
  assert.deepEqual(await aws.getRelease(SK), { ...RELEASE, pk: 'REL', sk: SK });
  assert.deepEqual(sdk.inputs('GetItemCommand'), [{
    TableName: 'state-table', Key: { pk: { S: 'REL' }, sk: { S: SK } }, ConsistentRead: true,
  }]);
  assert.equal(sdk.sent[0].package, '@aws-sdk/client-dynamodb');

  sdk.reply('GetItemCommand', {});
  assert.equal(await aws.getRelease(SK), null);
  sdk.reply('GetItemCommand', fails('ProvisionedThroughputExceededException'));
  await rejectsWith(aws.getRelease(SK), { code: 'throttled', operation: 'GetItem' });

  // Every attribute type the module stores, and the ones it never does.
  sdk.reply('GetItemCommand', {
    Item: {
      text: { S: 'x' }, number: { N: '-12.5' }, yes: { BOOL: true }, no: { BOOL: false }, nothing: { NULL: true },
      list: { L: [{ S: 'a' }, { N: '2' }, { M: { deep: { BOOL: true } } }] },
      map: { M: { inner: { M: { n: { N: '0' } } } } },
      set: { SS: ['a', 'b'] }, bytes: { B: new Uint8Array([1]) },
    },
  });
  assert.deepEqual(await aws.getRelease(SK), {
    text: 'x', number: -12.5, yes: true, no: false, nothing: null, list: ['a', 2, { deep: true }],
    map: { inner: { n: 0 } }, set: null, bytes: null,
  });
});

test('highestReleaseKey reads the pointer item consistently', async () => {
  const aws = adapter();
  sdk.reply('GetItemCommand', { Item: { pk: { S: 'META' }, sk: { S: 'HIGHEST' }, highest: { S: SK } } });
  assert.equal(await aws.highestReleaseKey(), SK);
  assert.deepEqual(sdk.inputs('GetItemCommand'), [{
    TableName: 'state-table', Key: { pk: { S: 'META' }, sk: { S: 'HIGHEST' } }, ConsistentRead: true,
  }]);

  // Before the first release there is no pointer.
  sdk.reply('GetItemCommand', {});
  assert.equal(await aws.highestReleaseKey(), null);
  sdk.reply('GetItemCommand', fails('ProvisionedThroughputExceededException'));
  await rejectsWith(aws.highestReleaseKey(), { code: 'throttled', operation: 'GetItem' });
});

test('listReleases queries the release partition, highest version first, every page', async () => {
  const aws = adapter();
  sdk.reply('QueryCommand',
    { Items: [RELEASE_ITEM], LastEvaluatedKey: { pk: { S: 'REL' }, sk: { S: SK } } },
    { Items: [{ ...RELEASE_ITEM, sk: { S: '001.000.00000.0000000000' } }] });
  const releases = await aws.listReleases();
  assert.deepEqual(releases.map((release) => release.sk), [SK, '001.000.00000.0000000000']);
  assert.deepEqual(sdk.inputs('QueryCommand'), [
    {
      TableName: 'state-table',
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': { S: 'REL' } },
      ScanIndexForward: false,
      ConsistentRead: true,
    },
    {
      TableName: 'state-table',
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': { S: 'REL' } },
      ScanIndexForward: false,
      ConsistentRead: true,
      ExclusiveStartKey: { pk: { S: 'REL' }, sk: { S: SK } },
    },
  ]);
  sdk.reply('QueryCommand', {});
  assert.deepEqual(await aws.listReleases(), []);
  sdk.reply('QueryCommand', fails('InternalServerError', { status: 500 }));
  await rejectsWith(aws.listReleases(), { code: 'failed', operation: 'Query' });
});

test('registerRelease stores the release and advances the pointer in one transaction', async () => {
  const aws = adapter();
  sdk.reply('TransactWriteItemsCommand', {});
  assert.deepEqual(await aws.registerRelease({ sk: SK, release: { ...RELEASE, pk: 'ignored', sk: 'ignored', skipped: undefined } }),
    { ok: true });
  assert.deepEqual(sdk.inputs('TransactWriteItemsCommand'), [{
    TransactItems: [
      {
        Put: {
          TableName: 'state-table',
          Item: RELEASE_ITEM,
          ConditionExpression: 'attribute_not_exists(#pk)',
          ExpressionAttributeNames: { '#pk': 'pk' },
        },
      },
      {
        Update: {
          TableName: 'state-table',
          Key: { pk: { S: 'META' }, sk: { S: 'HIGHEST' } },
          UpdateExpression: 'SET #highest = :sk',
          ConditionExpression: 'attribute_not_exists(#highest) OR #highest < :sk',
          ExpressionAttributeNames: { '#highest': 'highest' },
          ExpressionAttributeValues: { ':sk': { S: SK } },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        },
      },
    ],
  }]);
});

test('registerRelease tells an existing version from one that is not newer', async () => {
  const aws = adapter();
  const cancelled = (...reasons) => fails('TransactionCanceledException', { CancellationReasons: reasons });
  const request = { sk: SK, release: RELEASE };
  const none = { Code: 'None' };
  const failed = { Code: 'ConditionalCheckFailed', Message: 'The conditional request failed' };
  const pointer = { pk: { S: 'META' }, sk: { S: 'HIGHEST' }, highest: { S: '002.000.00000.0000000000' } };

  // The release item exists, whatever the pointer says.
  sdk.reply('TransactWriteItemsCommand', cancelled(failed, none));
  assert.deepEqual(await aws.registerRelease(request), { ok: false, reason: 'exists' });
  sdk.reply('TransactWriteItemsCommand', cancelled(failed, { ...failed, Item: pointer }));
  assert.deepEqual(await aws.registerRelease(request), { ok: false, reason: 'exists' });

  // Only the pointer refuses: not newer, and the old pointer value says than what.
  sdk.reply('TransactWriteItemsCommand', cancelled(none, { ...failed, Item: pointer }));
  assert.deepEqual(await aws.registerRelease(request),
    { ok: false, reason: 'not_newer', highest: '002.000.00000.0000000000' });
  assert.equal(sdk.inputs('GetItemCommand').length, 0);

  // If the reason carries no item, the pointer is read.
  sdk.reply('TransactWriteItemsCommand', cancelled(none, failed));
  sdk.reply('GetItemCommand', { Item: pointer });
  assert.deepEqual(await aws.registerRelease(request),
    { ok: false, reason: 'not_newer', highest: '002.000.00000.0000000000' });
  assert.deepEqual(sdk.inputs('GetItemCommand'), [{
    TableName: 'state-table', Key: { pk: { S: 'META' }, sk: { S: 'HIGHEST' } }, ConsistentRead: true,
  }]);
  sdk.reply('TransactWriteItemsCommand', cancelled(none, failed));
  sdk.reply('GetItemCommand', fails('InternalServerError', { status: 500 }));
  assert.deepEqual(await aws.registerRelease(request), { ok: false, reason: 'not_newer', highest: null });

  // A concurrent transaction on the same items.
  sdk.reply('TransactWriteItemsCommand', cancelled(none, { Code: 'TransactionConflict' }));
  assert.deepEqual(await aws.registerRelease(request), { ok: false, reason: 'conflict' });

  // Anything else is a failure.
  sdk.reply('TransactWriteItemsCommand', cancelled({ Code: 'ThrottlingError' }, none));
  await rejectsWith(aws.registerRelease(request), { code: 'throttled', operation: 'TransactWriteItems' });
  sdk.reply('TransactWriteItemsCommand', cancelled({ Code: 'ValidationError' }, none));
  await rejectsWith(aws.registerRelease(request), { code: 'failed', operation: 'TransactWriteItems' });
  sdk.reply('TransactWriteItemsCommand', fails('TransactionCanceledException'));
  await rejectsWith(aws.registerRelease(request), { code: 'failed', operation: 'TransactWriteItems' });
  sdk.reply('TransactWriteItemsCommand', fails('AccessDeniedException'));
  await rejectsWith(aws.registerRelease(request), { code: 'failed', operation: 'TransactWriteItems' });

  // Only plain data can be stored.
  for (const value of [NaN, Infinity, () => {}, Symbol('x'), 10n]) {
    await assert.rejects(aws.registerRelease({ sk: SK, release: { ...RELEASE, size: value } }), TypeError);
  }
});

test('markReleaseRevoked changes an active release and nothing else', async () => {
  const aws = adapter();
  const revoked = { by: { sub: 'who', email: 'address' }, at: '2026-10-11T08:00:00.000Z', reason: 'bad build' };
  const revokedItem = {
    ...RELEASE_ITEM,
    status: { S: 'revoked' },
    revoked: { M: { by: { M: { sub: { S: 'who' }, email: { S: 'address' } } }, at: { S: '2026-10-11T08:00:00.000Z' }, reason: { S: 'bad build' } } },
  };
  sdk.reply('UpdateItemCommand', { Attributes: revokedItem });
  assert.deepEqual(await aws.markReleaseRevoked({ sk: SK, revoked }),
    { ok: true, release: { ...RELEASE, pk: 'REL', sk: SK, status: 'revoked', revoked } });
  assert.deepEqual(sdk.inputs('UpdateItemCommand'), [{
    TableName: 'state-table',
    Key: { pk: { S: 'REL' }, sk: { S: SK } },
    UpdateExpression: 'SET #status = :revoked, #revoked = :info',
    ConditionExpression: '#status = :active',
    ExpressionAttributeNames: { '#status': 'status', '#revoked': 'revoked' },
    ExpressionAttributeValues: {
      ':active': { S: 'active' },
      ':revoked': { S: 'revoked' },
      ':info': revokedItem.revoked,
    },
    ReturnValues: 'ALL_NEW',
  }]);

  sdk.reply('UpdateItemCommand', fails('ConditionalCheckFailedException'));
  assert.deepEqual(await aws.markReleaseRevoked({ sk: SK, revoked }), { ok: false, reason: 'not_active' });
  sdk.reply('UpdateItemCommand', fails('ThrottlingException'));
  await rejectsWith(aws.markReleaseRevoked({ sk: SK, revoked }), { code: 'throttled', operation: 'UpdateItem' });
});

test('putAudit appends and never overwrites', async () => {
  const aws = adapter();
  const item = {
    sk: '2026-10-10T22:15:00.000Z#request-1', at: '2026-10-10T22:15:00.000Z', requestId: 'request-1',
    actor: { sub: 'who', email: '' }, action: 'firmware.upload', target: '1.2.3+4', outcome: 'ok',
    detail: { size: '1264' },
  };
  sdk.reply('PutItemCommand', {});
  assert.deepEqual(await aws.putAudit(item), { ok: true });
  assert.deepEqual(sdk.inputs('PutItemCommand'), [{
    TableName: 'audit-table',
    Item: {
      pk: { S: 'AUD' },
      sk: { S: '2026-10-10T22:15:00.000Z#request-1' },
      at: { S: '2026-10-10T22:15:00.000Z' },
      requestId: { S: 'request-1' },
      actor: { M: { sub: { S: 'who' }, email: { S: '' } } },
      action: { S: 'firmware.upload' },
      target: { S: '1.2.3+4' },
      outcome: { S: 'ok' },
      detail: { M: { size: { S: '1264' } } },
    },
    ConditionExpression: 'attribute_not_exists(#pk)',
    ExpressionAttributeNames: { '#pk': 'pk' },
  }]);

  sdk.reply('PutItemCommand', fails('ConditionalCheckFailedException'));
  assert.deepEqual(await aws.putAudit(item), { ok: false, reason: 'exists' });
  sdk.reply('PutItemCommand', fails('RequestLimitExceeded'));
  await rejectsWith(aws.putAudit(item), { code: 'throttled', operation: 'PutItem' });
  sdk.reply('PutItemCommand', fails('ResourceNotFoundException'));
  await rejectsWith(aws.putAudit(item), { code: 'failed', operation: 'PutItem' });
});

test('queryAudit reads newest first, below a cursor, never more than asked', async () => {
  const aws = adapter();
  const entry = (n) => ({ pk: { S: 'AUD' }, sk: { S: `2026-10-10T22:15:0${n}.000Z#r${n}` }, outcome: { S: 'ok' } });

  sdk.reply('QueryCommand', { Items: [entry(9), entry(8), entry(7)] });
  assert.deepEqual((await aws.queryAudit({ before: null, limit: 3 })).map((item) => item.sk),
    ['2026-10-10T22:15:09.000Z#r9', '2026-10-10T22:15:08.000Z#r8', '2026-10-10T22:15:07.000Z#r7']);
  assert.deepEqual(sdk.inputs('QueryCommand'), [{
    TableName: 'audit-table',
    KeyConditionExpression: '#pk = :pk',
    ExpressionAttributeNames: { '#pk': 'pk' },
    ExpressionAttributeValues: { ':pk': { S: 'AUD' } },
    ScanIndexForward: false,
    ConsistentRead: true,
    Limit: 3,
  }]);

  // Below a cursor; a short page with more to come is continued for the rest only.
  sdk.reset();
  sdk.reply('QueryCommand',
    { Items: [entry(6), entry(5)], LastEvaluatedKey: { pk: { S: 'AUD' }, sk: entry(5).sk } },
    { Items: [entry(4), entry(3), entry(2)] });
  const page = await aws.queryAudit({ before: '2026-10-10T22:15:07.000Z#r7', limit: 4 });
  assert.deepEqual(page.map((item) => item.sk.slice(-2)), ['r6', 'r5', 'r4', 'r3']);
  assert.deepEqual(sdk.inputs('QueryCommand'), [
    {
      TableName: 'audit-table',
      KeyConditionExpression: '#pk = :pk AND #sk < :before',
      ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
      ExpressionAttributeValues: { ':pk': { S: 'AUD' }, ':before': { S: '2026-10-10T22:15:07.000Z#r7' } },
      ScanIndexForward: false,
      ConsistentRead: true,
      Limit: 4,
    },
    {
      TableName: 'audit-table',
      KeyConditionExpression: '#pk = :pk AND #sk < :before',
      ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
      ExpressionAttributeValues: { ':pk': { S: 'AUD' }, ':before': { S: '2026-10-10T22:15:07.000Z#r7' } },
      ScanIndexForward: false,
      ConsistentRead: true,
      Limit: 2,
      ExclusiveStartKey: { pk: { S: 'AUD' }, sk: entry(5).sk },
    },
  ]);

  sdk.reply('QueryCommand', { Items: [] });
  assert.deepEqual(await aws.queryAudit({ before: undefined, limit: 50 }), []);
  sdk.reply('QueryCommand', fails('ThrottlingException'));
  await rejectsWith(aws.queryAudit({ before: null, limit: 5 }), { code: 'throttled', operation: 'Query' });
});

test('getUser asks the pool by sub and reports enabled, status and address', async () => {
  const aws = adapter();
  const sub = '11111111-2222-4333-8444-555555555555';
  sdk.reply('AdminGetUserCommand', {
    Username: sub,
    UserAttributes: [{ Name: 'sub', Value: sub }, { Name: 'email_verified', Value: 'true' }, { Name: 'email', Value: 'address' }],
    Enabled: true,
    UserStatus: 'CONFIRMED',
    UserCreateDate: new Date(T0),
    UserMFASettingList: ['SOFTWARE_TOKEN_MFA'],
  });
  assert.deepEqual(await aws.getUser(sub), { enabled: true, status: 'CONFIRMED', email: 'address' });
  assert.deepEqual(sdk.inputs('AdminGetUserCommand'), [{ UserPoolId: 'eu-west-1_Pool', Username: sub }]);
  assert.equal(sdk.sent[0].package, '@aws-sdk/client-cognito-identity-provider');

  sdk.reply('AdminGetUserCommand', { Username: sub, Enabled: false, UserStatus: 'FORCE_CHANGE_PASSWORD' });
  assert.deepEqual(await aws.getUser(sub), { enabled: false, status: 'FORCE_CHANGE_PASSWORD', email: '' });
  // Only a literal true counts as enabled.
  sdk.reply('AdminGetUserCommand', { Username: sub, UserStatus: 'CONFIRMED' });
  assert.deepEqual(await aws.getUser(sub), { enabled: false, status: 'CONFIRMED', email: '' });

  sdk.reply('AdminGetUserCommand', fails('UserNotFoundException'));
  assert.equal(await aws.getUser(sub), null);
  sdk.reply('AdminGetUserCommand', fails('TooManyRequestsException'));
  await rejectsWith(aws.getUser(sub), { code: 'throttled', operation: 'AdminGetUser' });
  // A missing pool or missing permission is a failure, never "no such user".
  for (const name of ['ResourceNotFoundException', 'NotAuthorizedException', 'InternalErrorException']) {
    sdk.reply('AdminGetUserCommand', fails(name));
    await rejectsWith(aws.getUser(sub), { code: 'failed', operation: 'AdminGetUser', awsError: name });
  }
});

test('listUserGroups reads every page of the user\'s groups', async () => {
  const aws = adapter();
  const sub = '11111111-2222-4333-8444-555555555555';
  sdk.reply('AdminListGroupsForUserCommand',
    { Groups: [{ GroupName: 'viewers', UserPoolId: 'eu-west-1_Pool' }], NextToken: 'more' },
    { Groups: [{ GroupName: 'release-managers' }, { Description: 'no name' }] });
  assert.deepEqual(await aws.listUserGroups(sub), ['viewers', 'release-managers']);
  assert.deepEqual(sdk.inputs('AdminListGroupsForUserCommand'), [
    { UserPoolId: 'eu-west-1_Pool', Username: sub, Limit: 60 },
    { UserPoolId: 'eu-west-1_Pool', Username: sub, Limit: 60, NextToken: 'more' },
  ]);

  sdk.reply('AdminListGroupsForUserCommand', {});
  assert.deepEqual(await aws.listUserGroups(sub), []);
  sdk.reply('AdminListGroupsForUserCommand', fails('UserNotFoundException'));
  assert.deepEqual(await aws.listUserGroups(sub), []);
  sdk.reply('AdminListGroupsForUserCommand', fails('InternalErrorException', { status: 500 }));
  await rejectsWith(aws.listUserGroups(sub), { code: 'failed', operation: 'AdminListGroupsForUser' });
});

test('results never contain SDK objects', async () => {
  const aws = adapter();
  sdk.reply('ListJobsCommand', { jobs: [{ jobId: JOB, status: 'IN_PROGRESS', createdAt: new Date(T0) }], $metadata: { httpStatusCode: 200 } });
  sdk.reply('DescribeJobCommand', { job: { jobId: JOB, status: 'IN_PROGRESS', createdAt: new Date(T0), targets: [THING_ARN] }, $metadata: {} });
  sdk.reply('ListJobExecutionsForJobCommand', { executionSummaries: [{ thingArn: THING_ARN, jobExecutionSummary: { status: 'QUEUED', queuedAt: new Date(T0) } }] });
  sdk.reply('DescribeJobExecutionCommand', { execution: { status: 'QUEUED', queuedAt: new Date(T0), statusDetails: { detailsMap: {} } } });
  sdk.reply('ListJobExecutionsForThingCommand', { executionSummaries: [{ jobId: JOB, jobExecutionSummary: { status: 'QUEUED', queuedAt: new Date(T0) } }] });
  sdk.reply('GetItemCommand', { Item: RELEASE_ITEM, $metadata: {} });
  const results = [
    await aws.listJobs(), await aws.describeJob(JOB), await aws.listJobExecutionsForJob(JOB),
    await aws.describeJobExecution(JOB, THING), await aws.listJobExecutionsForThing(THING), await aws.getRelease(SK),
  ];
  const plain = (value) => {
    if (value === null || typeof value !== 'object') return typeof value !== 'function';
    if (Array.isArray(value)) return value.every(plain);
    return Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(plain);
  };
  for (const result of results) {
    assert.ok(plain(result), JSON.stringify(result));
    // It survives JSON unchanged: no dates, no undefined, no classes.
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    assert.equal(JSON.stringify(result).includes('$metadata'), false);
  }
});

test('the fake answers in the same shapes as the adapter', async () => {
  const aws = adapter();
  const fake = createFakeAws({ now: () => T0 });
  fake.addThing(THING, { certificates: ['ab'.repeat(32)] });
  const keys = (value) => Object.keys(value).sort();
  const job = { jobId: JOB, things: [THING], document: '{}', description: 'x', urlExpiresInSec: 600, inProgressTimeoutMinutes: 30 };

  sdk.reply('CreateJobCommand', {}, fails('ResourceAlreadyExistsException'), fails('ResourceNotFoundException'));
  assert.deepEqual(await fake.createJob(job), await aws.createJob(job));
  assert.deepEqual(await fake.createJob(job), await aws.createJob(job));
  assert.deepEqual(await fake.createJob({ ...job, jobId: 'another', things: ['cranium-00000000000000ff'] }), await aws.createJob(job));

  const summary = { status: 'QUEUED', queuedAt: new Date(T0), lastUpdatedAt: new Date(T0), executionNumber: 1 };
  sdk.reply('ListJobsCommand', { jobs: [{ jobId: JOB, status: 'IN_PROGRESS', createdAt: new Date(T0), lastUpdatedAt: new Date(T0) }] });
  assert.deepEqual(await fake.listJobs(), await aws.listJobs());
  sdk.reply('DescribeJobCommand', {
    job: { jobId: JOB, status: 'IN_PROGRESS', description: 'x', targets: [THING_ARN], createdAt: new Date(T0),
      lastUpdatedAt: new Date(T0), jobProcessDetails: { numberOfQueuedThings: 1 } },
  }, fails('ResourceNotFoundException'));
  assert.deepEqual(await fake.describeJob(JOB), await aws.describeJob(JOB));
  assert.deepEqual(await fake.describeJob('unknown'), await aws.describeJob('unknown'));
  sdk.reply('ListJobExecutionsForJobCommand', { executionSummaries: [{ thingArn: THING_ARN, jobExecutionSummary: summary }] });
  assert.deepEqual(await fake.listJobExecutionsForJob(JOB), await aws.listJobExecutionsForJob(JOB));
  sdk.reply('DescribeJobExecutionCommand', { execution: { ...summary, forceCanceled: false, statusDetails: { detailsMap: {} } } },
    fails('ResourceNotFoundException'));
  assert.deepEqual(await fake.describeJobExecution(JOB, THING), await aws.describeJobExecution(JOB, THING));
  assert.deepEqual(await fake.describeJobExecution('unknown', THING), await aws.describeJobExecution('unknown', THING));
  sdk.reply('ListJobExecutionsForThingCommand', { executionSummaries: [{ jobId: JOB, jobExecutionSummary: summary }] });
  assert.deepEqual(await fake.listJobExecutionsForThing(THING), await aws.listJobExecutionsForThing(THING));
  sdk.reply('ListThingPrincipalsCommand', { principals: [`arn:aws:iot:us-east-1:000000000000:cert/${'ab'.repeat(32)}`] });
  assert.deepEqual(await fake.listThingPrincipals(THING), await aws.listThingPrincipals(THING));
  sdk.reply('ListThingsInThingGroupCommand', { things: [THING] });
  assert.deepEqual(await fake.listGroupThings(), await aws.listGroupThings());
  sdk.reply('GetThingShadowCommand', fails('ResourceNotFoundException', { status: 404 }));
  assert.deepEqual(await fake.getShadow(THING), await aws.getShadow(THING));

  const cancel = { jobId: JOB, force: true, reasonCode: 'CONSOLE_CANCEL', comment: 'who' };
  sdk.reply('CancelJobCommand', {}, fails('InvalidRequestException'), fails('ResourceNotFoundException'));
  assert.deepEqual(await fake.cancelJob(cancel), await aws.cancelJob(cancel));
  assert.deepEqual(keys(await fake.cancelJob(cancel)), keys(await aws.cancelJob(cancel)));
  assert.deepEqual(await fake.cancelJob({ ...cancel, jobId: 'unknown' }), await aws.cancelJob(cancel));

  const body = Buffer.from('image');
  const put = { key: 'firmware/x.bin', body, sha256Base64: createHash('sha256').update(body).digest('base64') };
  sdk.reply('PutObjectCommand', {}, fails('PreconditionFailed', { status: 412 }));
  assert.deepEqual(await fake.putFirmwareObject(put), await aws.putFirmwareObject(put));
  assert.deepEqual(await fake.putFirmwareObject(put), await aws.putFirmwareObject(put));
  sdk.reply('PutObjectTaggingCommand', {}, fails('NoSuchKey', { status: 404 }));
  assert.deepEqual(await fake.tagFirmwareRevoked(put.key), await aws.tagFirmwareRevoked(put.key));
  assert.deepEqual(await fake.tagFirmwareRevoked('firmware/none.bin'), await aws.tagFirmwareRevoked('firmware/none.bin'));

  const pointer = { pk: { S: 'META' }, sk: { S: 'HIGHEST' }, highest: { S: SK } };
  sdk.reply('TransactWriteItemsCommand', {},
    fails('TransactionCanceledException', { CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'ConditionalCheckFailed' }] }),
    fails('TransactionCanceledException', { CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed', Item: pointer }] }));
  assert.deepEqual(await fake.registerRelease({ sk: SK, release: RELEASE }), await aws.registerRelease({ sk: SK, release: RELEASE }));
  assert.deepEqual(await fake.registerRelease({ sk: SK, release: RELEASE }), await aws.registerRelease({ sk: SK, release: RELEASE }));
  const older = { sk: '001.000.00000.0000000000', release: { ...RELEASE, version: '1.0.0+0' } };
  assert.deepEqual(await fake.registerRelease(older), await aws.registerRelease(older));
  sdk.reply('GetItemCommand', { Item: RELEASE_ITEM }, {});
  assert.deepEqual(await fake.getRelease(SK), await aws.getRelease(SK));
  assert.deepEqual(await fake.getRelease('none'), await aws.getRelease('none'));
  sdk.reply('QueryCommand', { Items: [RELEASE_ITEM] });
  assert.deepEqual(await fake.listReleases(), await aws.listReleases());

  const revoked = { by: { sub: 'who', email: 'address' }, at: '2026-10-11T08:00:00.000Z', reason: 'bad build' };
  sdk.reply('UpdateItemCommand', {
    Attributes: { ...RELEASE_ITEM, status: { S: 'revoked' },
      revoked: { M: { by: { M: { sub: { S: 'who' }, email: { S: 'address' } } }, at: { S: revoked.at }, reason: { S: revoked.reason } } } },
  }, fails('ConditionalCheckFailedException'));
  assert.deepEqual(await fake.markReleaseRevoked({ sk: SK, revoked }), await aws.markReleaseRevoked({ sk: SK, revoked }));
  assert.deepEqual(await fake.markReleaseRevoked({ sk: SK, revoked }), await aws.markReleaseRevoked({ sk: SK, revoked }));

  const item = { sk: '2026-10-10T22:15:00.000Z#r1', action: 'firmware.upload', outcome: 'ok', actor: { sub: 'who', email: '' } };
  sdk.reply('PutItemCommand', {}, fails('ConditionalCheckFailedException'));
  assert.deepEqual(await fake.putAudit(item), await aws.putAudit(item));
  assert.deepEqual(await fake.putAudit(item), await aws.putAudit(item));
  sdk.reply('QueryCommand', {
    Items: [{ pk: { S: 'AUD' }, sk: { S: item.sk }, action: { S: item.action }, outcome: { S: 'ok' },
      actor: { M: { sub: { S: 'who' }, email: { S: '' } } } }],
  });
  assert.deepEqual(await fake.queryAudit({ before: null, limit: 5 }), await aws.queryAudit({ before: null, limit: 5 }));

  fake.addUser({ sub: 'who', email: 'address', groups: ['viewers'] });
  sdk.reply('AdminGetUserCommand', { Enabled: true, UserStatus: 'CONFIRMED', UserAttributes: [{ Name: 'email', Value: 'address' }] },
    fails('UserNotFoundException'));
  assert.deepEqual(await fake.getUser('who'), await aws.getUser('who'));
  assert.deepEqual(await fake.getUser('nobody'), await aws.getUser('nobody'));
  sdk.reply('AdminListGroupsForUserCommand', { Groups: [{ GroupName: 'viewers' }] }, fails('UserNotFoundException'));
  assert.deepEqual(await fake.listUserGroups('who'), await aws.listUserGroups('who'));
  assert.deepEqual(await fake.listUserGroups('nobody'), await aws.listUserGroups('nobody'));

  // The fake fails the way the adapter does.
  fake.failNext('listJobs', { code: 'throttled' });
  await rejectsWith(fake.listJobs(), { code: 'throttled', operation: 'listJobs' });
});

test('the Lambda entry point serves a viewer\'s reads through the adapter', async () => {
  // index.mjs reads the environment when it is loaded, as it does at a cold start.
  Object.assign(process.env, fakeEnv());
  const lines = [];
  console.log = (line) => lines.push(JSON.parse(line));
  let responses;
  try {
    const { handler } = await import('../src/index.mjs');
    assert.equal(typeof handler, 'function');
    sdk.reset();
    sdk.reply('ListThingsInThingGroupCommand', { things: [THING] });
    sdk.reply('GetThingShadowCommand', fails('ResourceNotFoundException', { status: 404 }));
    sdk.reply('QueryCommand', { Items: [] }, { Items: [] });
    sdk.reply('ListJobsCommand', { jobs: [] });
    const claims = accessClaims({ sub: '11111111-2222-4333-8444-555555555555', groups: ['viewers'] });
    responses = [];
    for (const path of ['/api/devices', '/api/firmware', '/api/deployments', '/api/audit']) {
      responses.push(await handler(apiEvent('GET', path, { claims })));
    }
  } finally {
    console.log = realLog;
  }
  assert.deepEqual(responses.map((response) => response.statusCode), [200, 200, 200, 200]);
  assert.deepEqual(JSON.parse(responses[0].body).devices,
    [{ thing: THING, online: false, lastSeen: null, fw: null, ota: null, rssi: null, uptime: null }]);
  assert.deepEqual(JSON.parse(responses[1].body).releases, []);
  assert.deepEqual(JSON.parse(responses[2].body), { deployments: [] });
  assert.deepEqual(JSON.parse(responses[3].body), { entries: [], next: null });

  // What a viewer's reads ask of AWS: nothing that writes, and no Cognito call.
  assert.deepEqual(sdk.sent.map((entry) => entry.command),
    ['ListThingsInThingGroupCommand', 'GetThingShadowCommand', 'QueryCommand', 'ListJobsCommand', 'QueryCommand']);
  assert.deepEqual(sdk.inputs('QueryCommand').map((input) => input.TableName), ['local-state', 'local-audit']);
  assert.deepEqual(sdk.inputs('ListThingsInThingGroupCommand')[0].thingGroupName, 'cranium-devices');
  assert.deepEqual(lines.map((line) => [line.route, line.status]), [
    ['GET /api/devices', 200], ['GET /api/firmware', 200], ['GET /api/deployments', 200], ['GET /api/audit', 200],
  ]);
});
