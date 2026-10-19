// A Decision 1 and 5: the batch lifecycle.
//
//   POST /batches                      open   (pipeline version pinned, count declared)
//   POST /batches/{id}/upload-urls     presigned POSTs, Image items pending_upload
//   POST /batches/{id}/submit          reconcile S3 vs declared, manifest, start parent -> running
//   GET  /batches/{id}                 Batch item + per-image counts + live Map Run counts
//   GET  /batches/{id}/results         paged presigned GETs of final-step outputs
//   POST /batches/{id}/retry-failed    failed images only, new manifest, new run
//   POST /batches/{id}/images/{img}/upload-url   re-upload one image (fix then retry)
//
// Zero image bytes pass through this function.
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DescribeMapRunCommand, ListMapRunsCommand, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { BatchWriteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { countImagesByStatus, listBatchImages } from '../shared/batch-query';
import { ddb, env, s3, sfn } from '../shared/clients';
import { HttpError, json, parseBody } from '../shared/http';
import { gsi, newId, nowIso, pk, s3key, sk } from '../shared/keys';
import { headObject, listPrefix, putObjectBuffer } from '../shared/s3util';
import type { BatchItem, FilterVersionRef, ImageItem, PipelineSnapshot, PipelineStep } from '../shared/types';
import { admitEntitlements, buildFilterVersions } from './marketplace';
import { loadSnapshot } from './pipelines';

const UPLOAD_URL_PAGE = 100;
const UPLOAD_URL_EXPIRY_SECONDS = 3600;
const RESULTS_PAGE_DEFAULT = 50;

interface PostBatchBody {
  pipelineId: string;
  pipelineVersion: number;
  declaredCount: number;
}

export async function postBatch(orgId: string, event: APIGatewayProxyEventV2) {
  const body = parseBody<PostBatchBody>(event);
  if (!body.pipelineId || !Number.isInteger(body.pipelineVersion)) {
    throw new HttpError(400, 'bad_pipeline', 'pipelineId and integer pipelineVersion required');
  }
  if (!Number.isInteger(body.declaredCount) || body.declaredCount < 1 || body.declaredCount > 10000) {
    throw new HttpError(400, 'bad_count', 'declaredCount must be an integer in [1, 10000]');
  }
  // Pinning means the snapshot must exist now; a later edit creates V#n+1 and
  // leaves this batch's V#n alone.
  const snapshot = await loadSnapshot(orgId, body.pipelineId, body.pipelineVersion);
  // Scenario B: fail fast if the organization cannot run a marketplace step
  // in this pipeline. The terms are pinned again at submit (admission).
  await admitEntitlements(orgId, snapshot.steps);

  const batchId = newId('batch');
  const createdAt = nowIso();
  const item: BatchItem = {
    PK: pk.org(orgId),
    SK: sk.batch(batchId),
    type: 'Batch',
    orgId,
    batchId,
    pipelineId: body.pipelineId,
    pipelineVersion: body.pipelineVersion,
    declaredCount: body.declaredCount,
    status: 'open',
    createdAt,
    GSI2PK: gsi.orgBatches(orgId),
    GSI2SK: gsi.batchStatus('open', createdAt),
  };
  await ddb.send(new PutCommand({ TableName: env.TABLE_NAME, Item: item }));
  return json(201, {
    batchId,
    status: item.status,
    pipeline: `${item.pipelineId}@${item.pipelineVersion}`,
    declaredCount: item.declaredCount,
  });
}

interface UploadUrlsBody {
  filenames: string[];
}

export async function postUploadUrls(orgId: string, batchId: string, event: APIGatewayProxyEventV2) {
  const body = parseBody<UploadUrlsBody>(event);
  if (!Array.isArray(body.filenames) || body.filenames.length === 0 || body.filenames.length > UPLOAD_URL_PAGE) {
    throw new HttpError(400, 'bad_page', `filenames must have 1..${UPLOAD_URL_PAGE} entries`);
  }
  const batch = await loadBatch(orgId, batchId);
  if (batch.status !== 'open') throw new HttpError(409, 'batch_not_open', `batch is ${batch.status}`);

  const createdAt = nowIso();
  const items: ImageItem[] = [];
  const urls = [];
  for (const filename of body.filenames) {
    const imageId = newId('img');
    const key = s3key.original(orgId, batchId, imageId);
    const presigned = await presignUpload(key);
    items.push({
      PK: pk.org(orgId),
      SK: sk.image(imageId),
      type: 'Image',
      orgId,
      imageId,
      batchId,
      filename,
      status: 'pending_upload',
      currentStep: 0,
      createdAt,
      GSI1PK: gsi.batchImages(batchId),
      GSI1SK: sk.image(imageId),
    });
    urls.push({ imageId, filename, key, url: presigned.url, fields: presigned.fields });
  }
  await batchPut(items);
  return json(200, { batchId, maxBytes: env.MAX_UPLOAD_BYTES, expiresInSeconds: UPLOAD_URL_EXPIRY_SECONDS, urls });
}

// The policy is the server-side size check. S3 evaluates it; the client
// cannot loosen it because the policy is signed. Expiry applies to when the
// upload starts, and the client asks for pages as it goes.
async function presignUpload(key: string) {
  return createPresignedPost(s3, {
    Bucket: env.BUCKET_NAME,
    Key: key,
    Conditions: [['content-length-range', 1, env.MAX_UPLOAD_BYTES]],
    Expires: UPLOAD_URL_EXPIRY_SECONDS,
  });
}

// ---- submit ----

interface SubmitBody {
  confirm?: boolean;
}

export async function postSubmit(orgId: string, batchId: string, event: APIGatewayProxyEventV2) {
  const body = event.body ? parseBody<SubmitBody>(event) : {};
  const batch = await loadBatch(orgId, batchId);
  if (batch.status !== 'open') throw new HttpError(409, 'batch_not_open', `batch is ${batch.status}`);
  await assertOrgCapacity(orgId);

  // Reconcile: S3 is the truth about which uploads happened (Fact 9: S3 does
  // not tell us). Every Image item becomes uploaded (with its ETag) or missing.
  const objects = await listPrefix(s3key.originalsPrefix(orgId, batchId));
  const images = await listBatchImages(batchId);
  const uploaded: ImageItem[] = [];
  const missing: ImageItem[] = [];
  for (const img of images) {
    const obj = objects.get(s3key.original(orgId, batchId, img.imageId));
    if (obj) uploaded.push({ ...img, status: 'uploaded', sourceETag: obj.etag, currentStep: 0 });
    else missing.push({ ...img, status: 'missing' });
  }
  await batchPut([...uploaded, ...missing]);

  if (uploaded.length === 0) throw new HttpError(400, 'no_images', 'no uploaded images in this batch');
  if (uploaded.length !== batch.declaredCount && !body.confirm) {
    return json(409, {
      code: 'count_mismatch',
      message: `declared ${batch.declaredCount}, uploaded ${uploaded.length}, missing ${missing.length}; re-submit with {"confirm": true} to run with what is there`,
      declared: batch.declaredCount,
      uploaded: uploaded.length,
      missing: missing.length,
      missingImages: missing.map((m) => ({ imageId: m.imageId, filename: m.filename })),
    });
  }

  const snapshot = await loadSnapshot(orgId, batch.pipelineId, batch.pipelineVersion);
  const admittedEntitlements = await admitEntitlements(orgId, snapshot.steps);
  const filterVersions = await buildFilterVersions(snapshot.steps);

  // open -> submitted is conditional so two concurrent submits cannot both start a run.
  const submittedAt = nowIso();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: env.TABLE_NAME,
        Key: { PK: pk.org(orgId), SK: sk.batch(batchId) },
        UpdateExpression: 'SET #s = :submitted, submittedAt = :now, uploadedCount = :u, missingCount = :m, admittedEntitlements = :ent, GSI2SK = :gsi2',
        ConditionExpression: '#s = :open',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':submitted': 'submitted',
          ':open': 'open',
          ':now': submittedAt,
          ':u': uploaded.length,
          ':m': missing.length,
          ':ent': admittedEntitlements,
          ':gsi2': gsi.batchStatus('submitted', submittedAt),
        },
      }),
    );
  } catch (e) {
    if ((e as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new HttpError(409, 'batch_not_open', 'batch was submitted concurrently');
    }
    throw e;
  }

  const run = await startRun(orgId, batch, snapshot, filterVersions, uploaded);
  return json(202, {
    batchId,
    status: 'running',
    runId: run.runId,
    executionArn: run.executionArn,
    uploaded: uploaded.length,
    missing: missing.length,
    pipeline: `${snapshot.pipelineId}@${snapshot.version}`,
  });
}

