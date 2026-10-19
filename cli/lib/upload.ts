// The client side of A Decision 1: request presigned POSTs in pages, upload
// with a bounded pool (about six in flight, the per-origin connection limit),
// retry per file. Each file succeeds or fails on its own.
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { api } from './api';
import type { Config } from './config';

export interface PresignedPost {
  imageId: string;
  filename: string;
  key: string;
  url: string;
  fields: Record<string, string>;
}

export interface UploadResult {
  imageId: string;
  filename: string;
  bytes: number;
  ok: boolean;
  status: number;
  etag?: string;
  error?: string;
  attempts: number;
}

const PAGE = 100;
const POOL = 6;
const MAX_ATTEMPTS = 3;

export async function requestUploadUrls(cfg: Config, batchId: string, filenames: string[]): Promise<PresignedPost[]> {
  const all: PresignedPost[] = [];
  for (let i = 0; i < filenames.length; i += PAGE) {
    const page = filenames.slice(i, i + PAGE);
    const r = await api<{ urls: PresignedPost[]; code?: string; message?: string }>(
      cfg,
      'POST',
      `/batches/${batchId}/upload-urls`,
      { filenames: page },
    );
    if (r.status !== 200) throw new Error(`upload-urls failed: ${r.status} ${JSON.stringify(r.body)}`);
    all.push(...r.body.urls);
  }
  return all;
}

// One presigned POST: multipart/form-data with the policy fields first and the
// file last (S3 requires `file` to be the final field).
export async function postOne(p: PresignedPost, bytes: Buffer): Promise<{ status: number; etag?: string; text: string }> {
  const form = new FormData();
  for (const [k, v] of Object.entries(p.fields)) form.append(k, v);
  form.append('file', new Blob([bytes]), p.filename);
  const res = await fetch(p.url, { method: 'POST', body: form });
  const text = await res.text();
  return { status: res.status, etag: res.headers.get('etag') ?? undefined, text };
}

// Re-upload one image under its existing imageId (fix a bad file, then
// retry-failed). Returns the presigned POST from the per-image route.
export async function requestReuploadUrl(cfg: Config, batchId: string, imageId: string): Promise<PresignedPost> {
  const r = await api<{ urls: PresignedPost[] }>(cfg, 'POST', `/batches/${batchId}/images/${imageId}/upload-url`);
  if (r.status !== 200) throw new Error(`upload-url failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.urls[0];
}

export async function uploadFiles(
  cfg: Config,
  batchId: string,
  paths: string[],
  presignedOverride?: PresignedPost[],
): Promise<UploadResult[]> {
  const filenames = paths.map((p) => basename(p));
  const presigned = presignedOverride ?? (await requestUploadUrls(cfg, batchId, filenames));
  const byName = new Map(presigned.map((p) => [p.filename, p]));

  const queue = [...paths];
  const results: UploadResult[] = [];

  async function worker(): Promise<void> {
    while (queue.length) {
      const path = queue.shift()!;
      const p = byName.get(basename(path))!;
      const bytes = readFileSync(path);
      let attempts = 0;
      let last: { status: number; etag?: string; text: string } | undefined;
      while (attempts < MAX_ATTEMPTS) {
        attempts += 1;
        try {
          last = await postOne(p, bytes);
          // 4xx is a policy or request problem; retrying will not change it.
          if (last.status < 500) break;
        } catch (e) {
          last = { status: 0, text: String(e) };
        }
        await new Promise((r) => setTimeout(r, 200 * 2 ** attempts));
      }
      const ok = last !== undefined && last.status >= 200 && last.status < 300;
      results.push({
        imageId: p.imageId,
        filename: p.filename,
        bytes: statSync(path).size,
        ok,
        status: last?.status ?? 0,
        etag: last?.etag,
        error: ok ? undefined : summarizeS3Error(last?.text ?? ''),
        attempts,
      });
    }
  }

  await Promise.all(Array.from({ length: Math.min(POOL, paths.length) }, worker));
  return results;
}

// S3 returns XML; pull out <Code> and <Message>.
export function summarizeS3Error(xml: string): string {
  const code = /<Code>([^<]+)<\/Code>/.exec(xml)?.[1];
  const msg = /<Message>([^<]+)<\/Message>/.exec(xml)?.[1];
  return code ? `${code}: ${msg ?? ''}` : xml.slice(0, 200);
}
