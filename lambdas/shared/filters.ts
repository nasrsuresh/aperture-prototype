// First-party filters. These are the "Node/TS functions inside the Proxy
// Lambda" from the baseline. The same module is imported by the synchronous
// POST /images handler and by the bulk worker, which is what "lift into a
// worker unchanged" means in practice.
import sharp from 'sharp';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, env } from './clients';
import { RetryableError, TerminalError, classify } from './errors';
import { pk, sk } from './keys';
import type { FilterManifest, FilterVersionRef, PipelineStep } from './types';

export type ParamSpec =
  | { type: 'number'; min: number; max: number; default?: number; required?: boolean }
  | { type: 'string'; enum?: string[]; default?: string; required?: boolean };

export type Params = Record<string, number | string>;

// What a filter may need to know about where it is running. Only the
// fail-inject test filter uses it.
export interface FilterContext {
  orgId: string;
  batchId: string;
  imageId: string;
  filename?: string;
  stepNumber: number;
}

export interface FilterDef {
  id: string;
  version: string;
  params: Record<string, ParamSpec>;
  estimatedSeconds: number; // used by pipeline validation (duration within limits)
  run: (input: Buffer, params: Params, ctx: FilterContext) => Promise<Buffer>;
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
    run: async (input, p) => sharp(input).blur(Number(p.sigma)).jpeg(OUTPUT).toBuffer(),
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
    run: async (input, p) => sharp(input).resize({ width: Number(p.width) }).jpeg(OUTPUT).toBuffer(),
  },
  // Test filter for the failure experiments. Passes the image through
  // unchanged except for the image whose filename contains `match`, where it
  // fails according to `mode` for the first `failures` attempts (counted in
  // DynamoDB, so the count survives across invocations and runs). That makes
  // a retryable failure genuinely transient: attempts 1..failures fail, the
  // next one succeeds, which is what retry-failed needs to demonstrate.
  'fail-inject': {
    id: 'fail-inject',
    version: '1.0.0',
    params: {
      match: { type: 'string', required: true },
      mode: { type: 'string', enum: ['retryable', 'terminal', 'timeout'], default: 'retryable' },
      failures: { type: 'number', min: 0, max: 100, default: 3 },
    },
    estimatedSeconds: 5,
    run: async (input, p, ctx) => {
      if (ctx.filename && ctx.filename.includes(String(p.match))) {
        const attempt = await bumpChaosCounter(ctx);
        if (attempt <= Number(p.failures)) {
          if (p.mode === 'timeout') {
            // Sleep past the Lambda timeout; Step Functions sees Sandbox.Timedout
            // or Lambda.Unknown, never our exception.
            await new Promise((r) => setTimeout(r, 20 * 60 * 1000));
          }
          if (p.mode === 'terminal') throw new TerminalError('input', `fail-inject: terminal on attempt ${attempt}`);
          throw new RetryableError('platform', `fail-inject: transient failure, attempt ${attempt}`);
        }
      }
      return sharp(input).jpeg(OUTPUT).toBuffer();
    },
  },
};

async function bumpChaosCounter(ctx: FilterContext): Promise<number> {
  const res = await ddb.send(
    new UpdateCommand({
      TableName: env.TABLE_NAME,
      Key: { PK: pk.org(ctx.orgId), SK: sk.chaos(ctx.batchId, ctx.imageId, ctx.stepNumber) },
      UpdateExpression: 'SET #t = :t ADD attempts :one',
      ExpressionAttributeNames: { '#t': 'type' },
      ExpressionAttributeValues: { ':t': 'Chaos', ':one': 1 },
      ReturnValues: 'ALL_NEW',
    }),
  );
  return Number(res.Attributes?.attempts ?? 1);
}

export function getFilter(filterId: string): FilterDef {
  const def = FIRST_PARTY_FILTERS[filterId];
  if (!def) throw new TerminalError('input', `unknown filter '${filterId}'`);
  return def;
}

