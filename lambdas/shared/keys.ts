// Key builders. Every DynamoDB key and S3 key in the system is made here so
// the layout in the submission is the layout in the code.
import { createHash, randomBytes } from 'node:crypto';

export const SINGLE_BATCH = 'single'; // batchId used by POST /images marketplace requests

export const pk = {
  org: (orgId: string) => `ORG#${orgId}`,
  orgMonth: (orgId: string, yyyymm: string) => `ORG#${orgId}#${yyyymm}`,
  filter: (filterId: string) => `FILTER#${filterId}`,
};

export const sk = {
  batch: (batchId: string) => `BATCH#${batchId}`,
  image: (imageId: string) => `IMAGE#${imageId}`,
  pipeline: (pipelineId: string) => `PIPELINE#${pipelineId}`,
  pipelineVersion: (pipelineId: string, version: number) => `PIPELINE#${pipelineId}#V#${version}`,
  entitlement: (filterId: string) => `ENTITLEMENT#${filterId}`,
  policy: () => 'POLICY',
  filterVersion: (version: string) => `V#${version}`,
  invocation: (invocationId: string) => `INVOCATION#${invocationId}`,
  chaos: (batchId: string, imageId: string, step: number) => `CHAOS#${batchId}#${imageId}#${step}`,
};

export const gsi = {
  batchImages: (batchId: string) => `BATCH#${batchId}`, // GSI1PK
  orgBatches: (orgId: string) => `ORG#${orgId}`, // GSI2PK
  batchStatus: (status: string, createdAt: string) => `STATUS#${status}#${createdAt}`, // GSI2SK
  developerMonth: (developerId: string, yyyymm: string) => `DEV#${developerId}#${yyyymm}`, // GSI1PK for Invocation
};

export const s3key = {
  original: (orgId: string, batchId: string, imageId: string) => `${orgId}/${batchId}/originals/${imageId}`,
  originalsPrefix: (orgId: string, batchId: string) => `${orgId}/${batchId}/originals/`,
  derived: (orgId: string, batchId: string, imageId: string, step: number) =>
    `${orgId}/${batchId}/derived/${imageId}/${step}`,
  // Where a marketplace filter writes; ValidateOutput re-encodes to `derived`.
  staging: (orgId: string, batchId: string, imageId: string, step: number) =>
    `${orgId}/${batchId}/staging/${imageId}/${step}`,
  manifest: (orgId: string, batchId: string, runId: string) => `${orgId}/${batchId}/manifests/${runId}.json`,
  // Baseline single-image path keeps its own prefix.
  singleOriginal: (orgId: string, imageId: string) => `${orgId}/single/${imageId}/original`,
  singleProcessed: (orgId: string, imageId: string) => `${orgId}/single/${imageId}/processed`,
};

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function yyyymm(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}

// B Decision 2: invocationId derived from image and step; the attempt is a
// separate attribute. Same inputs, same id, so a retried step bills once.
export function invocationIdFor(orgId: string, batchId: string, imageId: string, step: number): string {
  return createHash('sha256').update(`${orgId}|${batchId}|${imageId}|${step}`).digest('hex').slice(0, 32);
}

export function filterKey(filterId: string, version: string): string {
  return `${filterId}@${version}`;
}
