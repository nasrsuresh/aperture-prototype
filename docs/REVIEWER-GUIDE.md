# Reviewer guide

This document is for an independent reviewer (person or agent) asked to check
what was built and run the tests. It lists what exists, how to verify it at
three levels of effort, what numbers to expect, and what is known to be
simplified. The README is the narrative; this is the checklist. `TESTER-PROMPT.md` in
this directory is a paste-ready brief for an agent that should run the tests
and report pass/fail.

## 1. What this is

A deployed prototype of the architecture described in the Aperture assessment
submission (`aperture/submission.md` in the author's workspace; the two
diagrams are in `docs/`). Scenario A is a bulk image-processing pipeline on
Step Functions Distributed Map. Scenario B adds third-party filters that run
as containers inside a no-egress VPC, with validation and metering.

Stack: `AperturePrototypeStack`, account `163395467013`, region `us-east-1`,
AWS CDK v2 in TypeScript. Lambdas are Node 20 on arm64 bundled by esbuild;
the third-party filter is Python 3.12 + Pillow in a container image.

## 2. Inventory

### 2.1 HTTP API (API Gateway HTTP API → one Proxy Lambda)

Every route requires headers `x-api-key: dev-key` and `x-org-id: <org>`
(`[a-z0-9-]{1,32}`). Auth is out of scope in the submission; this is the stand-in.

| Method, path | Purpose | Success |
| --- | --- | --- |
| `POST /images` | Baseline single image, base64 in JSON. First-party filter → synchronous. Marketplace filter → starts the child workflow | `200` with URL / `202` with `statusUrl` |
| `GET /images/{id}` | Status of a single image; presigned URL when `processed` | `200` |
| `POST /pipelines` | Validate and save; every save writes an immutable `PIPELINE#<p>#V#<n>` | `201 {pipelineId, version, steps}` |
| `GET /pipelines/{id}` | Current definition and version counter | `200` |
| `POST /batches` | Open a batch pinned to `pipelineId@version` with `declaredCount` | `201 {batchId}` |
| `POST /batches/{id}/upload-urls` | 1–100 filenames → presigned POSTs with `content-length-range`; Image items `pending_upload` | `200 {urls[]}` |
| `POST /batches/{id}/submit` | List S3, reconcile vs declared, write manifest, start parent. `{"confirm": true}` to accept a mismatch | `202` / `409 count_mismatch` / `429 org_batch_cap` |
| `GET /batches/{id}` | Batch item + per-image status counts + live Map Run counts | `200` |
| `GET /batches/{id}/results` | Paged (`limit`, `cursor`) presigned GETs of the final step | `200` |
| `POST /batches/{id}/retry-failed` | New run containing only `failed`/`missing` images with a present original; refreshes `sourceETag` | `202` |
| `POST /batches/{id}/images/{imageId}/upload-url` | Fresh presigned POST for one image's original key (fix, then retry) | `200` |
| `PUT /org/policy` | `{allowThirdPartyFilters: bool}` | `200` |
| `POST /entitlements` | `{filterId, perInvocationCents?, developerShare?}` | `201` |
| `POST /admin/filters` | Register a deployed `aperture-3p-*` function as a `FilterVersion` (stands in for the submission pipeline) | `201` |
| `GET /filters/{id}` | Versions, states, manifests | `200` |

Errors are `{code, message}`. Validation failures are `400 invalid_input`.

### 2.2 Lambdas

| Function (CDK id) | Role | Size |
| --- | --- | --- |
| `Api/Proxy` | All routes above; the only sync image path | 1769 MB, 29 s, reserved concurrency 100 |
| `Pipeline/RunStepFn` | First-party step: read step n−1, run filter, write step n, conditional `currentStep` advance, skip rule | 3008 MB, 10 GB /tmp, 15 min, reserved 300 |
| `Pipeline/RecordFailureFn` | Catch target: writes `{step, class, retryable, attempts, message}`; Invocation record for failed marketplace steps | 512 MB |
| `Pipeline/FinalizeFn` | `DescribeMapRun` → Batch `completed`, counts, `runs[]`, SNS publish | 512 MB |
| `Marketplace/PrepareInvocation` | Size check, width/height, two presigned URLs, `invocationId`, envelope | 1769 MB, outside the VPC |
| `Marketplace/ValidateOutput` | Inside the VPC: filter status, object exists/size/format, decode + re-encode, advance, conditional Invocation put | 1769 MB, 2 min |
| `aperture-3p-sepia`, `-hostile`, `-liar` | The third-party filter container, `FILTER_MODE` differs | 1024 MB, 60 s, role = logs + ENI only |

