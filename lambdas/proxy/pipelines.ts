// A Decision 3: ORG#<o> / PIPELINE#<p> holds the editable definition and a
// version counter; each save validates and writes an immutable
// ORG#<o> / PIPELINE#<p>#V#<n> snapshot. Batches pin p@n and children receive
// the snapshot itself, so execution never reads the mutable item.
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, env } from '../shared/clients';
import { validatePipeline } from '../shared/filters';
import { HttpError, json, parseBody } from '../shared/http';
import { newId, nowIso, pk, sk } from '../shared/keys';
import type { PipelineItem, PipelineSnapshot, PipelineVersionItem } from '../shared/types';

interface PostPipelineBody {
  pipelineId?: string; // omit to create; include to save a new version
  name?: string;
  steps: unknown;
}

export async function postPipeline(orgId: string, event: APIGatewayProxyEventV2) {
  const body = parseBody<PostPipelineBody>(event);
  // Validation happens before any write: a broken pipeline never gets a version.
  const steps = validatePipeline(body.steps);
  const pipelineId = body.pipelineId ?? newId('pipe');
  const now = nowIso();

  // Atomic counter: ADD version 1 returns the new number. Two concurrent saves
  // get two different numbers; neither can overwrite the other's snapshot.
  const upd = await ddb.send(
    new UpdateCommand({
      TableName: env.TABLE_NAME,
      Key: { PK: pk.org(orgId), SK: sk.pipeline(pipelineId) },
      UpdateExpression:
        'SET #type = :type, orgId = :org, pipelineId = :pid, #name = :name, steps = :steps, updatedAt = :now, createdAt = if_not_exists(createdAt, :now) ADD version :one',
      ExpressionAttributeNames: { '#type': 'type', '#name': 'name' },
      ExpressionAttributeValues: {
        ':type': 'Pipeline',
        ':org': orgId,
        ':pid': pipelineId,
        ':name': body.name ?? pipelineId,
        ':steps': steps,
        ':now': now,
        ':one': 1,
      },
      ReturnValues: 'ALL_NEW',
    }),
  );
  const version = (upd.Attributes as PipelineItem).version;

  const snapshot: PipelineVersionItem = {
    PK: pk.org(orgId),
    SK: sk.pipelineVersion(pipelineId, version),
    type: 'PipelineVersion',
    orgId,
    pipelineId,
    version,
    steps,
    createdAt: now,
  };
  await ddb.send(
    new PutCommand({
      TableName: env.TABLE_NAME,
      Item: snapshot,
      ConditionExpression: 'attribute_not_exists(SK)', // immutable: never overwritten
    }),
  );
  return json(201, { pipelineId, version, steps });
}

export async function getPipeline(orgId: string, pipelineId: string) {
  const res = await ddb.send(
    new GetCommand({ TableName: env.TABLE_NAME, Key: { PK: pk.org(orgId), SK: sk.pipeline(pipelineId) } }),
  );
  if (!res.Item) throw new HttpError(404, 'not_found', `pipeline ${pipelineId}`);
  const item = res.Item as PipelineItem;
  return json(200, { pipelineId: item.pipelineId, name: item.name, version: item.version, steps: item.steps });
}

// Read the immutable snapshot a batch pins. Used by POST /batches now and by
// submit later; the child workflow gets this object as input.
export async function loadSnapshot(orgId: string, pipelineId: string, version: number): Promise<PipelineSnapshot> {
  const res = await ddb.send(
    new GetCommand({
      TableName: env.TABLE_NAME,
      Key: { PK: pk.org(orgId), SK: sk.pipelineVersion(pipelineId, version) },
    }),
  );
  if (!res.Item) throw new HttpError(404, 'not_found', `pipeline ${pipelineId}@${version}`);
  const item = res.Item as PipelineVersionItem;
  return { pipelineId: item.pipelineId, version: item.version, steps: item.steps };
}
