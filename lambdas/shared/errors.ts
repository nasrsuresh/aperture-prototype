// The error taxonomy from A Decision 4: every error is {class, retryable}.
// `class`: input = the customer's file or params; platform = our code or
// infrastructure; filter = a marketplace filter's own failure (Scenario B).
//
// `this.name` is what Lambda reports as `errorType`, and what Step Functions
// matches in Retry/Catch `ErrorEquals`. That string is the contract between
// this file and the state machine definition.
import type { ErrorClass } from './types';

// Lambda reports only `errorType` (= name) and `errorMessage` (= message) to
// Step Functions, so the class rides in the message as a prefix:
// "input: unsupported image format". RecordFailure parses it back out.
const CLASS_PREFIX = /^(input|platform|filter): /;

export function parseClassFromMessage(message: string): ErrorClass | undefined {
  const m = CLASS_PREFIX.exec(message);
  return m ? (m[1] as ErrorClass) : undefined;
}

export class RetryableError extends Error {
  readonly cls: ErrorClass;
  readonly retryable = true;
  constructor(cls: ErrorClass, message: string) {
    super(CLASS_PREFIX.test(message) ? message : `${cls}: ${message}`);
    this.name = 'RetryableError';
    this.cls = cls;
  }
}

export class TerminalError extends Error {
  readonly cls: ErrorClass;
  readonly retryable = false;
  constructor(cls: ErrorClass, message: string) {
    super(CLASS_PREFIX.test(message) ? message : `${cls}: ${message}`);
    this.name = 'TerminalError';
    this.cls = cls;
  }
}

export type ClassifiedError = RetryableError | TerminalError;

export function isClassified(e: unknown): e is ClassifiedError {
  return e instanceof RetryableError || e instanceof TerminalError;
}

// Messages libvips/sharp produce for bad input. Anything matching is the
// customer's file, not our infrastructure.
const INPUT_PATTERNS = [
  /unsupported image format/i,
  /Input buffer contains/i,
  /Input file is missing/i,
  /premature end/i,
  /corrupt/i,
  /bad huffman/i,
  /not a (jpeg|png|webp|tiff|gif)/i,
  /VipsJpeg|VipsPng|Vips.*Load/i,
];

// AWS SDK errors that mean "try again".
const PLATFORM_RETRYABLE_NAMES = new Set([
  'ThrottlingException',
  'Throttling',
  'TooManyRequestsException',
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
  'SlowDown',
  'ServiceUnavailable',
  'InternalError',
  'InternalServerError',
  'RequestTimeout',
  'TimeoutError',
  'NetworkingError',
  'ECONNRESET',
  'ETIMEDOUT',
]);

// Classify at the source: an unknown error becomes one of the two classes.
export function classify(e: unknown): ClassifiedError {
  if (isClassified(e)) return e;
  const err = e as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const message = err?.message ?? String(e);
  if (INPUT_PATTERNS.some((re) => re.test(message))) {
    return new TerminalError('input', message);
  }
  const status = err?.$metadata?.httpStatusCode;
  if ((err?.name && PLATFORM_RETRYABLE_NAMES.has(err.name)) || (status !== undefined && status >= 500)) {
    return new RetryableError('platform', `${err.name ?? 'AwsError'}: ${message}`);
  }
  // Our own bug or something we have not seen: ours, and worth one more try.
  return new RetryableError('platform', `${err?.name ?? 'Error'}: ${message}`);
}