### 2.3 State machines

`aperture-proto-image` (child, JSONata, one per image):
`SelectStep → RouteStep → (RunStep | PrepareInvocation → InvokeFilter → ValidateOutput) → AdvanceStep → Done? → (SelectStep | ImageDone)`.
Every task has `Retry` on `[RetryableError, Lambda.TooManyRequestsException, Lambda.ServiceException, Lambda.AWSLambdaException, Lambda.SdkClientException, Lambda.Unknown, Sandbox.Timedout, States.Timeout]`, 2 retries (3 attempts), 2 s interval, backoff 2, full jitter, and `Catch States.ALL → RecordFailure → ImageFailed`. `InvokeFilter` is a `CustomState` with dynamic `FunctionName` and `TimeoutSeconds` from the pinned `FilterVersion`.

`aperture-proto-batch` (parent, JSONPath): `ProcessImages` (Distributed Map, `S3JsonItemReader` on the manifest, `MaxConcurrency 50`, `ToleratedFailurePercentage 100`, child executions via `startExecution.sync:2`, `ResultWriter` to `map-results/`) → `Finalize`.

### 2.4 Data

One DynamoDB table (`PK`, `SK`, on-demand) with `GSI1` (`GSI1PK/GSI1SK`) and `GSI2` (`GSI2PK/GSI2SK`). Item types: `Pipeline`, `PipelineVersion`, `Batch`, `Image`, `FilterVersion`, `Entitlement`, `OrgPolicy`, `Invocation`, `Chaos` (test counter). Key builders are all in `lambdas/shared/keys.ts`.

One S3 bucket: `{org}/{batch}/originals/{imageId}`, `derived/{imageId}/{n}` (metadata `source-etag`, `step`, `filter`; tag `intermediate=true` on non-final steps, lifecycle 1 day), `staging/{imageId}/{n}` (where a third-party filter writes), `manifests/{runId}.json`, `map-results/`, and `{org}/single/...` for the baseline path.

### 2.5 Isolation boundary (`lib/marketplace.ts`)

VPC with two isolated subnets, no IGW, no NAT. S3 gateway endpoint policy: `GetObject/PutObject/PutObjectTagging/DeleteObject` on our bucket's objects and `ListBucket` on our bucket, any principal. DynamoDB gateway endpoint policy: any action on our table, only when `aws:PrincipalArn` is ValidateOutput's role. Filter role: `AWSLambdaVPCAccessExecutionRole` only.

### 2.6 Tooling

- `cli/aperture.ts`: one command per route plus `trace <imageId>` (execution timeline), `dump-table`, `invocations`, `rerun-step`, `rerun-validate`. Command list in the file header.
- `cli/demo.ts` (`npm run demo`): the end-to-end run. Last recorded output: `experiments/demo-run-2026-10-19.log`.
- `test/`: 22 jest tests (error taxonomy both directions, skip rule, pipeline validation). Transformer is esbuild, no native bindings.
- `experiments/E01..E13`: claim, prediction, commands, recorded result, explanation.

## 3. How to verify

### Level 0: offline, no AWS calls (about 3 minutes)

```
cd ~/aperture-prototype
npm install
npm test                       # expect: Tests: 22 passed, 22 total
npx tsc                        # expect: no output (type-check only, noEmit)
npm run cdk -- synth --quiet   # expect: cdk.out/AperturePrototypeStack.template.json; no credentials needed (env is pinned)
```

Then read the synthesized state machines:

```
node -e "const t=require('./cdk.out/AperturePrototypeStack.template.json');for(const [k,v] of Object.entries(t.Resources)) if(v.Type==='AWS::StepFunctions::StateMachine') console.log(k, JSON.stringify(v.Properties.DefinitionString).slice(0,400))"
```

Check against 2.3: the child's `Retry` lists include `Sandbox.Timedout`; `InvokeFilter` has `TimeoutSeconds` as a JSONata expression; the parent Map has `ToleratedFailurePercentage: 100`.

### Level 1: the live stack (about 5 minutes, ~$0)

Prerequisites on this machine: AWS profile `personal` (already configured), `outputs.json` present (it is; regenerated by `npm run deploy`).

```
npm run whoami                 # expect: "Account": "163395467013". Stop if anything else.
npm run demo                   # ~100 s
```

Expected summary block at the end:

```
run 1: {"failed":2,"succeeded":18,"total":20} (expected 18 ok, 2 failed)
retry: {"failed":0,"succeeded":20,"total":20} (expected 20 ok, 0 failed)
marketplace sepia-3p: processed
hostile filter: image processed; probes: all blocked
liar filter: image failed, error class filter
invocation records for the 3 single requests: 3 (expected 3: ok, ok, error)
```

