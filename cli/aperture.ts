// Aperture CLI. Drives the API the way a browser or customer CLI would, and
// exposes table and execution state so each experiment is observable.
//
// Single image
//   npm run cli -- single <file> <filterId> [paramsJson]       200 for first-party, 202 for marketplace
//   npm run cli -- image-status <imageId> [--wait]
// Pipelines
//   npm run cli -- create-pipeline <stepsJson|@file> [--name N] [--id existingPipelineId]
//   npm run cli -- get-pipeline <pipelineId>
// Batches
//   npm run cli -- create-batch <pipelineId> <version> <declaredCount>
//   npm run cli -- upload <batchId> <file...>
//   npm run cli -- submit <batchId> [--confirm]
//   npm run cli -- status <batchId> [--wait]
//   npm run cli -- results <batchId> [--all]
//   npm run cli -- retry-failed <batchId>
//   npm run cli -- reupload <batchId> <imageId> <file>
//   npm run cli -- trace <imageId>                              Step Functions timeline for one image
//   npm run cli -- rerun-step <imageId> <stepNumber>            invoke RunStep again by hand (E6: duplicate)
//   npm run cli -- rerun-validate <imageId>                     invoke ValidateOutput again by hand (E10: bills once)
// Marketplace (Scenario B)
//   npm run cli -- policy <true|false>
//   npm run cli -- register-filter <mode: sepia|hostile|liar> [--as filterId] [--state published]
//   npm run cli -- get-filter <filterId>
//   npm run cli -- entitle <filterId> [--cents 2] [--share 0.7]
//   npm run cli -- invocations [yyyy-mm]
// Table
//   npm run cli -- dump-table [--batch <batchId>] [--prefix SKPREFIX]
import { readFileSync } from 'node:fs';
import { api, expect, print, sleep } from './lib/api';
import { loadConfig } from './lib/config';
import { getItem, printInvocations, printRows, queryBatchImages, queryInvocations, queryOrg } from './lib/table';
import { rerunStep, rerunValidate } from './lib/rerun';
import { printTrace, traceExecution } from './lib/trace';
import { requestReuploadUrl, uploadFiles } from './lib/upload';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
const VALUE_FLAGS = new Set(['name', 'id', 'batch', 'prefix', 'as', 'state', 'cents', 'share']);

function positional(): string[] {
  const out: string[] = [];
  const argv = process.argv.slice(3);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      if (VALUE_FLAGS.has(argv[i].slice(2))) i += 1;
      continue;
    }
    out.push(argv[i]);
  }
  return out;
}

function printUploads(results: Awaited<ReturnType<typeof uploadFiles>>, t0: number) {
  for (const r of results) {
    const mb = (r.bytes / 1024 / 1024).toFixed(2);
    console.log(
      `${r.ok ? 'OK  ' : 'FAIL'} ${r.filename.padEnd(16)} ${mb.padStart(7)} MB  http ${r.status}  attempts ${r.attempts}` +
        (r.etag ? `  etag ${r.etag}` : '') +
        (r.error ? `  ${r.error}` : ''),
    );
  }
  console.log(`${results.filter((r) => r.ok).length}/${results.length} uploaded in ${Date.now() - t0} ms`);
}