// Write the manifest, start the parent, record the run on the Batch.
async function startRun(
  orgId: string,
  batch: BatchItem,
  snapshot: PipelineSnapshot,
  filterVersions: Record<string, FilterVersionRef>,
  images: ImageItem[],
) {
  const runId = newId('run');
  const manifestKey = s3key.manifest(orgId, batch.batchId, runId);
  const manifest = images.map((i) => ({ imageId: i.imageId, sourceETag: i.sourceETag }));
  await putObjectBuffer(manifestKey, Buffer.from(JSON.stringify(manifest)), { contentType: 'application/json' });

  const input = {
    orgId,
    batchId: batch.batchId,
    runId,
    manifestKey,
    steps: snapshot.steps as PipelineStep[],
    stepCount: snapshot.steps.length,
    filterVersions,
  };
  const exec = await sfn.send(
    new StartExecutionCommand({
      stateMachineArn: env.PARENT_SM_ARN,
      name: `${batch.batchId}-${runId}`,
      input: JSON.stringify(input),
    }),
  );
  const now = nowIso();
  await ddb.send(
    new UpdateCommand({
      TableName: env.TABLE_NAME,
      Key: { PK: pk.org(orgId), SK: sk.batch(batch.batchId) },
      UpdateExpression: 'SET #s = :running, executionArn = :arn, runId = :run, GSI2SK = :gsi2 REMOVE completedAt',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':running': 'running',
        ':arn': exec.executionArn,
        ':run': runId,
        ':gsi2': gsi.batchStatus('running', now),
      },
    }),
  );
  return { runId, executionArn: exec.executionArn! };
}

