// The checkpoint-resume rule from A Decision 4, as a pure function so it can
// be unit-tested: skip a step when its output already exists AND was computed
// from the same original (same sourceETag). A re-upload changes the ETag, so
// stale outputs are never reused.
import type { ObjectInfo } from '../shared/s3util';
import { SOURCE_ETAG_META } from '../shared/s3util';

export interface SkipDecision {
  skip: boolean;
  reason: 'no-output' | 'etag-mismatch' | 'same-etag' | 'etag-ignored';
}

export function decideSkip(existing: ObjectInfo | null, sourceETag: string, ignoreEtag = false): SkipDecision {
  if (!existing) return { skip: false, reason: 'no-output' };
  if (ignoreEtag) return { skip: true, reason: 'etag-ignored' }; // E5b breakage
  const recorded = existing.metadata[SOURCE_ETAG_META];
  if (recorded === sourceETag) return { skip: true, reason: 'same-etag' };
  return { skip: false, reason: 'etag-mismatch' };
}
