# Prompt for the tester agent

Open a new agent chat with `~/aperture-prototype` as the workspace, with Docker
Desktop running, and paste everything below the line as the first message.
Takes about an hour; AWS cost is roughly nothing.

---

Test this project end to end and tell me what passes and what fails.

The repo is this workspace, `~/aperture-prototype`. It is an image-processing pipeline on AWS (Step Functions, Lambda, S3, DynamoDB) with a third-party filter running in an isolated VPC. The stack is already deployed to AWS account `163395467013`, region `us-east-1`, stack `AperturePrototypeStack`. `outputs.json` in the repo root has the API URL and resource names. Start by reading `README.md` and `docs/REVIEWER-GUIDE.md` (about 10 minutes). Section 4 of the guide lists known simplifications; those are not failures.

## Rules

- Use the npm scripts for all AWS access; they set `AWS_PROFILE=personal`. If you call `aws` or `cdk` directly, prefix the command with `AWS_PROFILE=personal`. Never use any other profile. Run `npm run whoami` before the first live step and stop if `Account` is not `163395467013`.
- Do not run `cdk destroy`. Do not delete anything.
- Do not change source files. If a test fails, record it; do not fix it. Do not commit or push.
- Scratch files (images, logs, the report) go under `experiments/scratch/`.
- If you redeploy with a `-c` knob for an experiment, finish with `npm run deploy` and check that `Knobs` in `outputs.json` is back to `{"breakRetry":false,"skipCheckIgnoresEtag":false,"workerTimeoutSec":900,"workerReservedConcurrency":300}`.
- Docker Desktop must be running for any deploy. If a deploy fails with "Cannot connect to the Docker daemon", run `open -a Docker`, wait 30 seconds, retry.
- Run the demo at most three times. Keep the whole session under 90 minutes. If a step blocks you for more than 10 minutes, record what you saw and move on.

## How to call the API

Every route needs headers `x-api-key: dev-key` and `x-org-id: <org>` (`[a-z0-9-]{1,32}`). Base URL is `ApiUrl` in `outputs.json`. The CLI (`npm run cli -- <command>`) wraps every route; its command list is at the top of `cli/aperture.ts`. The CLI uses org `acme` unless `APERTURE_ORG=<org>` is set. Test images: `npm run cli:gen -- experiments/scratch/imgs 20 --mb 2` (see `cli/gen-images.ts` for options, including `--random-bytes` for a file that is not an image).

## Step 1: offline tests

    npm install
    npm test                        expect: Tests: 22 passed, 22 total
    npx tsc                         expect: no output
    npm run cdk -- synth --quiet    expect: cdk.out/AperturePrototypeStack.template.json exists

## Step 2: end-to-end demo

    npm run whoami
    npm run demo 2>&1 | tee experiments/scratch/demo-$(date +%Y%m%d-%H%M%S).log

Expected summary block at the end:

    run 1: {"failed":2,"succeeded":18,"total":20} (expected 18 ok, 2 failed)
    retry: {"failed":0,"succeeded":20,"total":20} (expected 20 ok, 0 failed)
    marketplace sepia-3p: processed
    hostile filter: image processed; probes: all blocked
    liar filter: image failed, error class filter
    invocation records for the 3 single requests: 3 (expected 3: ok, ok, error)

Compare the whole output with `experiments/demo-run-2026-10-19.log`. Statuses, counts, error classes and probe results must match; timings will differ and that is fine. In the demo's traces, check that img-007's first run shows three attempts at step 2 each failing with `RetryableError`, and img-008's first run shows one attempt at step 1 failing with `TerminalError` and message prefix `input:`.

## Step 3: recorded experiments on the default deployment

Run E1, E2, E4, E6, E9, E10, E12, E13 exactly as written in `experiments/E<n>-*.md`. For each, record the command, the response, and whether it matched the file's "Result" section. The IDs in the files are from earlier sessions; create fresh pipelines, batches and images.

## Step 4: experiments that need a redeploy (do if time allows)

E3, E3b, E5b, E7, in that order. Each one: deploy with the knob named in its file, run the experiment, then `npm run deploy` to restore defaults before the next. E3b and E5b are deliberate breakages; "pass" means the system misbehaves exactly the way the file predicts. Each deploy is about 90 seconds.

## Step 5: extra checks (do all; each is one or two API calls)

| # | Do | Expect |
| --- | --- | --- |
| 1 | Any route with a wrong `x-api-key` | `401 unauthorized` |
| 2 | Any route with `x-org-id: ACME` | `400 bad_org` |
| 3 | Create a batch as `acme`, then `GET /batches/{id}` as `other-org` | `404 not_found` |
| 4 | `POST /batches/{id}/upload-urls` with `filenames: []`, then with 101 names | `400 bad_page` both times |
| 5 | Submit a batch, then submit it again | second call `409 batch_not_open` |
| 6 | Create a pipeline with 11 steps; one with an unknown `filterId`; one with `resize` width 0 | `400 invalid_input` each time, message names the problem |
| 7 | `POST /batches/{id}/retry-failed` on a completed batch with nothing failed | `400 nothing_to_retry` |
| 8 | `GET /batches/{id}/results?limit=5` and follow `cursor` to the end on the demo batch | 20 URLs total, no duplicates |
| 9 | `POST /images` with `filterId: sepia-3p`, `params: {intensity: 1.5}` | `400 invalid_input` |
| 10 | Same with `intensity: 0.5`, then `npm run cli -- image-status <id> --wait` | `202`, then `processed` |
| 11 | As a fresh org `acme-test`: `POST /images` with `sepia-3p` | `403 third_party_disabled` (no policy item means deny) |
| 12 | Same org after `PUT /org/policy {"allowThirdPartyFilters": true}` | `402 no_entitlement` |
| 13 | `npm run cli -- rerun-step <an image from today's demo> 1` | `{"skipped":true,"advance":"duplicate"}`; `currentStep` still 3 in `dump-table` |
| 14 | Upload a text file named `x.png` to a batch, submit | that image ends `failed`, error class `input`, `attempts` 1 |

## Report

Write `experiments/scratch/TEST-REPORT.md` with:

1. A table, one row per item in Steps 1–5: `test | expected | observed | pass / fail / not run`.
2. For every fail: the exact command, the full response or trace, and what the expected value was.
3. The state you left things in: `Knobs` from `outputs.json`, the `acme` org policy value (should be `true`), and whether any batch is still running.
4. Total time, number of demo runs, number of deploys.

Then give me the pass/fail counts and the list of failures in chat.
