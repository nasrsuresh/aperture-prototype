// Shapes of the data this system stores and passes around. One DynamoDB
// table; every item has PK/SK plus a `type` discriminator. Field names follow
// the submission.

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
  createdAt: string;
}

export interface PipelineItem extends BaseItem {
  type: 'Pipeline';
  orgId: string;
  pipelineId: string;
  name: string;
  version: number; // counter; the latest snapshot number
  steps: PipelineStep[]; // editable copy; execution never reads this
  updatedAt: string;
}

export interface PipelineVersionItem extends BaseItem {
  type: 'PipelineVersion';
  orgId: string;
  pipelineId: string;
  version: number;
  steps: PipelineStep[];
}

export interface BatchCounts {
  total: number;
  succeeded: number;
  failed: number;
}

export interface BatchItem extends BaseItem {
  type: 'Batch';
  orgId: string;
  batchId: string;
  pipelineId: string;
  pipelineVersion: number;
  declaredCount: number;
  status: BatchStatus;
  // GSI2: batches by organization and status, for the per-org running cap.
  GSI2PK: string; // ORG#<o>
  GSI2SK: string; // STATUS#<status>#<createdAt>
  executionArn?: string;
  runId?: string;
  counts?: BatchCounts;
  uploadedCount?: number;
  missingCount?: number;
  // B Decision 5: a batch runs with the entitlements and price terms it was
  // admitted with.
  admittedEntitlements?: Record<string, PriceTerms>;
  submittedAt?: string;
  completedAt?: string;
}

export interface ImageItem extends BaseItem {
  type: 'Image';
  orgId: string;
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
  stepCount?: number;
  sourceETag?: string;
  executionArn?: string;
  error?: ImageError;
  completedAt?: string;
  // GSI1: images by batch, for per-image status listing.
  GSI1PK?: string; // BATCH#<b>
  GSI1SK?: string; // IMAGE#<i>
}

// ---- Scenario B ----

// Mirrors the submission's filter.json. `params` is a JSON Schema subset:
// object properties with type/minimum/maximum/default, plus required.
export interface FilterManifest {
  name: string;
  version: string;
  contractVersion: number;
  params: {
    properties: Record<string, { type: 'number' | 'string'; minimum?: number; maximum?: number; default?: unknown }>;
    required?: string[];
  };
  input: { formats: string[]; maxBytes: number };
  output: { format: 'jpeg' | 'png'; maxBytes?: number };
  limits: { timeoutSec: number; memoryMb: number };
}

export type FilterVersionState = 'preview' | 'published' | 'deprecated' | 'retired' | 'suspended';

// FILTER#<filterId> / V#<version>. Global, not per organization.
export interface FilterVersionItem extends BaseItem {
  type: 'FilterVersion';
  filterId: string;
  version: string;
  developerId: string;
  functionArn: string;
  imageDigest: string;
  state: FilterVersionState;
  manifest: FilterManifest;
}

export interface PriceTerms {
  perInvocationCents: number;
  developerShare: number; // 0..1
}

// ORG#<o> / ENTITLEMENT#<filterId>
export interface EntitlementItem extends BaseItem {
  type: 'Entitlement';
  orgId: string;
  filterId: string;
  priceTerms: PriceTerms;
}

// ORG#<o> / POLICY
export interface OrgPolicyItem extends BaseItem {
  type: 'OrgPolicy';
  orgId: string;
  allowThirdPartyFilters: boolean;
  updatedAt: string;
}

// ORG#<o>#<yyyy-mm> / INVOCATION#<invocationId>, GSI1 by developer and month.
export interface InvocationItem extends BaseItem {
  type: 'Invocation';
  invocationId: string;
  orgId: string;
  batchId: string;
  imageId: string;
  step: number;
  filterId: string;
  filterVersion: string;
  developerId: string;
  attempt: number;
  startedAt: string;
  durationMs: number;
  status: 'ok' | 'error';
  errorClass?: ErrorClass;
  errorMessage?: string;
  retryable?: boolean;
  billable: boolean;
  inputETag?: string;
  outputETag?: string;
  GSI1PK: string; // DEV#<developerId>#<yyyy-mm>
  GSI1SK: string; // INVOCATION#<invocationId>
}

export type AnyItem =
  | PipelineItem
  | PipelineVersionItem
  | BatchItem
  | ImageItem
  | FilterVersionItem
  | EntitlementItem
  | OrgPolicyItem
  | InvocationItem;

// ---- Step Functions payloads ----

// What the child workflow carries. The parent's ItemSelector builds it from
// the manifest entry plus the batch-level fields; the single-image
// marketplace path builds the same object for one image.
export interface ChildState {
  orgId: string;
  batchId: string; // 'single' for POST /images marketplace requests
  imageId: string;
  sourceETag: string;
  runId: string;
  steps: PipelineStep[];
  stepCount: number;
  stepIndex: number; // 0-based; stepNumber = stepIndex + 1
  filterVersions: Record<string, FilterVersionRef>; // key `${filterId}@${version}`
  // Set by SelectStep
  step?: PipelineStep;
  // Set by PrepareInvocation (marketplace branch)
  invocation?: Invocation;
  // Set by InvokeFilter
  filterResult?: FilterResponse;
  // Set by Catch
  failure?: { Error: string; Cause: string };
  failedState?: string;
  lastResult?: unknown;
}

export interface FilterVersionRef {
  filterId: string;
  version: string;
  developerId: string;
  functionArn: string;
  manifest: FilterManifest;
}

// The envelope from B Decision 2.
export interface FilterRequest {
  invocationId: string;
  contractVersion: number;
  input: { url: string; contentType: string; width?: number; height?: number; bytes: number };
  output: { url: string; contentType: string };
  params: Record<string, unknown>;
  deadline: string;
}

export type FilterResponse =
  | { status: 'ok'; output?: { width: number; height: number; bytes: number }; metrics?: Record<string, unknown> }
  | { status: 'error'; error: { code: string; message: string; retryable: boolean }; metrics?: Record<string, unknown> };

export interface Invocation {
  invocationId: string;
  attempt: number;
  functionArn: string;
  filterId: string;
  filterVersion: string;
  developerId: string;
  taskTimeoutSec: number;
  startedAt: string;
  inputKey: string;
  inputETag: string;
  stagingKey: string;
  outputKey: string;
  payload: FilterRequest;
}

export interface RunStepResult {
  outputKey: string;
  skipped: boolean;
  advance: 'advanced' | 'duplicate';
}
