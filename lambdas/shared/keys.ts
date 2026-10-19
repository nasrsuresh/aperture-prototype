// Key builders. Every DynamoDB key and S3 key in the system is made here so
// the layout in the submission is the layout in the code.
import { randomBytes } from 'node:crypto';

export const pk = {
  org: (orgId: string) => `ORG#${orgId}`,
};

export const sk = {
  batch: (batchId: string) => `BATCH#${batchId}`,
  image: (imageId: string) => `IMAGE#${imageId}`,
  pipeline: (pipelineId: string) => `PIPELINE#${pipelineId}`,
  pipelineVersion: (pipelineId: string, version: number) => `PIPELINE#${pipelineId}#V#${version}`,
};

export const gsi = {
  batchImages: (batchId: string) => `BATCH#${batchId}`, // GSI1PK
  orgBatches: (orgId: string) => `ORG#${orgId}`, // GSI2PK
  batchStatus: (status: string, createdAt: string) => `STATUS#${status}#${createdAt}`, // GSI2SK
};

export const s3key = {
  original: (orgId: string, batchId: string, imageId: string) => `${orgId}/${batchId}/originals/${imageId}`,
  originalsPrefix: (orgId: string, batchId: string) => `${orgId}/${batchId}/originals/`,
  derived: (orgId: string, batchId: string, imageId: string, step: number) =>
    `${orgId}/${batchId}/derived/${imageId}/${step}`,
  manifest: (orgId: string, batchId: string) => `${orgId}/${batchId}/manifest.json`,
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
