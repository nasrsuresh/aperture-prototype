# Aperture prototype

A working build of the architecture in the Aperture assessment submission:
Scenario A (bulk processing pipeline) and the Scenario B marketplace slice
(isolated third-party filter, file-based contract, metering), on a personal
AWS account, small enough to run for a few dollars.

Purpose: turn every claim in the submission into something that was run,
with the execution history or the error message to show for it.

## Account guardrails

- Stack is pinned to account `163395467013` / `us-east-1` in `bin/aperture-prototype.ts`.
  CDK refuses to deploy if the active credentials belong to any other account.
- All npm scripts force `AWS_PROFILE=personal`. Never run bare `cdk` or `aws` here.
- `npm run whoami` prints the identity the tooling will use. Run it first in every session.

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Infra | AWS CDK v2, TypeScript | Native CDK language; one toolchain for infra, Lambdas, CLI |
| Lambdas | Node 20, arm64, esbuild via `NodejsFunction` | Millisecond bundling; baseline is Node/TS so filters lift unchanged |
| Imaging | `sharp` (libvips) | Streams, fast, prebuilt arm64 binaries |
| Orchestration | Step Functions Standard, Distributed Map | As designed |
| Data | One DynamoDB table (`PK`/`SK`, two GSIs), one S3 bucket | As designed |
| Third-party filter | Python 3.12 + Pillow container | Different language from the platform on purpose: the contract is files and URLs |
| CLI | TypeScript, run with `tsx` | Drives the API, dumps table state, traces an image's execution |

## Layout

```
bin/            CDK app entry (account pin lives here)
lib/            CDK stack(s)
lambdas/
  shared/       types, error taxonomy, DynamoDB/S3 helpers, filters.ts
  proxy/        POST /images (baseline), /pipelines, /batches/*
  worker/       RunStep for first-party steps, RecordFailure, Finalize
  marketplace/  PrepareInvocation, ValidateOutput (Scenario B)
filters-3p/     third-party filter containers (Python + Pillow)
cli/            aperture CLI: create-pipeline, create-batch, upload, submit, status, results, retry-failed, dump-table, trace
experiments/    one markdown file per experiment: prediction, result, explanation
docs/           ts-reading-guide.md and walkthrough notes
```

## Slices

Each slice is built, deployed, walked through in data-flow order, then
exercised by one or more experiments. Teach-back notes go at the bottom of
the matching experiment file.

### Phase 0: account

- [x] `personal` profile configured; `npm run whoami` shows `163395467013` (2026-10-19)
- [x] Lambda concurrency quota read: **10**. Increase to 1,000 requested, request id `04f27c7dd03d4a1f9fe8366bbac24d6cGRjJ7SOV`, status PENDING (2026-10-19). Until approved: no reserved concurrency possible, `MaxConcurrency` kept at 3, A6/E7 wait.
- [ ] $10 budget alert
- [x] `cdk bootstrap` (2026-10-19)
- [x] First deploy of the empty stack: `CREATE_COMPLETE` in 11 s (2026-10-19)

### Phase 1: Scenario A

| # | Slice | Submission | Experiments |
| --- | --- | --- | --- |
| A1 | Bucket, table, HTTP API, `POST /batches`, `POST /batches/{id}/upload-urls` with presigned POST; `POST /images` baseline | D1, Fact 1, Fact 3 | E1 oversize upload rejected by POST policy, accepted by PUT; E2 base64 5 MB through API fails |
| A2 | Worker Lambda with `filters.ts`, error classes, conditional `currentStep` advance; invoked by hand | D2, D4 | E6 duplicate RunStep hits `ConditionalCheckFailed` and counts as success |
| A3 | Child state machine: `SelectStep → RunStep → Done?`, `Retry`/`Catch`, `RecordFailure` | D2, D4, Fact 6 | E3 forced timeout vs thrown error: `Sandbox.Timedout` vs `RetryableError`, both retried; E3b Retry naming only `RetryableError` falls straight to Catch |
| A4 | `POST /batches/{id}/submit` (list, reconcile, manifest, seal, start), parent machine with Distributed Map, `ResultWriter`, `Finalize` → SNS; `GET /batches/{id}`, `GET /batches/{id}/results` | D5, Fact 5, Fact 9 | E4 declare 10, upload 8: discrepancy, confirm, 2 `missing` |
| A5 | `POST /batches/{id}/retry-failed`, skip-if-output-exists for same `sourceETag`, fail-inject filter | D4 | E5 full walkthrough: 20 images, #7 fails at step 2, 19/1, retry skips step 1; re-upload changes ETag, restarts; E5b skip check without ETag runs step 2 on stale output |
| A6 | Reserved concurrency on Proxy and worker, `MaxConcurrency`, per-org running cap via GSI | D6, Fact 7 | E7 worker reserved = 1, 10-image batch: throttles retried with backoff while `POST /images` stays responsive |

### Phase 2: Scenario B (same account)

| # | Slice | Submission | Experiments |
| --- | --- | --- | --- |
| B1 | VPC with no IGW/NAT, S3 gateway endpoint with bucket-only policy, filter role (logs + ENI) | B-D1 | E8 hostile filter: `curl` to internet fails, `ListBucket` denied, other bucket denied |
| B2 | Python + Pillow filter container honoring `filter.json` and the envelope | B-D2 | E9 filter runs end to end on one image |
| B3 | `PrepareInvocation`, `Invoke` with `TimeoutSeconds`, `ValidateOutput` (exists, format, size, decode, re-encode), Invocation record via conditional put; `RecordFailure` with `errorClass` | B-D2, B-D5 | E10 retried step bills once; E11 filter returns `ok` without writing output → `ValidateOutput` fails it with class `filter` |
| B4 | `RunStep` branches on `type: marketplace`; `POST /images` with marketplace filter → 202 + `GET /images/{id}`; Entitlement check; `allowThirdPartyFilters` | B-D1, B-D5, B-D6 | E12 single-image marketplace request returns 202 then `processed`; E13 no entitlement → refused at pipeline save |

## Experiment log format

Each file in `experiments/` follows:

```
# E<n>: <title>
Claim in submission: <quote>
Prediction (before running): <one or two lines>
Command(s):
Result: <status codes, error names, item fields, execution history excerpt>
Explanation: <why; what differed from the prediction if anything>
Teach-back: <three or four sentences in my own words, corrected>
```

## Cost

Lambda, S3, DynamoDB, API Gateway, SNS: free tier at this scale.
Step Functions Standard: 4,000 free transitions/month, then $0.025 per 1,000;
a 100-image, 3-step batch is about 2,000 transitions.
VPC without NAT/IGW and the S3 gateway endpoint: $0. ECR: ~$0.10/GB-month.
`npm run cdk -- destroy` removes everything.
