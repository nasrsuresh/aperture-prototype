// A Decision 1: POST /batches creates a Batch with the pipeline version pinned
// and the declared count. POST /batches/{id}/upload-urls takes a page of up to
// 100 filenames and returns one presigned POST per image, each with a
// content-length-range policy, a one-hour expiry, and an Image item in
// pending_upload. Zero image bytes pass through this function.
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { BatchWriteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, env, s3 } from '../shared/clients';
import { HttpError, json, parseBody } from '../shared/http';
import { gsi, newId, nowIso, pk, s3key, sk } from '../shared/keys';
import type { BatchItem, ImageItem, ImageStatus } from '../shared/types';
import { loadSnapshot } from './pipelines';

const UPLOAD_URL_PAGE = 100;
const UPLOAD_URL_EXPIRY_SECONDS = 3600;

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
  await loadSnapshot(orgId, body.pipelineId, body.pipelineVersion);

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

    // The policy is the server-side size check. S3 evaluates it; the client
    // cannot loosen it because the policy is signed. Expiry applies to when
    // the upload starts, and the client asks for pages as it goes.
    const presigned = await createPresignedPost(s3, {
      Bucket: env.BUCKET_NAME,
      Key: key,
      Conditions: [['content-length-range', 1, env.MAX_UPLOAD_BYTES]],
      Expires: UPLOAD_URL_EXPIRY_SECONDS,
    });

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

  // BatchWrite takes 25 items per call.
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    await ddb.send(
      new BatchWriteCommand({
        RequestItems: { [env.TABLE_NAME]: chunk.map((Item) => ({ PutRequest: { Item } })) },
      }),
    );
  }

  return json(200, {
    batchId,
    maxBytes: env.MAX_UPLOAD_BYTES,
    expiresInSeconds: UPLOAD_URL_EXPIRY_SECONDS,
    urls,
  });
}

export async function getBatch(orgId: string, batchId: string) {
  const batch = await loadBatch(orgId, batchId);
  const counts = await countImagesByStatus(batchId);
  return json(200, {
    batchId: batch.batchId,
    status: batch.status,
    pipeline: `${batch.pipelineId}@${batch.pipelineVersion}`,
    declaredCount: batch.declaredCount,
    images: counts,
    counts: batch.counts,
    executionArn: batch.executionArn,
    createdAt: batch.createdAt,
    submittedAt: batch.submittedAt,
    completedAt: batch.completedAt,
  });
}

export async function loadBatch(orgId: string, batchId: string): Promise<BatchItem> {
  const res = await ddb.send(
    new GetCommand({ TableName: env.TABLE_NAME, Key: { PK: pk.org(orgId), SK: sk.batch(batchId) } }),
  );
  if (!res.Item) throw new HttpError(404, 'not_found', `batch ${batchId}`);
  return res.Item as BatchItem;
}

// Per-image status via GSI1 (images by batch). Eventually consistent; good
// enough for a progress view.
async function countImagesByStatus(batchId: string): Promise<Record<ImageStatus, number> & { total: number }> {
  const counts: Record<string, number> = { total: 0 };
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: env.TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :b',
        ExpressionAttributeValues: { ':b': gsi.batchImages(batchId) },
        ProjectionExpression: '#s',
        ExpressionAttributeNames: { '#s': 'status' },
        ExclusiveStartKey,
      }),
    );
    for (const it of page.Items ?? []) {
      const s = (it as { status: string }).status;
      counts[s] = (counts[s] ?? 0) + 1;
      counts.total += 1;
    }
    ExclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return counts as Record<ImageStatus, number> & { total: number };
}
