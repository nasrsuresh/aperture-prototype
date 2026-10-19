// ValidateOutput (B Decision 2): platform-owned, runs inside the no-egress
// VPC. The filter's self-reported status never decides success. Checks that
// the staging object exists and matches the declared format and size bounds,
// decodes it, re-encodes it to the step's output key, advances the Image, and
// writes the Invocation record (B Decision 5) with a conditional put.
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import sharp from 'sharp';
import { ddb, env } from '../shared/clients';
import { advanceStep } from '../shared/ddb';
import { TerminalError, classify } from '../shared/errors';
import { filterKey, gsi, nowIso, pk, sk, yyyymm } from '../shared/keys';
import { SOURCE_ETAG_META, getObjectBuffer, headObject, putObjectBuffer } from '../shared/s3util';
import type { ChildState, InvocationItem } from '../shared/types';

const DEFAULT_OUTPUT_MAX_BYTES = 50 * 1024 * 1024;

export const handler = async (event: ChildState) => {
  const { orgId, batchId, imageId, stepIndex, stepCount, sourceETag } = event;
  const inv = event.invocation;
  const step = event.step ?? event.steps[stepIndex];
  if (!inv || !step) throw new TerminalError('platform', 'ValidateOutput needs invocation and step');
  const ref = event.filterVersions[filterKey(step.filterId, step.version)];
  const stepNumber = stepIndex + 1;
  const isLast = stepNumber === stepCount;

  // 1. The filter's response is structured; an error response is the
  //    filter's failure, classified `filter`. (Prototype simplification: a
  //    filter-reported retryable error is not re-invoked; it is recorded with
  //    its retryable flag. Lambda-level failures of the filter are retried by
  //    the state machine's Retry on InvokeFilter.)
  const res = event.filterResult;
  if (!res || typeof res !== 'object' || !('status' in res)) {
    throw new TerminalError('filter', 'malformed response: no status');
  }
  if (res.status === 'error') {
    throw new TerminalError('filter', `${res.error?.code ?? 'error'}: ${res.error?.message ?? 'no message'}`);
  }
  if ((res as { status: string }).status !== 'ok') {
    throw new TerminalError('filter', `malformed response: status ${String((res as { status: string }).status)}`);
  }

  // 2. "The filter said ok" versus "there is a valid image".
  const head = await headObject(inv.stagingKey);
  if (!head) throw new TerminalError('filter', 'reported ok but wrote no output object');
  const maxBytes = ref?.manifest.output.maxBytes ?? DEFAULT_OUTPUT_MAX_BYTES;
  if (head.size === 0 || head.size > maxBytes) {
    throw new TerminalError('filter', `output size ${head.size} outside (0, ${maxBytes}]`);
  }

  // 3. Decode untrusted bytes here, inside the isolated boundary, and
  //    re-encode so downstream only ever parses platform-encoded bytes.
  let output: Buffer;
  let outputETag: string;
  try {
    const { body } = await getObjectBuffer(inv.stagingKey);
    const meta = await sharp(body).metadata();
    const declared = ref?.manifest.output.format ?? 'jpeg';
    if (meta.format !== declared) {
      throw new TerminalError('filter', `output format ${meta.format ?? 'unknown'} does not match declared ${declared}`);
    }
    output = await sharp(body).jpeg({ quality: 90 }).toBuffer();
  } catch (e) {
    if (e instanceof TerminalError) throw e;
    // A libvips decode failure on the filter's output is the filter's fault.
    throw new TerminalError('filter', `output is not a decodable image: ${(e as Error).message}`);
  }
  try {
    outputETag = await putObjectBuffer(inv.outputKey, output, {
      contentType: 'image/jpeg',
      metadata: { [SOURCE_ETAG_META]: sourceETag, step: String(stepNumber), filter: `${step.filterId}@${step.version}` },
      intermediate: !isLast,
    });
    // The raw filter output stays in staging/ (the prototype keeps it so a
    // duplicate ValidateOutput can be replayed in E10; the design expires it).
  } catch (e) {
    throw classify(e);
  }

  const advance = await advanceStep(orgId, imageId, stepNumber, isLast);

  // 4. Metering. Keyed on invocationId = (org, batch, image, step); the
  //    attempt is an attribute. A duplicate attempt hits the condition and is
  //    treated as success: a retried-but-successful step bills once.
  const month = yyyymm();
  const item: InvocationItem = {
    PK: pk.orgMonth(orgId, month),
    SK: sk.invocation(inv.invocationId),
    type: 'Invocation',
    invocationId: inv.invocationId,
    orgId,
    batchId,
    imageId,
    step: stepNumber,
    filterId: inv.filterId,
    filterVersion: inv.filterVersion,
    developerId: inv.developerId,
    attempt: inv.attempt,
    startedAt: inv.startedAt,
    durationMs: Date.now() - Date.parse(inv.startedAt),
    status: 'ok',
    billable: true,
    inputETag: inv.inputETag,
    outputETag,
    createdAt: nowIso(),
    GSI1PK: gsi.developerMonth(inv.developerId, month),
    GSI1SK: sk.invocation(inv.invocationId),
  };
  let metering: 'recorded' | 'duplicate' = 'recorded';
  try {
    await ddb.send(
      new PutCommand({ TableName: env.TABLE_NAME, Item: item, ConditionExpression: 'attribute_not_exists(SK)' }),
    );
  } catch (e) {
    if ((e as { name?: string }).name !== 'ConditionalCheckFailedException') throw classify(e);
    metering = 'duplicate';
  }

  return { outputKey: inv.outputKey, skipped: false, advance, invocationId: inv.invocationId, metering, filterMetrics: res.metrics };
};
