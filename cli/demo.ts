// `npm run demo`: the whole architecture in one run, against the deployed
// stack. Prints what it is doing and why at each step. About 5 minutes.
//
// Scenario A: 20 images through a 3-step pipeline, with two deliberately
// bad images (one fails transiently, one is not an image), then re-upload
// and retry-failed to 20/20.
// Scenario B: a third-party Pillow filter in the isolated boundary, a
// hostile one probing the walls, one that lies about its output, and the
// metering records.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import sharp from 'sharp';
import { DescribeExecutionCommand, SFNClient } from '@aws-sdk/client-sfn';
import { api, expect, sleep } from './lib/api';
import { loadConfig, type Config } from './lib/config';
import { queryBatchImages, queryInvocations } from './lib/table';
import { printTrace, traceExecution } from './lib/trace';
import { rerunValidate } from './lib/rerun';
import { requestReuploadUrl, uploadFiles } from './lib/upload';

const DIR = 'experiments/scratch/demo';
const COUNT = 20;
const sfn = new SFNClient({});

const h1 = (s: string) => console.log(`\n${'='.repeat(78)}\n${s}\n${'='.repeat(78)}`);
const h2 = (s: string) => console.log(`\n--- ${s}`);
const say = (s: string) => console.log(`    ${s}`);
const show = (label: string, v: unknown) => console.log(`    ${label}: ${JSON.stringify(v)}`);

