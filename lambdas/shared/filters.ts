// First-party filters. These are the "Node/TS functions inside the Proxy
// Lambda" from the baseline. The same module is imported by the synchronous
// POST /images handler and by the bulk worker, which is what "lift into a
// worker unchanged" means in practice.
import sharp from 'sharp';
import { TerminalError, classify } from './errors';
import type { PipelineStep } from './types';

export interface ParamSpec {
  type: 'number';
  min: number;
  max: number;
  default?: number;
  required?: boolean;
}

export interface FilterDef {
  id: string;
  version: string;
  params: Record<string, ParamSpec>;
  estimatedSeconds: number; // used by pipeline validation (duration within limits)
  run: (input: Buffer, params: Record<string, number>) => Promise<Buffer>;
}

const OUTPUT = { quality: 90 } as const;

export const FIRST_PARTY_FILTERS: Record<string, FilterDef> = {
  grayscale: {
    id: 'grayscale',
    version: '1.0.0',
    params: {},
    estimatedSeconds: 5,
    run: async (input) => sharp(input).grayscale().jpeg(OUTPUT).toBuffer(),
  },
  blur: {
    id: 'blur',
    version: '1.0.0',
    params: { sigma: { type: 'number', min: 0.3, max: 50, default: 5 } },
    estimatedSeconds: 10,
    run: async (input, p) => sharp(input).blur(p.sigma).jpeg(OUTPUT).toBuffer(),
  },
  sepia: {
    id: 'sepia',
    version: '1.0.0',
    params: {},
    estimatedSeconds: 5,
    run: async (input) =>
      sharp(input)
        .recomb([
          [0.393, 0.769, 0.189],
          [0.349, 0.686, 0.168],
          [0.272, 0.534, 0.131],
        ])
        .jpeg(OUTPUT)
        .toBuffer(),
  },
  resize: {
    id: 'resize',
    version: '1.0.0',
    params: { width: { type: 'number', min: 16, max: 8000, required: true } },
    estimatedSeconds: 5,
    run: async (input, p) => sharp(input).resize({ width: p.width }).jpeg(OUTPUT).toBuffer(),
  },
};

export function getFilter(filterId: string): FilterDef {
  const def = FIRST_PARTY_FILTERS[filterId];
  if (!def) throw new TerminalError('input', `unknown filter '${filterId}'`);
  return def;
}

// Validate and normalize params against the filter's spec. Used at pipeline
// save (so a broken pipeline never occupies a run) and again at run time.
export function validateParams(def: FilterDef, params: Record<string, unknown> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  const given = params ?? {};
  for (const key of Object.keys(given)) {
    if (!(key in def.params)) throw new TerminalError('input', `filter '${def.id}': unknown param '${key}'`);
  }
  for (const [key, spec] of Object.entries(def.params)) {
    const raw = given[key];
    if (raw === undefined) {
      if (spec.required) throw new TerminalError('input', `filter '${def.id}': param '${key}' is required`);
      if (spec.default !== undefined) out[key] = spec.default;
      continue;
    }
    if (typeof raw !== 'number' || Number.isNaN(raw)) {
      throw new TerminalError('input', `filter '${def.id}': param '${key}' must be a number`);
    }
    if (raw < spec.min || raw > spec.max) {
      throw new TerminalError('input', `filter '${def.id}': param '${key}' must be in [${spec.min}, ${spec.max}]`);
    }
    out[key] = raw;
  }
  return out;
}

// Run one first-party filter on image bytes. Decoding happens inside sharp;
// a bad file surfaces as a libvips error, which classify() maps to
// TerminalError('input'). Anything else is ours.
export async function runFirstPartyFilter(step: PipelineStep, input: Buffer): Promise<Buffer> {
  const def = getFilter(step.filterId);
  const params = validateParams(def, step.params);
  try {
    return await def.run(input, params);
  } catch (e) {
    throw classify(e);
  }
}

// Pipeline-level validation from A Decision 3: filters exist, params match
// each filter's schema, step count and estimated duration within limits.
export const PIPELINE_LIMITS = { maxSteps: 10, maxEstimatedSeconds: 14 * 60 } as const;

export function validatePipeline(steps: unknown): PipelineStep[] {
  if (!Array.isArray(steps) || steps.length === 0) throw new TerminalError('input', 'steps must be a non-empty array');
  if (steps.length > PIPELINE_LIMITS.maxSteps) {
    throw new TerminalError('input', `at most ${PIPELINE_LIMITS.maxSteps} steps`);
  }
  let estimated = 0;
  const out: PipelineStep[] = [];
  steps.forEach((raw, i) => {
    const s = raw as Partial<PipelineStep>;
    const type = s.type ?? 'first_party';
    if (type === 'marketplace') {
      throw new TerminalError('input', `step ${i + 1}: marketplace filters are not available yet (Phase 2)`);
    }
    if (type !== 'first_party') throw new TerminalError('input', `step ${i + 1}: unknown step type '${String(s.type)}'`);
    if (!s.filterId) throw new TerminalError('input', `step ${i + 1}: filterId is required`);
    const def = getFilter(s.filterId);
    const params = validateParams(def, s.params);
    estimated += def.estimatedSeconds;
    out.push({ type, filterId: def.id, version: def.version, params });
  });
  if (estimated > PIPELINE_LIMITS.maxEstimatedSeconds) {
    throw new TerminalError('input', `estimated duration ${estimated}s exceeds ${PIPELINE_LIMITS.maxEstimatedSeconds}s`);
  }
  return out;
}
