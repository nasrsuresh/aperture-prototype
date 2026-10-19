// Aperture CLI. Drives the API the way a browser or customer CLI would, and
// exposes table state so each experiment is observable.
//
//   npm run cli -- single <file> <filterId> [paramsJson]
//   npm run cli -- create-pipeline <stepsJson> [--name N] [--id existingPipelineId]
//   npm run cli -- get-pipeline <pipelineId>
//   npm run cli -- create-batch <pipelineId> <version> <declaredCount>
//   npm run cli -- upload <batchId> <file...>
//   npm run cli -- status <batchId>
//   npm run cli -- dump-table [--batch <batchId>] [--prefix SKPREFIX]
import { readFileSync } from 'node:fs';
import { api, print } from './lib/api';
import { loadConfig } from './lib/config';
import { printRows, queryBatchImages, queryOrg } from './lib/table';
import { uploadFiles } from './lib/upload';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function positional(): string[] {
  const out: string[] = [];
  const argv = process.argv.slice(3);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      i += 1;
      continue;
    }
    out.push(argv[i]);
  }
  return out;
}

async function main() {
  const cfg = loadConfig();
  const cmd = process.argv[2];
  const args = positional();

  switch (cmd) {
    case 'single': {
      const [file, filterId, paramsJson] = args;
      const bytes = readFileSync(file);
      const body = { image: bytes.toString('base64'), filterId, params: paramsJson ? JSON.parse(paramsJson) : undefined };
      console.log(`file ${file}: ${bytes.length} bytes raw, ${body.image.length} bytes base64`);
      print('POST /images', await api(cfg, 'POST', '/images', body));
      return;
    }
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
      const results = await uploadFiles(cfg, batchId, files);
      for (const r of results) {
        const mb = (r.bytes / 1024 / 1024).toFixed(2);
        console.log(
          `${r.ok ? 'OK  ' : 'FAIL'} ${r.filename.padEnd(16)} ${mb.padStart(7)} MB  http ${r.status}  attempts ${r.attempts}` +
            (r.etag ? `  etag ${r.etag}` : '') +
            (r.error ? `  ${r.error}` : ''),
        );
      }
      const ok = results.filter((r) => r.ok).length;
      console.log(`${ok}/${results.length} uploaded in ${Date.now() - t0} ms`);
      return;
    }
    case 'status': {
      print(`GET /batches/${args[0]}`, await api(cfg, 'GET', `/batches/${args[0]}`));
      return;
    }
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