async function main() {
  const cfg = loadConfig();
  const cmd = process.argv[2];
  const args = positional();

  switch (cmd) {
    // ---- single image ----
    case 'single': {
      const [file, filterId, paramsJson] = args;
      const bytes = readFileSync(file);
      const body = { image: bytes.toString('base64'), filterId, params: paramsJson ? JSON.parse(paramsJson) : undefined };
      console.log(`file ${file}: ${bytes.length} bytes raw, ${body.image.length} bytes base64`);
      print('POST /images', await api(cfg, 'POST', '/images', body));
      return;
    }
    case 'image-status': {
      const [imageId] = args;
      for (;;) {
        const r = await api<{ status: string }>(cfg, 'GET', `/images/${imageId}`);
        print(`GET /images/${imageId}`, r);
        if (!has('wait') || r.status !== 200 || ['processed', 'failed'].includes(r.body.status)) return;
        await sleep(3000);
      }
    }

    // ---- pipelines ----
    case 'create-pipeline': {
      const [stepsJson] = args;
      const steps = JSON.parse(stepsJson.startsWith('@') ? readFileSync(stepsJson.slice(1), 'utf8') : stepsJson);
      print('POST /pipelines', await api(cfg, 'POST', '/pipelines', { steps, name: flag('name'), pipelineId: flag('id') }));
      return;
    }
    case 'get-pipeline': {
      print(`GET /pipelines/${args[0]}`, await api(cfg, 'GET', `/pipelines/${args[0]}`));
      return;
    }

    // ---- batches ----
    case 'create-batch': {
      const [pipelineId, version, declaredCount] = args;
      print(
        'POST /batches',
        await api(cfg, 'POST', '/batches', {
          pipelineId,
          pipelineVersion: Number(version),
          declaredCount: Number(declaredCount),
        }),
      );
      return;
    }
    case 'upload': {
      const [batchId, ...files] = args;
      const t0 = Date.now();
      printUploads(await uploadFiles(cfg, batchId, files), t0);
      return;
    }
    case 'submit': {
      const [batchId] = args;
      print(`POST /batches/${batchId}/submit`, await api(cfg, 'POST', `/batches/${batchId}/submit`, { confirm: has('confirm') }));
      return;
    }
    case 'status': {
      const [batchId] = args;
      for (;;) {
        const r = await api<{ status: string; images: Record<string, number>; mapRun?: Record<string, unknown> }>(
          cfg,
          'GET',
          `/batches/${batchId}`,
        );
        if (!has('wait')) {
          print(`GET /batches/${batchId}`, r);
          return;
        }
        expect(r, 200);
        const m = r.body.mapRun;
        console.log(
          `${new Date().toISOString().slice(11, 19)}  batch ${r.body.status.padEnd(9)} images ${JSON.stringify(r.body.images)}` +
            (m ? `  mapRun ${m.state} running=${m.running ?? '-'} ok=${m.succeeded ?? '-'} failed=${m.failed ?? '-'}` : ''),
        );
        if (r.body.status === 'completed') {
          print(`GET /batches/${batchId}`, r);
          return;
        }
        await sleep(4000);
      }
    }
    case 'results': {
      const [batchId] = args;
      let cursor: string | undefined;
      do {
        const r = await api<{ items: unknown[]; nextCursor?: string }>(
          cfg,
          'GET',
          `/batches/${batchId}/results${cursor ? `?cursor=${cursor}` : ''}`,
        );
        print(`GET /batches/${batchId}/results`, r);
        cursor = has('all') ? r.body.nextCursor : undefined;
      } while (cursor);
      return;
    }
    case 'retry-failed': {
      const [batchId] = args;
      print(`POST /batches/${batchId}/retry-failed`, await api(cfg, 'POST', `/batches/${batchId}/retry-failed`));
      return;
    }
    case 'reupload': {
      const [batchId, imageId, file] = args;
      const t0 = Date.now();
      const p = await requestReuploadUrl(cfg, batchId, imageId);
      console.log(`presigned POST for ${imageId} (${p.filename}) -> key ${p.key}`);
      printUploads(await uploadFiles(cfg, batchId, [file], [{ ...p, filename: file.split('/').pop()! }]), t0);
      return;
    }
    case 'trace': {
      const [imageId] = args;
      const item = await getItem(cfg, `ORG#${cfg.orgId}`, `IMAGE#${imageId}`);
      if (!item) throw new Error(`no Image item ${imageId}`);
      console.log(
        `image ${imageId}  file=${item.filename ?? '-'}  status=${item.status}  currentStep=${item.currentStep ?? '-'}  sourceETag=${item.sourceETag ?? '-'}`,
      );
      if (item.error) console.log(`error: ${JSON.stringify(item.error)}`);
      const arn = item.executionArn as string | undefined;
      if (!arn) {
        console.log('no executionArn on the item (the image never reached a step)');
        return;
      }
      printTrace(arn, await traceExecution(arn));
      return;
    }

    case 'rerun-step': {
      const [imageId, stepNumber] = args;
      const { result } = await rerunStep(cfg, imageId, Number(stepNumber));
      console.log(`RunStep re-invoked for ${imageId} step ${stepNumber}:`, JSON.stringify(result));
      return;
    }
    case 'rerun-validate': {
      const [imageId] = args;
      const { payload, result } = await rerunValidate(cfg, imageId);
      console.log(`ValidateOutput re-invoked for ${imageId} (invocationId ${payload.invocation?.invocationId}):`);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    // ---- marketplace ----
    case 'policy': {
      print('PUT /org/policy', await api(cfg, 'PUT', '/org/policy', { allowThirdPartyFilters: args[0] === 'true' }));
      return;
    }
    case 'register-filter': {
      const [mode] = args;
      const arn = cfg.outputs[`Filter${mode}Arn`];
      if (!arn) throw new Error(`no output Filter${mode}Arn; modes: sepia, hostile, liar`);
      const manifest = JSON.parse(readFileSync('filters-3p/pillow-sepia/filter.json', 'utf8'));
      const filterId = flag('as') ?? `${manifest.name}${mode === 'sepia' ? '' : `-${mode}`}`;
      print(
        'POST /admin/filters',
        await api(cfg, 'POST', '/admin/filters', {
          filterId,
          version: manifest.version,
          developerId: 'dev-pillow',
          functionArn: arn,
          state: flag('state') ?? 'published',
          manifest: { ...manifest, name: filterId },
        }),
      );
      return;
    }
    case 'get-filter': {
      print(`GET /filters/${args[0]}`, await api(cfg, 'GET', `/filters/${args[0]}`));
      return;
    }
    case 'entitle': {
      const [filterId] = args;
      print(
        'POST /entitlements',
        await api(cfg, 'POST', '/entitlements', {
          filterId,
          perInvocationCents: flag('cents') ? Number(flag('cents')) : undefined,
          developerShare: flag('share') ? Number(flag('share')) : undefined,
        }),
      );
      return;
    }
    case 'invocations': {
      const month = args[0] ?? new Date().toISOString().slice(0, 7);
      printInvocations(await queryInvocations(cfg, month));
      return;
    }

    // ---- table ----
    case 'dump-table': {
      const batch = flag('batch');
      const items = batch ? await queryBatchImages(cfg, batch) : await queryOrg(cfg, flag('prefix'));
      printRows(items);
      return;
    }
    default:
      console.error('unknown command; see header of cli/aperture.ts');
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