// Per-organization cap on running batches (A Decision 2), via GSI2.
async function assertOrgCapacity(orgId: string): Promise<void> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: env.TABLE_NAME,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :o AND begins_with(GSI2SK, :running)',
      ExpressionAttributeValues: { ':o': gsi.orgBatches(orgId), ':running': 'STATUS#running#' },
      Select: 'COUNT',
    }),
  );
  const running = res.Count ?? 0;
  if (running >= env.MAX_RUNNING_BATCHES_PER_ORG) {
    throw new HttpError(
      429,
      'org_batch_cap',
      `organization already has ${running} running batch(es); cap is ${env.MAX_RUNNING_BATCHES_PER_ORG}`,
    );
  }
}

// ---- status and results ----

export async function getBatch(orgId: string, batchId: string) {
  const batch = await loadBatch(orgId, batchId);
  const counts = await countImagesByStatus(batchId);
  const mapRun = batch.executionArn && batch.status === 'running' ? await describeMapRun(batch.executionArn) : undefined;
  return json(200, {
    batchId: batch.batchId,
    status: batch.status,
    pipeline: `${batch.pipelineId}@${batch.pipelineVersion}`,
    declaredCount: batch.declaredCount,
    uploadedCount: batch.uploadedCount,
    missingCount: batch.missingCount,
    images: counts,
    counts: batch.counts,
    mapRun,
    runId: batch.runId,
    executionArn: batch.executionArn,
    admittedEntitlements: batch.admittedEntitlements,
    createdAt: batch.createdAt,
    submittedAt: batch.submittedAt,
    completedAt: batch.completedAt,
  });
}

// Live progress straight from the Map Run (A Decision 5: "the Map Run's
// counts are the batch's counts").
async function describeMapRun(executionArn: string) {
  try {
    const runs = await sfn.send(new ListMapRunsCommand({ executionArn, maxResults: 1 }));
    const arn = runs.mapRuns?.[0]?.mapRunArn;
    if (!arn) return { state: 'starting' };
    const d = await sfn.send(new DescribeMapRunCommand({ mapRunArn: arn }));
    const c: Partial<NonNullable<typeof d.itemCounts>> = d.itemCounts ?? {};
    return {
      state: d.status,
      total: c.total,
      pending: c.pending,
      running: c.running,
      succeeded: c.succeeded,
      failed: c.failed,
      maxConcurrency: d.maxConcurrency,
    };
  } catch (e) {
    return { state: 'unknown', error: (e as Error).message };
  }
}

export async function getResults(orgId: string, batchId: string, event: APIGatewayProxyEventV2) {
  const batch = await loadBatch(orgId, batchId);
  const limit = Math.min(Number(event.queryStringParameters?.limit ?? RESULTS_PAGE_DEFAULT), 200);
  const cursor = event.queryStringParameters?.cursor;
  const page = await ddb.send(
    new QueryCommand({
      TableName: env.TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :b',
      ExpressionAttributeValues: { ':b': gsi.batchImages(batchId) },
      Limit: limit,
      ExclusiveStartKey: cursor ? (JSON.parse(Buffer.from(cursor, 'base64url').toString()) as Record<string, unknown>) : undefined,
    }),
  );
  const snapshot = await loadSnapshot(orgId, batch.pipelineId, batch.pipelineVersion);
  const finalStep = snapshot.steps.length;
  const items = [];
  for (const raw of (page.Items ?? []) as ImageItem[]) {
    const entry: Record<string, unknown> = {
      imageId: raw.imageId,
      filename: raw.filename,
      status: raw.status,
      currentStep: raw.currentStep,
    };
    if (raw.status === 'processed') {
      entry.url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: env.BUCKET_NAME, Key: s3key.derived(orgId, batchId, raw.imageId, finalStep) }),
        { expiresIn: 3600 },
      );
    }
    if (raw.error) entry.error = raw.error;
    items.push(entry);
  }
  return json(200, {
    batchId,
    status: batch.status,
    items,
    nextCursor: page.LastEvaluatedKey ? Buffer.from(JSON.stringify(page.LastEvaluatedKey)).toString('base64url') : undefined,
  });
}

