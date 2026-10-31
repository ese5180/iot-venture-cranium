// Tests for what the CloudFormation templates promise. There is no YAML parser in this
// project and no package may be added, so these read the templates as indented text: a
// resource is its line and everything indented below it. They catch a promise being
// dropped by an edit. Whether AWS accepts the templates is for validate-template and a
// deployment to say.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (name) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const template = read('infra/template.yaml');
const trail = read('infra/trail.yaml');
const teardown = read('teardown.sh');

/** The line that says `key:` at this indentation, with everything indented below it. */
function block(text, key, indent = 2) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${' '.repeat(indent)}${key}:`));
  assert.notEqual(start, -1, `${key} is missing`);
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() !== '' && line.length - line.trimStart().length <= indent) break;
    end += 1;
  }
  return lines.slice(start, end).join('\n');
}

/** The statements of a policy document, each as text, found by Sid. */
function statement(text, sid) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- Sid: ${sid}`);
  assert.notEqual(start, -1, `${sid} is missing`);
  const indent = lines[start].length - lines[start].trimStart().length;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() !== '' && !line.trim().startsWith('#') && line.length - line.trimStart().length <= indent) break;
    end += 1;
  }
  return lines.slice(start, end).join('\n');
}

test('reads and writes have a request limit each, and neither is weaker than the old route', () => {
  assert.equal(template.includes('ANY /api/'), false);
  for (const [resource, key] of [['ApiReadRoute', 'GET /api/{proxy+}'], ['ApiWriteRoute', 'POST /api/{proxy+}']]) {
    const route = block(template, resource);
    assert.ok(route.includes(`RouteKey: '${key}'`), resource);
    assert.ok(route.includes('AuthorizationType: JWT'), resource);
    assert.ok(route.includes('AuthorizerId: !Ref Authorizer'), resource);
    assert.ok(route.includes('- cranium/console'), resource);
    assert.ok(route.includes('integrations/${ApiIntegration}'), resource);
  }
  // Only the page itself, its files and what no route claims are open, whatever a route is called.
  const open = template.split(/\n(?= {2}\w+:\n)/)
    .filter((resource) => resource.includes('Type: AWS::ApiGatewayV2::Route') && resource.includes('AuthorizationType: NONE'))
    .map((resource) => /RouteKey: '?([^'\n]+)'?/.exec(resource)[1]);
  assert.deepEqual(open.sort(), ['$default', 'GET /', 'GET /assets/{proxy+}']);

  const stage = block(template, 'Stage');
  for (const name of ['ApiReadRoute', 'ApiWriteRoute']) assert.ok(block(stage, 'DependsOn', 4).includes(`- ${name}`));
  const settings = block(stage, 'RouteSettings', 6);
  const limits = (key) => {
    const part = settings.split(`'${key}':`)[1].split('\n').slice(1, 3).join('\n');
    // A missing number counts as zero and would throttle every request.
    return [Number(/ThrottlingBurstLimit: (\d+)/.exec(part)[1]), Number(/ThrottlingRateLimit: (\d+)/.exec(part)[1])];
  };
  assert.deepEqual(limits('GET /api/{proxy+}'), [20, 10]);
  assert.deepEqual(limits('POST /api/{proxy+}'), [10, 5]);
});

test('a user cannot change their own e-mail address', () => {
  const client = block(template, 'UserPoolClient');
  const allowed = [...block(client, 'WriteAttributes', 6).matchAll(/- (\S+)/g)].map((match) => match[1]);
  assert.deepEqual(allowed, ['name']);
  // Left as it is on purpose: managed login may need it, which only a test can show.
  assert.ok(client.includes('ALLOW_USER_SRP_AUTH'));
});

test('the tables are protected from deletion once the stack exists, not while it is created', () => {
  assert.ok(template.includes('ProtectFromDeletion: !Equals [!Ref UserPoolDeletionProtection, ACTIVE]'));
  assert.ok(block(block(template, 'Parameters', 0), 'UserPoolDeletionProtection').includes('Default: INACTIVE'));
  for (const table of ['StateTable', 'AuditTable']) {
    assert.ok(block(template, table).includes('DeletionProtectionEnabled: !If [ProtectFromDeletion, true, false]'), table);
    assert.ok(block(template, table).includes('DeletionPolicy: RetainExceptOnCreate'), table);
  }
});

test('the API role can set the revoked tag and cannot clear it', () => {
  const role = block(template, 'ApiRole');
  const store = statement(role, 'StoreFirmware');
  assert.ok(store.includes('Action: s3:PutObject'));
  assert.equal(store.includes('PutObjectTagging'), false);

  const mark = statement(role, 'MarkFirmwareRevoked');
  assert.ok(mark.includes('Action: s3:PutObjectTagging'));
  assert.ok(mark.includes("s3:RequestObjectTag/revoked: 'true'"));
  assert.ok(block(mark, 'ForAllValues:StringEquals', 18).includes('- revoked'));

  assert.equal((role.match(/s3:PutObjectTagging/g) ?? []).length, 1);
  for (const action of ['s3:DeleteObjectTagging', 's3:PutObjectVersionTagging', 's3:DeleteObject', 's3:GetObject']) {
    assert.equal(role.includes(`${action}\n`), false, action);
  }
});

