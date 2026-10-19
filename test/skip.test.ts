// Checkpoint resume (A Decision 4): a step is skipped only when its output
// exists AND was computed from the same original.
import { decideSkip } from '../lambdas/worker/skip';
import { SOURCE_ETAG_META } from '../lambdas/shared/s3util';

const existing = (etag: string) => ({ etag: 'out-etag', size: 1234, metadata: { [SOURCE_ETAG_META]: etag } });

describe('decideSkip', () => {
  test('no output yet: run the step', () => {
    expect(decideSkip(null, 'abc')).toEqual({ skip: false, reason: 'no-output' });
  });

  test('output from the same original: skip', () => {
    expect(decideSkip(existing('abc'), 'abc')).toEqual({ skip: true, reason: 'same-etag' });
  });

  test('output from a different original (re-upload): recompute', () => {
    expect(decideSkip(existing('abc'), 'def')).toEqual({ skip: false, reason: 'etag-mismatch' });
  });

  test('output with no recorded ETag (legacy or foreign object): recompute', () => {
    expect(decideSkip({ etag: 'x', size: 1, metadata: {} }, 'abc')).toEqual({ skip: false, reason: 'etag-mismatch' });
  });

  test('E5b breakage: ignoring the ETag reuses stale output', () => {
    expect(decideSkip(existing('abc'), 'def', true)).toEqual({ skip: true, reason: 'etag-ignored' });
  });
});
