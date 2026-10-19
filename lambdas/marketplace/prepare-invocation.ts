// PrepareInvocation (B Decision 2): checks maxBytes, mints the two presigned
// URLs and the invocationId, builds the envelope. Runs in the main account.
// The filter receives URLs, params and a deadline: no org id, no credentials.
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import sharp from 'sharp';
import { env, s3 } from '../shared/clients';
import { recordExecution } from '../shared/ddb';
import { TerminalError } from '../shared/errors';
import { filterKey, invocationIdFor, nowIso, s3key } from '../shared/keys';
import { getObjectBuffer, headObject } from '../shared/s3util';
import type { ChildState, FilterRequest, Invocation } from '../shared/types';

const TASK_TIMEOUT_MARGIN_SEC = 15; // covers a cold start of a multi-GB container
const URL_EXPIRY_MARGIN_SEC = 60;

export const handler = async (event: ChildState & { executionArn?: string }): Promise<{ invocation: Invocation }> => {
  const { orgId, batchId, imageId, stepIndex } = event;
  const step = event.step ?? event.steps[stepIndex];
  if (!step || step.type !== 'marketplace') throw new TerminalError('platform', 'PrepareInvocation needs a marketplace step');
  const ref = event.filterVersions[filterKey(step.filterId, step.version)];
  if (!ref) throw new TerminalError('platform', `no filter version ref for ${step.filterId}@${step.version}`);

  const stepNumber = stepIndex + 1;
  const inputKey = stepIndex === 0 ? s3key.original(orgId, batchId, imageId) : s3key.derived(orgId, batchId, imageId, stepIndex);
  const stagingKey = s3key.staging(orgId, batchId, imageId, stepNumber);
  const outputKey = s3key.derived(orgId, batchId, imageId, stepNumber);

  if (stepIndex === 0 && event.executionArn) await recordExecution(orgId, imageId, event.executionArn);

  const head = await headObject(inputKey);
  if (!head) throw new TerminalError(stepIndex === 0 ? 'input' : 'platform', `missing input ${inputKey}`);
  const { manifest } = ref;
  if (head.size > manifest.input.maxBytes) {
    throw new TerminalError('input', `input is ${head.size} bytes; filter ${ref.filterId} accepts at most ${manifest.input.maxBytes}`);
  }

  // Width/height for the envelope. Decoding the header is cheap; the filter
  // may use it to size buffers before downloading.
  let width: number | undefined;
  let height: number | undefined;
  let contentType = 'application/octet-stream';
  try {
    const { body } = await getObjectBuffer(inputKey);
    const meta = await sharp(body).metadata();
    width = meta.width;
    height = meta.height;
    if (meta.format) contentType = `image/${meta.format}`;
  } catch {
    throw new TerminalError('input', `input ${inputKey} is not a decodable image`);
  }

  const timeoutSec = manifest.limits.timeoutSec;
  const expiresIn = timeoutSec + URL_EXPIRY_MARGIN_SEC;
  const outputContentType = `image/${manifest.output.format}`;
  const inputUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: env.BUCKET_NAME, Key: inputKey }), { expiresIn });
  const outputUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: env.BUCKET_NAME, Key: stagingKey, ContentType: outputContentType }),
    { expiresIn },
  );

  const startedAt = nowIso();
  const payload: FilterRequest = {
    invocationId: invocationIdFor(orgId, batchId, imageId, stepNumber),
    contractVersion: manifest.contractVersion,
    input: { url: inputUrl, contentType, width, height, bytes: head.size },
    output: { url: outputUrl, contentType: outputContentType },
    params: step.params,
    deadline: new Date(Date.now() + timeoutSec * 1000).toISOString(),
  };

  return {
    invocation: {
      invocationId: payload.invocationId,
      attempt: (event.invocation?.attempt ?? 0) + 1,
      functionArn: ref.functionArn,
      filterId: ref.filterId,
      filterVersion: ref.version,
      developerId: ref.developerId,
      taskTimeoutSec: timeoutSec + TASK_TIMEOUT_MARGIN_SEC,
      startedAt,
      inputKey,
      inputETag: head.etag,
      stagingKey,
      outputKey,
      payload,
    },
  };
};