// ---- retry and re-upload ----

// A Decision 4: a retry run contains only the failed images. Each one gets
// its sourceETag refreshed (a re-uploaded original has a new ETag, so the
// skip check will recompute rather than reuse stale outputs).
export async function postRetryFailed(orgId: string, batchId: string) {
  const batch = await loadBatch(orgId, batchId);
  if (batch.status !== 'completed') throw new HttpError(409, 'batch_not_completed', `batch is ${batch.status}`);
  await assertOrgCapacity(orgId);

  const images = await listBatchImages(batchId);
  const candidates = images.filter((i) => i.status === 'failed' || i.status === 'missing');
  if (candidates.length === 0) throw new HttpError(400, 'nothing_to_retry', 'no failed or missing images');

  const retrying: ImageItem[] = [];
  const stillMissing: ImageItem[] = [];
  for (const img of candidates) {
    const head = await headObject(s3key.original(orgId, batchId, img.imageId));
    if (!head) {
      stillMissing.push({ ...img, status: 'missing' });
      continue;
    }
    const { error: _dropped, ...rest } = img;
    retrying.push({ ...rest, status: 'uploaded', sourceETag: head.etag, currentStep: 0 });
  }
  if (retrying.length === 0) throw new HttpError(400, 'nothing_to_retry', 'all candidates are missing their original');
  await batchPut([...retrying, ...stillMissing]);

  const snapshot = await loadSnapshot(orgId, batch.pipelineId, batch.pipelineVersion);
  const filterVersions = await buildFilterVersions(snapshot.steps);
  const run = await startRun(orgId, batch, snapshot, filterVersions, retrying);
  return json(202, {
    batchId,
    status: 'running',
    runId: run.runId,
    executionArn: run.executionArn,
    retrying: retrying.map((r) => ({ imageId: r.imageId, filename: r.filename, sourceETag: r.sourceETag })),
    stillMissing: stillMissing.map((m) => ({ imageId: m.imageId, filename: m.filename })),
  });
}

// A fresh presigned POST for one image's original key, for fixing a bad file
// before retry-failed. Allowed while the batch is open or completed.
export async function postReuploadUrl(orgId: string, batchId: string, imageId: string) {
  const batch = await loadBatch(orgId, batchId);
  if (batch.status !== 'open' && batch.status !== 'completed') {
    throw new HttpError(409, 'batch_busy', `batch is ${batch.status}`);
  }
  const res = await ddb.send(
    new GetCommand({ TableName: env.TABLE_NAME, Key: { PK: pk.org(orgId), SK: sk.image(imageId) } }),
  );
  const image = res.Item as ImageItem | undefined;
  if (!image || image.batchId !== batchId) throw new HttpError(404, 'not_found', `image ${imageId} in batch ${batchId}`);
  const key = s3key.original(orgId, batchId, imageId);
  const presigned = await presignUpload(key);
  return json(200, {
    batchId,
    maxBytes: env.MAX_UPLOAD_BYTES,
    expiresInSeconds: UPLOAD_URL_EXPIRY_SECONDS,
    urls: [{ imageId, filename: image.filename, key, url: presigned.url, fields: presigned.fields }],
  });
}

// ---- helpers ----

export async function loadBatch(orgId: string, batchId: string): Promise<BatchItem> {
  const res = await ddb.send(
    new GetCommand({ TableName: env.TABLE_NAME, Key: { PK: pk.org(orgId), SK: sk.batch(batchId) } }),
  );
  if (!res.Item) throw new HttpError(404, 'not_found', `batch ${batchId}`);
  return res.Item as BatchItem;
}

// BatchWrite takes 25 items per call; unprocessed items are retried.
async function batchPut(items: ImageItem[]): Promise<void> {
  for (let i = 0; i < items.length; i += 25) {
    let requests = items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));
    for (let attempt = 0; requests.length > 0 && attempt < 5; attempt += 1) {
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [env.TABLE_NAME]: requests } }));
      requests = (res.UnprocessedItems?.[env.TABLE_NAME] ?? []) as typeof requests;
      if (requests.length) await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
    }
    if (requests.length) throw new Error(`BatchWrite left ${requests.length} unprocessed items`);
  }
}
