// POST /images.
//
// First-party filter: the baseline MVP path, unchanged. Image arrives base64
// in JSON, one filter runs in-process, result is written to S3, Image item
// goes uploaded -> processed, 200 with a URL.
//
// Marketplace filter (B Decision 1): same request shape, but the work runs in
// the isolated boundary through the child workflow, so the response is 202
// with a status URL. GET /images/{id} returns the result when it is done.
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { StartExecutionCommand } from '@aws-sdk/client-sfn';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, env, s3, sfn } from '../shared/clients';
import { getImage } from '../shared/ddb';
import { FIRST_PARTY_FILTERS, getFilter, runFirstPartyFilter, validateParams, validatePipeline } from '../shared/filters';
import { HttpError, json, parseBody } from '../shared/http';
import { SINGLE_BATCH, newId, nowIso, pk, s3key, sk } from '../shared/keys';
import { putObjectBuffer } from '../shared/s3util';
import type { ChildState, ImageItem } from '../shared/types';
import { admitEntitlements, buildFilterVersions, resolverFor } from './marketplace';

interface PostImageBody {
  image: string; // base64
  filterId: string;
  version?: string;
  params?: Record<string, unknown>;
}

export async function postImage(orgId: string, event: APIGatewayProxyEventV2) {
  const body = parseBody<PostImageBody>(event);
  if (!body.image || typeof body.image !== 'string') throw new HttpError(400, 'bad_image', 'image (base64) required');
  if (!body.filterId) throw new HttpError(400, 'bad_filter', 'filterId required');
  if (!(body.filterId in FIRST_PARTY_FILTERS)) return postImageMarketplace(orgId, body);

  const def = getFilter(body.filterId);
  const params = validateParams(def.id, def.params, body.params);

  const bytes = Buffer.from(body.image, 'base64');
  const imageId = newId('img');
  const originalKey = s3key.singleOriginal(orgId, imageId);
  const processedKey = s3key.singleProcessed(orgId, imageId);
  const createdAt = nowIso();

  await s3.send(new PutObjectCommand({ Bucket: env.BUCKET_NAME, Key: originalKey, Body: bytes }));
  const item: ImageItem = {
    PK: pk.org(orgId),
    SK: sk.image(imageId),
    type: 'Image',
    orgId,
    imageId,
    status: 'uploaded',
    filterId: def.id,
    originalKey,
    createdAt,
  };
  await ddb.send(new PutCommand({ TableName: env.TABLE_NAME, Item: item }));

  const output = await runFirstPartyFilter(
    { type: 'first_party', filterId: def.id, version: def.version, params },
    bytes,
    { orgId, batchId: SINGLE_BATCH, imageId, stepNumber: 1 },
  );
  await s3.send(
    new PutObjectCommand({ Bucket: env.BUCKET_NAME, Key: processedKey, Body: output, ContentType: 'image/jpeg' }),
  );
  await ddb.send(
    new PutCommand({ TableName: env.TABLE_NAME, Item: { ...item, status: 'processed', processedKey } satisfies ImageItem }),
  );

  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: env.BUCKET_NAME, Key: processedKey }), {
    expiresIn: 3600,
  });
  return json(200, { imageId, status: 'processed', inputBytes: bytes.length, outputBytes: output.length, url });
}

// 202 path. The single image becomes a one-step "batch" named `single` and
// goes through the same child workflow as a batch item, so PrepareInvocation,
// the isolated filter, ValidateOutput and metering are the same code.
async function postImageMarketplace(orgId: string, body: PostImageBody) {
  const steps = await validatePipeline(
    [{ type: 'marketplace', filterId: body.filterId, version: body.version, params: body.params ?? {} }],
    resolverFor(orgId),
  );
  await admitEntitlements(orgId, steps);
  const filterVersions = await buildFilterVersions(steps);

  const bytes = Buffer.from(body.image, 'base64');
  const imageId = newId('img');
  const originalKey = s3key.original(orgId, SINGLE_BATCH, imageId);
  const sourceETag = await putObjectBuffer(originalKey, bytes);
  const runId = newId('run');
  const createdAt = nowIso();

  const item: ImageItem = {
    PK: pk.org(orgId),
    SK: sk.image(imageId),
    type: 'Image',
    orgId,
    imageId,
    status: 'processing',
    filterId: body.filterId,
    originalKey,
    batchId: SINGLE_BATCH,
    currentStep: 0,
    stepCount: 1,
    sourceETag,
    createdAt,
  };
  await ddb.send(new PutCommand({ TableName: env.TABLE_NAME, Item: item }));

  const input: ChildState = {
    orgId,
    batchId: SINGLE_BATCH,
    imageId,
    sourceETag,
    runId,
    steps,
    stepCount: 1,
    stepIndex: 0,
    filterVersions,
  };
  const exec = await sfn.send(
    new StartExecutionCommand({
      stateMachineArn: env.CHILD_SM_ARN,
      name: `single-${imageId}-${runId}`,
      input: JSON.stringify(input),
    }),
  );
  return json(202, {
    imageId,
    status: 'processing',
    statusUrl: `/images/${imageId}`,
    executionArn: exec.executionArn,
  });
}

export async function getImageRoute(orgId: string, imageId: string) {
  const image = await getImage(orgId, imageId);
  if (!image) throw new HttpError(404, 'not_found', `image ${imageId}`);
  let url: string | undefined;
  if (image.status === 'processed') {
    const key =
      image.processedKey ??
      (image.batchId && image.stepCount ? s3key.derived(orgId, image.batchId, imageId, image.stepCount) : undefined);
    if (key) url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: env.BUCKET_NAME, Key: key }), { expiresIn: 3600 });
  }
  return json(200, {
    imageId,
    status: image.status,
    batchId: image.batchId,
    filename: image.filename,
    currentStep: image.currentStep,
    stepCount: image.stepCount,
    error: image.error,
    executionArn: image.executionArn,
    url,
  });
}
