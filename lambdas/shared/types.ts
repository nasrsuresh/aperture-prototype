// Shapes of the data this system stores. One DynamoDB table; every item has
// PK/SK plus a `type` discriminator. Field names follow the submission.

export type StepType = 'first_party' | 'marketplace';

export interface PipelineStep {
  type: StepType;
  filterId: string;
  version: string;
  params: Record<string, unknown>;
}

// What a batch pins and what each child workflow receives as input.
// Immutable once written (PIPELINE#<p>#V#<n>).
export interface PipelineSnapshot {
  pipelineId: string;
  version: number;
  steps: PipelineStep[];
}

export type BatchStatus = 'open' | 'submitted' | 'running' | 'completed';

// Baseline Image has only {uploaded, processed}. The batch path adds the rest;
// all new fields are optional so existing items are untouched (A Decision 6).
export type ImageStatus =
  | 'uploaded'
  | 'processed'
  | 'pending_upload'
  | 'missing'
  | 'processing'
  | 'failed';

export type ErrorClass = 'input' | 'platform' | 'filter';

export interface ImageError {
  step: number;
  class: ErrorClass;
  retryable: boolean;
  attempts: number;
  message: string;
}

interface BaseItem {
  PK: string;
  SK: string;
  orgId: string;
  createdAt: string;
}

export interface PipelineItem extends BaseItem {
  type: 'Pipeline';
  pipelineId: string;
  name: string;
  version: number; // counter; the latest snapshot number
  steps: PipelineStep[]; // editable copy; execution never reads this
  updatedAt: string;
}

export interface PipelineVersionItem extends BaseItem {
  type: 'PipelineVersion';
  pipelineId: string;
  version: number;
  steps: PipelineStep[];
}

export interface BatchItem extends BaseItem {
  type: 'Batch';
  batchId: string;
  pipelineId: string;
  pipelineVersion: number;
  declaredCount: number;
  status: BatchStatus;
  // GSI2: batches by organization and status, for the per-org running cap.
  GSI2PK: string; // ORG#<o>
  GSI2SK: string; // STATUS#<status>#<createdAt>
  executionArn?: string;
  counts?: { total: number; succeeded: number; failed: number };
  submittedAt?: string;
  completedAt?: string;
}

export interface ImageItem extends BaseItem {
  type: 'Image';
  imageId: string;
  status: ImageStatus;
  // Baseline single-image fields
  filterId?: string;
  originalKey?: string;
  processedKey?: string;
  // Batch-path fields (all optional)
  batchId?: string;
  filename?: string;
  currentStep?: number;
  sourceETag?: string;
  executionArn?: string;
  error?: ImageError;
  // GSI1: images by batch, for per-image status listing.
  GSI1PK?: string; // BATCH#<b>
  GSI1SK?: string; // IMAGE#<i>
}

export type AnyItem = PipelineItem | PipelineVersionItem | BatchItem | ImageItem;
