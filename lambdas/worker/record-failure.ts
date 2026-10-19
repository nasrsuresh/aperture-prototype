// RecordFailure (A Decision 4): the Catch target. Turns the Step Functions
// error object into {step, class, retryable, attempts, message} on the Image
// item. For marketplace steps it also writes the Invocation record from the
// failure path (B Decision 5), so timeouts and filter errors are metered.
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, env } from '../shared/clients';
import { markFailed } from '../shared/ddb';
import { parseClassFromMessage } from '../shared/errors';
import { gsi, nowIso, pk, sk, yyyymm } from '../shared/keys';
import type { ChildState, ErrorClass, ImageError, InvocationItem } from '../shared/types';

// Retry policy in the state machine: 1 initial + 2 retries = 3 attempts.
export const RETRY_ATTEMPTS = 3;

interface LambdaCause {
  errorType?: string;
  errorMessage?: string;
}

export function interpretFailure(failure: { Error: string; Cause: string }, failedState?: string): ImageErrorParts {
  const { Error: errorName, Cause } = failure;
  let cause: LambdaCause = {};
  try {
    cause = JSON.parse(Cause) as LambdaCause;
  } catch {
    cause = { errorMessage: Cause };
  }
  const message = cause.errorMessage ?? Cause ?? errorName;

  // Our classified errors: class is in the message, retryability in the name.
  if (errorName === 'RetryableError' || errorName === 'TerminalError') {
    const retryable = errorName === 'RetryableError';
    return {
      class: parseClassFromMessage(message) ?? 'platform',
      retryable,
      attempts: retryable ? RETRY_ATTEMPTS : 1,
      message,
    };
  }
  // Lambda-level failures (Fact 6): timeout, throttle, service error. They
  // never ran our handler, so no class is in the message. If the state that
  // failed was the marketplace filter, the filter timed out: class `filter`.
  if (errorName.startsWith('Lambda.') || errorName === 'Sandbox.Timedout' || errorName === 'States.Timeout') {
    return {
      class: failedState === 'InvokeFilter' ? 'filter' : 'platform',
      retryable: true,
      attempts: RETRY_ATTEMPTS,
      message: `${errorName}: ${message}`,
    };
  }
  // Anything else raised while invoking the third-party function (a Python
  // exception escaping the handler, say) is the filter's failure.
  if (failedState === 'InvokeFilter') {
    return { class: 'filter', retryable: false, attempts: 1, message: `${errorName}: ${message}` };
  }
  return { class: 'platform', retryable: false, attempts: 1, message: `${errorName}: ${message}` };
}

export type ImageErrorParts = Omit<ImageError, 'step'>;

export const handler = async (event: ChildState) => {
  const { orgId, batchId, imageId, stepIndex } = event;
  const step = event.step ?? event.steps[stepIndex];
  const stepNumber = stepIndex + 1;
  const failure = event.failure ?? { Error: 'Unknown', Cause: 'no failure object in state' };
  const parts = interpretFailure(failure, event.failedState);
  const error: ImageError = { step: stepNumber, ...parts };

  await markFailed(orgId, imageId, error);

  // Marketplace metering from the failure path. Conditional put: never
  // overwrite a record from a successful attempt.
  if (step?.type === 'marketplace' && event.invocation) {
    const inv = event.invocation;
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
      status: 'error',
      errorClass: parts.class as ErrorClass,
      errorMessage: parts.message,
      retryable: parts.retryable,
      billable: false,
      inputETag: inv.inputETag,
      createdAt: nowIso(),
      GSI1PK: gsi.developerMonth(inv.developerId, month),
      GSI1SK: sk.invocation(inv.invocationId),
    };
    try {
      await ddb.send(
        new PutCommand({ TableName: env.TABLE_NAME, Item: item, ConditionExpression: 'attribute_not_exists(SK)' }),
      );
    } catch (e) {
      if ((e as { name?: string }).name !== 'ConditionalCheckFailedException') throw e;
    }
  }

  return { imageId, error };
};
