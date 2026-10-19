import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { env, s3 } from './clients';

export interface ObjectInfo {
  etag: string;
  size: number;
  metadata: Record<string, string>;
}

// HeadObject that returns null for 404 instead of throwing.
export async function headObject(key: string): Promise<ObjectInfo | null> {
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: env.BUCKET_NAME, Key: key }));
    return { etag: stripQuotes(res.ETag), size: res.ContentLength ?? 0, metadata: res.Metadata ?? {} };
  } catch (e) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

export async function getObjectBuffer(key: string): Promise<{ body: Buffer; etag: string }> {
  const res = await s3.send(new GetObjectCommand({ Bucket: env.BUCKET_NAME, Key: key }));
  const body = Buffer.from(await res.Body!.transformToByteArray());
  return { body, etag: stripQuotes(res.ETag) };
}

export interface PutOptions {
  contentType?: string;
  metadata?: Record<string, string>;
  intermediate?: boolean; // tag for the lifecycle rule
}

export async function putObjectBuffer(key: string, body: Buffer, opts: PutOptions = {}): Promise<string> {
  const res = await s3.send(
    new PutObjectCommand({
      Bucket: env.BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: opts.contentType,
      Metadata: opts.metadata,
      Tagging: opts.intermediate ? 'intermediate=true' : undefined,
    }),
  );
  return stripQuotes(res.ETag);
}

export async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: env.BUCKET_NAME, Key: key }));
}

// List every object under a prefix: key -> etag. Paginates.
export async function listPrefix(prefix: string): Promise<Map<string, { etag: string; size: number }>> {
  const out = new Map<string, { etag: string; size: number }>();
  let ContinuationToken: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: env.BUCKET_NAME, Prefix: prefix, ContinuationToken }),
    );
    for (const o of page.Contents ?? []) {
      if (o.Key) out.set(o.Key, { etag: stripQuotes(o.ETag), size: o.Size ?? 0 });
    }
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return out;
}

export function stripQuotes(etag?: string): string {
  return (etag ?? '').replace(/^"|"$/g, '');
}

// Metadata key under which every derived object records the ETag of the
// original it was computed from. The skip check in RunStep compares it.
export const SOURCE_ETAG_META = 'source-etag';