async function genImages() {
  mkdirSync(DIR, { recursive: true });
  const side = Math.round(Math.sqrt((2 * 1024 * 1024) / 3)); // ~2 MB of noise as PNG
  for (let i = 1; i <= COUNT; i += 1) {
    const name = `img-${String(i).padStart(3, '0')}.png`;
    const path = join(DIR, name);
    if (existsSync(path)) continue;
    if (i === 8) {
      writeFileSync(path, randomBytes(2 * 1024 * 1024)); // named .png, is not an image
      continue;
    }
    const raw = randomBytes(side * side * 3);
    writeFileSync(path, await sharp(raw, { raw: { width: side, height: side, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer());
  }
  const good8 = join(DIR, 'img-008-fixed.png');
  if (!existsSync(good8)) {
    const raw = randomBytes(side * side * 3);
    writeFileSync(good8, await sharp(raw, { raw: { width: side, height: side, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer());
  }
}

async function waitBatch(cfg: Config, batchId: string) {
  for (;;) {
    const r = await api<{ status: string; images: Record<string, number>; mapRun?: Record<string, unknown>; counts?: unknown }>(
      cfg,
      'GET',
      `/batches/${batchId}`,
    );
    expect(r, 200);
    const m = r.body.mapRun;
    say(
      `${new Date().toISOString().slice(11, 19)}  batch=${r.body.status.padEnd(9)} images=${JSON.stringify(r.body.images)}` +
        (m && m.state ? `  mapRun=${m.state} running=${m.running ?? '-'} ok=${m.succeeded ?? '-'} failed=${m.failed ?? '-'}` : ''),
    );
    if (r.body.status === 'completed') return r.body;
    await sleep(5000);
  }
}

async function waitImage(cfg: Config, imageId: string) {
  for (;;) {
    const r = await api<{ status: string; error?: unknown; url?: string; executionArn?: string }>(cfg, 'GET', `/images/${imageId}`);
    expect(r, 200);
    say(`${new Date().toISOString().slice(11, 19)}  image ${imageId} status=${r.body.status}`);
    if (r.body.status === 'processed' || r.body.status === 'failed') return r.body;
    await sleep(3000);
  }
}

async function executionOutput(arn: string) {
  const d = await sfn.send(new DescribeExecutionCommand({ executionArn: arn }));
  return d.output ? (JSON.parse(d.output) as Record<string, unknown>) : undefined;
}

async function main() {
  const cfg = loadConfig();
  const t0 = Date.now();
  const summary: string[] = [];

  h1('Scenario A: bulk pipeline');
  await genImages();
  say(`${COUNT} test images in ${DIR} (~2 MB each). img-008.png is 2 MB of random bytes, not an image.`);

  h2('1. Pipeline (A Decision 3): validated at save, stored as an immutable version');
  const steps = [
    { filterId: 'grayscale' },
    // Fails img-007 on its first 3 attempts, then succeeds: the retry run will pass.
    { filterId: 'fail-inject', params: { match: 'img-007', mode: 'retryable', failures: 3 } },
    { filterId: 'resize', params: { width: 800 } },
  ];
  const bad = await api(cfg, 'POST', '/pipelines', { steps: [{ filterId: 'blur', params: { sigma: 999 } }] });
  say(`a pipeline with sigma=999 -> ${bad.status} ${JSON.stringify(bad.body)}`);
  const p = await api<{ pipelineId: string; version: number }>(cfg, 'POST', '/pipelines', { name: 'demo', steps });
  expect(p, 201);
  const { pipelineId, version } = p.body;
  say(`pipeline ${pipelineId} v${version}: grayscale -> fail-inject(img-007) -> resize(800)`);

  h2('2. Batch + presigned POST uploads (A Decision 1): zero image bytes through the API');
  const b = await api<{ batchId: string }>(cfg, 'POST', '/batches', { pipelineId, pipelineVersion: version, declaredCount: COUNT });
  expect(b, 201);
  const batchId = b.body.batchId;
  const files = Array.from({ length: COUNT }, (_, i) => join(DIR, `img-${String(i + 1).padStart(3, '0')}.png`));
  const tUp = Date.now();
  const ups = await uploadFiles(cfg, batchId, files);
  say(`${ups.filter((u) => u.ok).length}/${COUNT} uploaded straight to S3 in ${Date.now() - tUp} ms (each URL carries a signed content-length-range policy)`);
  const idByName = new Map(ups.map((u) => [u.filename, u.imageId]));

  h2('3. Submit (Fact 9: S3 does not notify; we list and reconcile), then the Distributed Map runs');
  const s = await api<{ runId: string; executionArn: string }>(cfg, 'POST', `/batches/${batchId}/submit`, {});
  expect(s, 202);
  say(`202: run ${s.body.runId}, parent execution started; every image is its own child execution`);
  const done1 = await waitBatch(cfg, batchId);
  show('batch counts after run 1', done1.counts);
  summary.push(`run 1: ${JSON.stringify(done1.counts)} (expected 18 ok, 2 failed)`);

  h2('4. Failures are classified (A Decision 4): {step, class, retryable, attempts}');
  const items = await queryBatchImages(cfg, batchId);
  for (const it of items.filter((i) => i.status === 'failed').sort((a, b) => String(a.filename).localeCompare(String(b.filename)))) {
    say(`${it.filename}: ${JSON.stringify(it.error)}`);
  }
  const id7 = idByName.get('img-007.png')!;
  const id8 = idByName.get('img-008.png')!;
  h2('   execution timeline for img-007 (3 attempts, 2 s then 4 s backoff, then RecordFailure)');
  const img7 = items.find((i) => i.imageId === id7)!;
  printTrace(img7.executionArn as string, await traceExecution(img7.executionArn as string));
  h2('   execution timeline for img-008 (TerminalError: one attempt, no retry)');
  const img8 = items.find((i) => i.imageId === id8)!;
  printTrace(img8.executionArn as string, await traceExecution(img8.executionArn as string));

  h2('5. Fix and retry (A Decision 4): re-upload img-008, retry only the failed images');
  const re = await requestReuploadUrl(cfg, batchId, id8);
  const reUp = await uploadFiles(cfg, batchId, [join(DIR, 'img-008-fixed.png')], [{ ...re, filename: 'img-008-fixed.png' }]);
  say(`img-008 re-uploaded under the same imageId: http ${reUp[0].status}, new ETag ${reUp[0].etag}`);
  const rf = await api<{ retrying: Array<{ imageId: string; sourceETag: string }> }>(cfg, 'POST', `/batches/${batchId}/retry-failed`);
  expect(rf, 202);
  say(`retry run contains ${rf.body.retrying.length} images (not 20): ${rf.body.retrying.map((r) => r.imageId).join(', ')}`);
  const done2 = await waitBatch(cfg, batchId);
  show('batch counts after retry', done2.counts);
  summary.push(`retry: ${JSON.stringify(done2.counts)} (expected 20 ok, 0 failed)`);

  h2('   img-007 on retry: step 1 output already exists for the same sourceETag -> skipped; step 2 now passes');
  const items2 = await queryBatchImages(cfg, batchId);
  const img7b = items2.find((i) => i.imageId === id7)!;
  printTrace(img7b.executionArn as string, await traceExecution(img7b.executionArn as string));
  h2('   img-008 on retry: new sourceETag -> nothing reused, all 3 steps run');
  const img8b = items2.find((i) => i.imageId === id8)!;
  printTrace(img8b.executionArn as string, await traceExecution(img8b.executionArn as string));

  h2('6. Results: paged presigned GETs for the final step');
  const res = await api<{ items: Array<{ status: string; url?: string }>; nextCursor?: string }>(cfg, 'GET', `/batches/${batchId}/results?limit=5`);
  expect(res, 200);
  say(`first page: ${res.body.items.length} items, ${res.body.items.filter((i) => i.url).length} with URLs, nextCursor ${res.body.nextCursor ? 'present' : 'absent'}`);
  const first = res.body.items.find((i) => i.url);
  if (first?.url) {
    const got = await fetch(first.url);
    const bytes = Buffer.from(await got.arrayBuffer());
    const meta = await sharp(bytes).metadata();
    say(`GET one result URL -> ${got.status} ${got.headers.get('content-type')}, ${bytes.length} bytes, ${meta.width}x${meta.height} ${meta.format} (grayscale, resized to 800)`);
  }

  h1('Scenario B: marketplace filter in the isolated boundary');
  h2('7. Registry, org policy, entitlement (B Decision 5 and 6)');
  const manifest = JSON.parse(readFileSync('filters-3p/pillow-sepia/filter.json', 'utf8'));
  for (const mode of ['sepia', 'hostile', 'liar']) {
    const filterId = mode === 'sepia' ? 'sepia-3p' : `sepia-3p-${mode}`;
    const r = await api(cfg, 'POST', '/admin/filters', {
      filterId,
      version: manifest.version,
      developerId: 'dev-pillow',
      functionArn: cfg.outputs[`Filter${mode}Arn`],
      manifest: { ...manifest, name: filterId },
    });
    expect(r, 201);
  }
  say('registered sepia-3p, sepia-3p-hostile, sepia-3p-liar (same container image, FILTER_MODE differs)');
  await api(cfg, 'PUT', '/org/policy', { allowThirdPartyFilters: false });
  const denied = await api(cfg, 'POST', '/pipelines', { steps: [{ type: 'marketplace', filterId: 'sepia-3p' }] });
  say(`with allowThirdPartyFilters=false, saving a marketplace pipeline -> ${denied.status} ${JSON.stringify(denied.body)}`);
  await api(cfg, 'PUT', '/org/policy', { allowThirdPartyFilters: true });
  const small = await sharp(randomBytes(300 * 300 * 3), { raw: { width: 300, height: 300, channels: 3 } }).jpeg().toBuffer();
  // A second organization with the policy on but nothing purchased.
  const other: Config = { ...cfg, orgId: `${cfg.orgId}-noent` };
  await api(other, 'PUT', '/org/policy', { allowThirdPartyFilters: true });
  const noEnt = await api(other, 'POST', '/images', { image: small.toString('base64'), filterId: 'sepia-3p' });
  say(`org ${other.orgId} (policy on, no entitlement): POST /images sepia-3p -> ${noEnt.status} ${JSON.stringify(noEnt.body)}`);
  for (const f of ['sepia-3p', 'sepia-3p-hostile', 'sepia-3p-liar']) expect(await api(cfg, 'POST', '/entitlements', { filterId: f }), 201);
  say('entitlements created for all three');

  h2('8. POST /images with a marketplace filter -> 202 + status URL (B Decision 1), same code path as a batch step');
  const m1 = await api<{ imageId: string; statusUrl: string; executionArn: string }>(cfg, 'POST', '/images', {
    image: small.toString('base64'),
    filterId: 'sepia-3p',
    params: { intensity: 0.8 },
  });
  expect(m1, 202);
  say(`202 ${JSON.stringify(m1.body)}`);
  const r1 = await waitImage(cfg, m1.body.imageId);
  const out1 = await executionOutput(m1.body.executionArn);
  show('child execution output', out1);
  if (r1.url) {
    const got = await fetch(r1.url);
    const bytes = Buffer.from(await got.arrayBuffer());
    const meta = await sharp(bytes).metadata();
    say(`GET result URL -> ${got.status}, ${bytes.length} bytes, ${meta.width}x${meta.height} ${meta.format} (re-encoded by ValidateOutput, not the filter’s bytes)`);
  }
  summary.push(`marketplace sepia-3p: ${r1.status}`);

  h2('9. Hostile filter (B Decision 3): tries internet, S3 ListBucket, DynamoDB, another bucket');
  const m2 = await api<{ imageId: string; executionArn: string }>(cfg, 'POST', '/images', { image: small.toString('base64'), filterId: 'sepia-3p-hostile' });
  expect(m2, 202);
  const r2 = await waitImage(cfg, m2.body.imageId);
  const out2 = await executionOutput(m2.body.executionArn);
  const probes = (out2?.lastResult as { filterMetrics?: { probes?: Record<string, string> } } | undefined)?.filterMetrics?.probes;
  for (const [k, v] of Object.entries(probes ?? {})) say(`${k.padEnd(12)} ${v}`);
  summary.push(`hostile filter: image ${r2.status}; probes: ${Object.values(probes ?? {}).every((v) => /blocked|denied/.test(v)) ? 'all blocked' : 'SOMETHING GOT THROUGH'}`);

  h2('10. Liar filter (B Decision 2): says ok, writes nothing -> ValidateOutput fails it, class=filter');
  const m3 = await api<{ imageId: string; executionArn: string }>(cfg, 'POST', '/images', { image: small.toString('base64'), filterId: 'sepia-3p-liar' });
  expect(m3, 202);
  const r3 = await waitImage(cfg, m3.body.imageId);
  show('image error', r3.error);
  summary.push(`liar filter: image ${r3.status}, error class ${(r3.error as { class?: string } | undefined)?.class}`);

  h2('11. Metering (B Decision 5): one Invocation per (image, step); a duplicate success bills once');
  const dup = await rerunValidate(cfg, m1.body.imageId);
  show('ValidateOutput invoked a second time with the same payload', dup.result);
  const month = new Date().toISOString().slice(0, 7);
  const inv = await queryInvocations(cfg, month);
  for (const i of inv.filter((i) => [m1.body.imageId, m2.body.imageId, m3.body.imageId].includes(String(i.imageId)))) {
    say(`${String(i.filterId).padEnd(18)} image ${i.imageId} attempt ${i.attempt} status=${i.status} billable=${i.billable}${i.errorClass ? ` errorClass=${i.errorClass}` : ''}`);
  }
  summary.push(`invocation records for the 3 single requests: ${inv.filter((i) => [m1.body.imageId, m2.body.imageId, m3.body.imageId].includes(String(i.imageId))).length} (expected 3: ok, ok, error)`);

  h1(`Summary (${Math.round((Date.now() - t0) / 1000)} s)`);
  for (const line of summary) say(line);
  say(`batch ${batchId}; pipeline ${pipelineId}@${version}`);
  say('Step Functions console: aperture-proto-batch (parent), aperture-proto-image (children)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
