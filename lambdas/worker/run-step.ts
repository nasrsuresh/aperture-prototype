// RunStep for first-party steps (A Decision 2). Reads step n-1's output,
// runs the filter, writes derived/{imageId}/{n}, advances currentStep with a
// conditional update. Skips the step when its output already exists for the
// same sourceETag (A Decision 4). Every error leaves here classified.
import { env } from '../shared/clients';
import { advanceStep, getImage, recordExecution } from '../shared/ddb';
import { TerminalError, classify } from '../shared/errors';
import { runFirstPartyFilter } from '../shared/filters';
import { SINGLE_BATCH, s3key } from '../shared/keys';
import { SOURCE_ETAG_META, getObjectBuffer, headObject, putObjectBuffer } from '../shared/s3util';
import type { ChildState, RunStepResult } from '../shared/types';
import { decideSkip } from './skip';

export const handler = async (event: ChildState & { executionArn?: string }): Promise<RunStepResult> => {
  const { orgId, batchId, imageId, sourceETag, stepIndex, stepCount } = event;
  const step = event.step ?? event.steps[stepIndex];
  if (!step) throw new TerminalError('platform', `no step at index ${stepIndex}`);
  if (step.type !== 'first_party') throw new TerminalError('platform', `RunStep got a ${step.type} step`);

  const stepNumber = stepIndex + 1;
  const isLast = stepNumber === stepCount;
  const outputKey = s3key.derived(orgId, batchId, imageId, stepNumber);
  const inputKey = stepIndex === 0 ? s3key.original(orgId, batchId, imageId) : s3key.derived(orgId, batchId, imageId, stepIndex);

  if (stepIndex === 0 && event.executionArn) await recordExecution(orgId, imageId, event.executionArn);

  // Checkpoint resume.
  const existing = await headObject(outputKey);
  const decision = decideSkip(existing, sourceETag, env.SKIP_CHECK_IGNORES_ETAG);
  console.log(JSON.stringify({ imageId, stepNumber, filter: step.filterId, skipDecision: decision }));
  if (decision.skip) {
    const advance = await advanceStep(orgId, imageId, stepNumber, isLast);
    return { outputKey, skipped: true, advance };
  }

  // Read input. A missing or unreadable prior output is ours (`platform`).
  let input: Buffer;
  try {
    input = (await getObjectBuffer(inputKey)).body;
  } catch (e) {
    const err = e as { name?: string };
    if (err.name === 'NoSuchKey') {
      throw new TerminalError(stepIndex === 0 ? 'input' : 'platform', `missing ${stepIndex === 0 ? 'original' : 'prior step output'} ${inputKey}`);
    }
    throw classify(e);
  }

  const image = batchId === SINGLE_BATCH ? null : await getImage(orgId, imageId);
  const output = await runFirstPartyFilter(step, input, {
    orgId,
    batchId,
    imageId,
    filename: image?.filename,
    stepNumber,
  });

  await putObjectBuffer(outputKey, output, {
    contentType: 'image/jpeg',
    metadata: { [SOURCE_ETAG_META]: sourceETag, step: String(stepNumber), filter: step.filterId },
    intermediate: !isLast,
  });

  const advance = await advanceStep(orgId, imageId, stepNumber, isLast);
  return { outputKey, skipped: false, advance };
};
