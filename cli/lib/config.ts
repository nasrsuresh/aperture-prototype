// Reads the deployed stack's outputs (written by `npm run deploy`) and the
// caller identity for the API.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Config {
  apiUrl: string;
  bucket: string;
  table: string;
  maxUploadBytes: number;
  orgId: string;
  apiKey: string;
  outputs: Record<string, string>; // every stack output, for ad-hoc lookups
}

export function loadConfig(): Config {
  const path = resolve(process.cwd(), 'outputs.json');
  if (!existsSync(path)) throw new Error(`outputs.json not found; run \`npm run deploy\` first`);
  const outputs = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, string>>;
  const stack = outputs.AperturePrototypeStack;
  if (!stack) throw new Error('AperturePrototypeStack not in outputs.json');
  return {
    apiUrl: stack.ApiUrl,
    bucket: stack.BucketName,
    table: stack.TableName,
    maxUploadBytes: Number(stack.MaxUploadBytes),
    orgId: process.env.APERTURE_ORG ?? 'acme',
    apiKey: process.env.APERTURE_API_KEY ?? 'dev-key',
    outputs: stack,
  };
}
