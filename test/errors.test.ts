// The error taxonomy from A Decision 4: every failure becomes
// {class, retryable}. These tests pin the mapping on both sides: what the
// worker throws, and what RecordFailure reads back from Step Functions.
import { classify, parseClassFromMessage, RetryableError, TerminalError } from '../lambdas/shared/errors';
import { interpretFailure, RETRY_ATTEMPTS } from '../lambdas/worker/record-failure';

describe('classify (worker side)', () => {
  test('a libvips decode error is the customer’s problem: input, terminal', () => {
    const e = classify(new Error('Input buffer contains unsupported image format'));
    expect(e).toBeInstanceOf(TerminalError);
    expect(e.cls).toBe('input');
    expect(e.retryable).toBe(false);
  });

  test('an AWS throttle is ours and transient: platform, retryable', () => {
    const err = Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
    const e = classify(err);
    expect(e).toBeInstanceOf(RetryableError);
    expect(e.cls).toBe('platform');
    expect(e.retryable).toBe(true);
  });

  test('an already-classified error passes through unchanged', () => {
    const original = new TerminalError('filter', 'reported ok but wrote no output');
    expect(classify(original)).toBe(original);
  });

  test('the class rides in the message so it survives the Lambda -> Step Functions hop', () => {
    const e = new RetryableError('platform', 'fail-inject: transient failure, attempt 1');
    expect(e.name).toBe('RetryableError'); // this is what Retry/Catch match on
    expect(e.message).toBe('platform: fail-inject: transient failure, attempt 1');
    expect(parseClassFromMessage(e.message)).toBe('platform');
  });
});

describe('interpretFailure (RecordFailure side)', () => {
  const cause = (errorType: string, errorMessage: string) => JSON.stringify({ errorType, errorMessage, trace: [] });

  test('TerminalError from our code: not retried, one attempt, class from message', () => {
    const r = interpretFailure({ Error: 'TerminalError', Cause: cause('TerminalError', 'input: unsupported image format') });
    expect(r).toEqual({ class: 'input', retryable: false, attempts: 1, message: 'input: unsupported image format' });
  });

  test('RetryableError that exhausted its retries: 3 attempts recorded', () => {
    const r = interpretFailure({ Error: 'RetryableError', Cause: cause('RetryableError', 'platform: fail-inject, attempt 3') });
    expect(r.retryable).toBe(true);
    expect(r.attempts).toBe(RETRY_ATTEMPTS);
    expect(r.class).toBe('platform');
  });

  test('a Lambda timeout on a first-party step is a platform failure', () => {
    const r = interpretFailure({ Error: 'Sandbox.Timedout', Cause: 'Task timed out after 900.00 seconds' }, 'RunStep');
    expect(r.class).toBe('platform');
    expect(r.retryable).toBe(true);
    expect(r.attempts).toBe(RETRY_ATTEMPTS);
  });

  test('the same timeout on InvokeFilter is the third-party filter’s failure', () => {
    const r = interpretFailure({ Error: 'States.Timeout', Cause: 'The task timed out' }, 'InvokeFilter');
    expect(r.class).toBe('filter');
    expect(r.retryable).toBe(true);
  });

  test('an unknown error name is recorded as platform, not retried', () => {
    const r = interpretFailure({ Error: 'States.Runtime', Cause: 'something odd' });
    expect(r).toMatchObject({ class: 'platform', retryable: false, attempts: 1 });
  });
});
