// A Decision 3: validate at save time, so a broken pipeline never gets a
// version and never occupies a run.
import { validatePipeline, validateParams, PIPELINE_LIMITS } from '../lambdas/shared/filters';
import { TerminalError } from '../lambdas/shared/errors';

describe('validatePipeline', () => {
  test('a good pipeline is normalized: versions pinned, defaults filled', async () => {
    const steps = await validatePipeline([{ filterId: 'grayscale' }, { filterId: 'blur', params: {} }, { filterId: 'resize', params: { width: 800 } }]);
    expect(steps).toEqual([
      { type: 'first_party', filterId: 'grayscale', version: '1.0.0', params: {} },
      { type: 'first_party', filterId: 'blur', version: '1.0.0', params: { sigma: 5 } },
      { type: 'first_party', filterId: 'resize', version: '1.0.0', params: { width: 800 } },
    ]);
  });

  test('unknown filter is rejected as input', async () => {
    await expect(validatePipeline([{ filterId: 'sparkle' }])).rejects.toMatchObject({ cls: 'input' });
  });

  test('a required param missing is rejected', async () => {
    await expect(validatePipeline([{ filterId: 'resize' }])).rejects.toThrow(/width.*required/);
  });

  test('a param out of range is rejected', async () => {
    await expect(validatePipeline([{ filterId: 'blur', params: { sigma: 500 } }])).rejects.toThrow(/sigma/);
  });

  test('too many steps is rejected', async () => {
    const steps = Array.from({ length: PIPELINE_LIMITS.maxSteps + 1 }, () => ({ filterId: 'grayscale' }));
    await expect(validatePipeline(steps)).rejects.toThrow(/at most/);
  });

  test('a marketplace step without a resolver is rejected here (Proxy wires the registry)', async () => {
    await expect(validatePipeline([{ type: 'marketplace', filterId: 'sepia-3p' }])).rejects.toBeInstanceOf(TerminalError);
  });

  test('a marketplace step with a resolver uses the manifest schema and timeout', async () => {
    const steps = await validatePipeline([{ type: 'marketplace', filterId: 'sepia-3p', params: { intensity: 0.5 } }], async () => ({
      filterId: 'sepia-3p',
      version: '1.0.0',
      developerId: 'dev',
      functionArn: 'arn:aws:lambda:us-east-1:1:function:aperture-3p-sepia',
      manifest: {
        name: 'sepia-3p',
        version: '1.0.0',
        contractVersion: 1,
        params: { properties: { intensity: { type: 'number', minimum: 0, maximum: 1, default: 1 } } },
        input: { formats: ['jpeg'], maxBytes: 1000 },
        output: { format: 'jpeg' },
        limits: { timeoutSec: 60, memoryMb: 1024 },
      },
    }));
    expect(steps[0]).toEqual({ type: 'marketplace', filterId: 'sepia-3p', version: '1.0.0', params: { intensity: 0.5 } });
  });
});

describe('validateParams', () => {
  test('unknown param names are rejected (typos do not silently do nothing)', () => {
    expect(() => validateParams('blur', { sigma: { type: 'number', min: 0, max: 1 } }, { sgima: 0.5 })).toThrow(/unknown param/);
  });
});