// Validate and normalize params against a spec. Used at pipeline save (so a
// broken pipeline never occupies a run) and again at run time.
export function validateParams(
  owner: string,
  specs: Record<string, ParamSpec>,
  params: Record<string, unknown> | undefined,
): Params {
  const out: Params = {};
  const given = params ?? {};
  for (const key of Object.keys(given)) {
    if (!(key in specs)) throw new TerminalError('input', `filter '${owner}': unknown param '${key}'`);
  }
  for (const [key, spec] of Object.entries(specs)) {
    const raw = given[key];
    if (raw === undefined) {
      if (spec.required) throw new TerminalError('input', `filter '${owner}': param '${key}' is required`);
      if (spec.default !== undefined) out[key] = spec.default;
      continue;
    }
    if (spec.type === 'number') {
      if (typeof raw !== 'number' || Number.isNaN(raw)) {
        throw new TerminalError('input', `filter '${owner}': param '${key}' must be a number`);
      }
      if (raw < spec.min || raw > spec.max) {
        throw new TerminalError('input', `filter '${owner}': param '${key}' must be in [${spec.min}, ${spec.max}]`);
      }
      out[key] = raw;
    } else {
      if (typeof raw !== 'string') throw new TerminalError('input', `filter '${owner}': param '${key}' must be a string`);
      if (spec.enum && !spec.enum.includes(raw)) {
        throw new TerminalError('input', `filter '${owner}': param '${key}' must be one of ${spec.enum.join(', ')}`);
      }
      out[key] = raw;
    }
  }
  return out;
}

// The manifest's JSON Schema subset, mapped onto ParamSpec so one validator
// serves both first-party and marketplace steps.
export function specsFromManifest(manifest: FilterManifest): Record<string, ParamSpec> {
  const specs: Record<string, ParamSpec> = {};
  const required = new Set(manifest.params.required ?? []);
  for (const [key, prop] of Object.entries(manifest.params.properties ?? {})) {
    if (prop.type === 'number') {
      specs[key] = {
        type: 'number',
        min: prop.minimum ?? -Infinity,
        max: prop.maximum ?? Infinity,
        default: typeof prop.default === 'number' ? prop.default : undefined,
        required: required.has(key),
      };
    } else {
      specs[key] = {
        type: 'string',
        default: typeof prop.default === 'string' ? prop.default : undefined,
        required: required.has(key),
      };
    }
  }
  return specs;
}

// Run one first-party filter on image bytes. Decoding happens inside sharp;
// a bad file surfaces as a libvips error, which classify() maps to
// TerminalError('input'). Anything else is ours.
export async function runFirstPartyFilter(step: PipelineStep, input: Buffer, ctx: FilterContext): Promise<Buffer> {
  const def = getFilter(step.filterId);
  const params = validateParams(def.id, def.params, step.params);
  try {
    return await def.run(input, params, ctx);
  } catch (e) {
    throw classify(e);
  }
}

// Pipeline-level validation from A Decision 3: filters exist, params match
// each filter's schema, step count and estimated duration within limits.
// Marketplace steps are resolved through `resolve`, which the caller wires to
// the FilterVersion items (and the entitlement/policy checks of Scenario B).
export const PIPELINE_LIMITS = { maxSteps: 10, maxEstimatedSeconds: 14 * 60 } as const;

export type MarketplaceResolver = (filterId: string, version: string | undefined) => Promise<FilterVersionRef>;

export async function validatePipeline(steps: unknown, resolve?: MarketplaceResolver): Promise<PipelineStep[]> {
  if (!Array.isArray(steps) || steps.length === 0) throw new TerminalError('input', 'steps must be a non-empty array');
  if (steps.length > PIPELINE_LIMITS.maxSteps) {
    throw new TerminalError('input', `at most ${PIPELINE_LIMITS.maxSteps} steps`);
  }
  let estimated = 0;
  const out: PipelineStep[] = [];
  for (const [i, raw] of (steps as Partial<PipelineStep>[]).entries()) {
    const type = raw.type ?? 'first_party';
    if (!raw.filterId) throw new TerminalError('input', `step ${i + 1}: filterId is required`);
    if (type === 'first_party') {
      const def = getFilter(raw.filterId);
      const params = validateParams(def.id, def.params, raw.params);
      estimated += def.estimatedSeconds;
      out.push({ type, filterId: def.id, version: def.version, params });
    } else if (type === 'marketplace') {
      if (!resolve) throw new TerminalError('input', `step ${i + 1}: marketplace filters are not available here`);
      const ref = await resolve(raw.filterId, raw.version);
      const params = validateParams(ref.filterId, specsFromManifest(ref.manifest), raw.params);
      estimated += ref.manifest.limits.timeoutSec;
      out.push({ type, filterId: ref.filterId, version: ref.version, params });
    } else {
      throw new TerminalError('input', `step ${i + 1}: unknown step type '${String(raw.type)}'`);
    }
  }
  if (estimated > PIPELINE_LIMITS.maxEstimatedSeconds) {
    throw new TerminalError('input', `estimated duration ${estimated}s exceeds ${PIPELINE_LIMITS.maxEstimatedSeconds}s`);
  }
  return out;
}