Compare the full output with `experiments/demo-run-2026-10-19.log`. Timings vary by a few hundred ms (cold starts, India ↔ us-east-1 latency); statuses, counts, error classes and the probe results should not. The demo registers the filters and creates entitlements again on every run; those routes are idempotent puts.

An email arrives at the subscribed address for each completed batch run (two per demo: the first run and the retry).

### Level 2: individual experiments (10–40 minutes)

Each `experiments/E<n>-*.md` lists its commands. E1, E2, E4, E6, E9, E10, E12, E13 run against the default deployment. E3, E3b, E5b and E7 need a redeploy with a context knob and a redeploy back:

```
npm run cdk -- deploy -c workerTimeoutSec=20                 # E3
npm run cdk -- deploy -c workerTimeoutSec=20 -c breakRetry=true   # E3b
npm run cdk -- deploy -c skipCheckIgnoresEtag=true           # E5b
npm run cdk -- deploy -c workerReservedConcurrency=1         # E7
npm run deploy                                               # always finish here
```

Each redeploy is about 90 s (Docker must be running: the container asset is rebuilt from cache). `outputs.json` → `Knobs` shows the active settings.

Useful inspection commands:

```
npm run cli -- trace <imageId>              # Step Functions timeline for one image
npm run cli -- dump-table --batch <batchId> # every Image item: status, currentStep, sourceETag, error
npm run cli -- invocations                  # this month's metering records
npm run cli -- status <batchId>             # Batch item, status counts, live Map Run counts
```

### Level 3: AWS console

- Step Functions → `aperture-proto-batch` (one execution per run) and `aperture-proto-image` (one per image per run; names are `<batch>-<image>-<run>`). The graph view of a failed child shows the three attempts and the Catch.
- DynamoDB → table named in `outputs.json` (`TableName`). Query `PK = ORG#acme`.
- S3 → bucket in `outputs.json`. Check `derived/<img>/1` metadata (`source-etag`) and tags.
- Lambda → `aperture-3p-hostile` CloudWatch logs show the probe attempts from inside the VPC.
- VPC → `FilterVpcId`: route tables have no `0.0.0.0/0` route; two gateway endpoints with policies.

## 4. Known simplifications (do not report these as bugs)

| Area | Prototype | Design |
| --- | --- | --- |
| Boundary | Same account, VPC walls | Separate AWS account |
| Worker memory / upload cap | 3008 MB / 20 MB | 10 GB / 1 GB (account quota, speed) |
| Intermediate expiry | 1 day | 30 days |
| Filter onboarding | `POST /admin/filters` registers a deployed function as `published` | Developer portal, scan, preview → published, auto-suspension |
| Filter-reported `retryable: true` errors | Recorded, not re-invoked | Retried |
| "Latest version" lookup | Lexical sort of `V#<version>` | Semver-aware |
| Staging objects | Kept (so `rerun-validate` can replay) | Expired |
| Notifications | One SNS topic, email subscription | Webhook + email |
| Auth | Static key + org header | Real auth |
| Node runtime | `nodejs20.x` (deprecation warning at deploy) | Current LTS |
| `GET /batches/{id}` | Calls `ListMapRuns` + `DescribeMapRun` per request while running | Cached / pushed |

Things that are genuinely open and worth a reviewer's opinion:

- `POST /admin/filters` is reachable with the same static key as customer routes.
- `ResultWriter` output under `map-results/` is written but not read; results come from DynamoDB.
- `RecordFailure` has its own Retry; if it fails three times the image stays `processing` with a `FAILED` execution. `Finalize` counts from Image items, so such an image would be miscounted as neither succeeded nor failed.
- The `fail-inject` filter's attempt counter is per `(batch, image, step)` across runs, so a retry run sees the continuation of the count. This is intentional for E5 but worth knowing when reading traces.

## 5. Rules for a reviewing agent

- Only `AWS_PROFILE=personal`. The npm scripts set it; do not run bare `aws` or `cdk` with any other profile. The stack is pinned to `163395467013`; CDK will refuse other accounts, the AWS CLI will not.
- Do not `cdk destroy` unless the owner asks.
- After any experiment that changed a knob, run `npm run deploy` to restore defaults.
- Scratch files go under `experiments/scratch/` (gitignored).
- Cost: idle is ~$0 (no NAT, no IGW). A demo run is ~700 Step Functions transitions against 4,000 free per month. Month-to-date spend at hand-off: $0.12. Budget alert at $10.
- If a redeploy fails with "Cannot connect to the Docker daemon", start Docker Desktop and retry.
