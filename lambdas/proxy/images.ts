// Baseline POST /images: the MVP path from the prompt. Image arrives base64
// in JSON, one filter runs in-process, result is written to S3, Image item
// goes uploaded -> processed, 200 with a URL. Nothing here changes for the
// batch work; it exists so the prototype has the real thing to compare with.
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, env, s3 } from '../shared/clients';
import { getFilter, runFirstPartyFilter, validateParams } from '../shared/filters';
import { HttpError, json, parseBody } from '../shared/http';
import { newId, nowIso, pk, s3key, sk } from '../shared/keys';
import type { ImageItem } from '../shared/types';

interface PostImageBody {
  image: string; // base64
  filterId: string;
  params?: Record<string, unknown>;
}

export async function postImage(orgId: string, event: APIGatewayProxyEventV2) {
  const body = parseBody<PostImageBody>(event);
  if (!body.image || typeof body.image !== 'string') throw new HttpError(400, 'bad_image', 'image (base64) required');
  const def = getFilter(body.filterId);
  const params = validateParams(def, body.params);

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

  const output = await runFirstPartyFilter({ type: 'first_party', filterId: def.id, version: def.version, params }, bytes);
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