test('the API role may only add to and read the audit table', () => {
  const role = block(template, 'ApiRole');
  const allowed = statement(role, 'AppendAndReadAudit');
  assert.deepEqual([...allowed.matchAll(/- (dynamodb:\w+)/g)].map((match) => match[1]), ['dynamodb:PutItem', 'dynamodb:Query']);
  assert.ok(allowed.includes('Resource: !GetAtt AuditTable.Arn'));

  const denied = statement(role, 'NeverChangeAuditEntries');
  assert.ok(denied.includes('Effect: Deny'));
  assert.ok(denied.includes('Resource: !GetAtt AuditTable.Arn'));
  for (const action of ['BatchWriteItem', 'DeleteItem', 'UpdateItem', 'DeleteTable', 'PartiQLUpdate', 'PartiQLDelete']) {
    assert.ok(denied.includes(`dynamodb:${action}`), action);
  }
  // Nothing else in the role names that table.
  assert.equal((role.match(/!GetAtt AuditTable\.Arn/g) ?? []).length, 2);
});

test('the IoT logging role keeps its published trust policy unless asked', () => {
  const parameter = block(block(template, 'Parameters', 0), 'RestrictIotLoggingTrust');
  assert.ok(parameter.includes("Default: 'false'"));
  const trust = block(block(template, 'IotLoggingRole'), 'AssumeRolePolicyDocument', 6);
  assert.ok(trust.includes('Condition: !If'));
  assert.ok(trust.includes('- RestrictedIotLoggingTrust'));
  assert.ok(trust.includes('aws:SourceAccount: !Ref AWS::AccountId'));
  assert.ok(trust.includes('- !Ref AWS::NoValue'));
});

test('a deployment says which commit it came from, where it can be looked up', () => {
  const parameters = block(template, 'Parameters', 0);
  assert.ok(block(parameters, 'DeployedCommit').includes("'^(unknown|[0-9a-f]{40})$'"));
  assert.ok(block(parameters, 'DeployedTree').includes('[clean, dirty, unknown]'));
  const outputs = block(template, 'Outputs', 0);
  assert.ok(block(outputs, 'DeployedCommit').includes('Value: !Ref DeployedCommit'));
  assert.ok(block(outputs, 'DeployedTree').includes('Value: !Ref DeployedTree'));
  // A resource has to change, or CloudFormation may not apply the new outputs.
  for (const fn of ['WebFn', 'ApiFn']) {
    assert.ok(block(template, fn).includes('${DeployedCommit} (${DeployedTree})'), fn);
  }
});

test('the address API Gateway assigned stays a place to sign in, by decision', () => {
  assert.equal(template.includes('DisableExecuteApiEndpoint'), false);
  const client = block(template, 'UserPoolClient');
  assert.ok(block(client, 'CallbackURLs', 6).includes("!Sub '${Api.ApiEndpoint}/'"));
  assert.ok(block(client, 'LogoutURLs', 6).includes("!Sub '${Api.ApiEndpoint}/'"));
});

test('the trail records management events in every Region, and nothing that costs extra', () => {
  const resource = block(trail, 'Trail');
  for (const line of ['IsLogging: true', 'IsMultiRegionTrail: true', 'IncludeGlobalServiceEvents: true',
    'EnableLogFileValidation: true', 'IncludeManagementEvents: true', 'S3BucketName: !Ref TrailBucket',
    'DependsOn: TrailBucketPolicy']) {
    assert.ok(resource.includes(line), line);
  }
  // Data events, Insights, a KMS key and CloudWatch delivery are all billed.
  for (const paid of ['DataResources', 'AdvancedEventSelectors', 'InsightSelectors', 'KMSKeyId', 'CloudWatchLogsLogGroupArn']) {
    assert.equal(trail.includes(`${paid}:`), false, paid);
  }
});

test('the trail bucket is private, answers only over TLS and does not grow for ever', () => {
  const bucket = block(trail, 'TrailBucket');
  for (const line of ['BlockPublicAcls: true', 'BlockPublicPolicy: true', 'IgnorePublicAcls: true',
    'RestrictPublicBuckets: true', 'ObjectOwnership: BucketOwnerEnforced', 'Status: Enabled',
    'ExpirationInDays: !Ref RetentionDays', 'NoncurrentDays: 30']) {
    assert.ok(bucket.includes(line), line);
  }
  // No name: it could be taken first in another account. No lock that outlives the course.
  assert.doesNotMatch(bucket, /^\s+BucketName:/m);
  assert.equal(bucket.includes('ObjectLock'), false);

  const policy = block(trail, 'TrailBucketPolicy');
  const tls = statement(policy, 'DenyRequestsWithoutTls');
  assert.ok(tls.includes('Effect: Deny'));
  assert.ok(tls.includes("aws:SecureTransport: 'false'"));
  // CloudTrail may write for this trail only, and only below its own folder.
  for (const sid of ['AWSCloudTrailAclCheck', 'AWSCloudTrailWrite']) {
    assert.ok(statement(policy, sid).includes(':trail/cranium-trail'), sid);
    assert.ok(statement(policy, sid).includes('Service: cloudtrail.amazonaws.com'), sid);
  }
  assert.ok(statement(policy, 'AWSCloudTrailWrite').includes('/AWSLogs/${AWS::AccountId}/*'));
  assert.ok(block(trail, 'Trail').includes('TrailName: cranium-trail'));
});

test('teardown leaves the trail and its log files alone', () => {
  for (const word of ['cranium-trail', 'delete-trail', 'stop-logging']) {
    assert.equal(teardown.includes(word), false, word);
  }
});
