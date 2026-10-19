# Prompt for an independent end-to-end review

How to use: open a new agent chat with `~/aperture-prototype` as the workspace
(Docker Desktop running, AWS profile `personal` configured on this machine) and
paste everything below the line as the first message. Expect 60–90 minutes and
roughly $0 of AWS spend. The agent writes its report to
`experiments/scratch/REVIEW-REPORT.md`.

---

You are an independent reviewer of a deployed AWS prototype. You did not build it. Your job is to verify that the repository does what it claims: run its tests, run the end-to-end demo against the live stack, run the recorded experiments, probe a set of things the author did not test, check the README's claims against the code, and write a report. Treat the README and docs as claims to be checked, not as facts. Where the documentation and the system disagree, the system is the truth and the disagreement is a finding.

## Context

- Repository: this workspace (`~/aperture-prototype`, public mirror at https://github.com/nasrsuresh/aperture-prototype).
- It is a prototype of an architecture write-up. Scenario A is a bulk image-processing pipeline (presigned uploads to S3, Step Functions Distributed Map with one child workflow per image, classified failures, retry of failed images with checkpoint resume). Scenario B adds third-party filters that run as containers inside a VPC with no internet route, with output validation and per-invocation metering.
- The stack is already deployed: AWS account `163395467013`, region `us-east-1`, CloudFormation stack `AperturePrototypeStack`. `outputs.json` in the repo root has the API URL, bucket, table, and function names. Do not deploy from scratch; the stack exists.
- Read first, in this order: `README.md` (about 10 minutes), `docs/REVIEWER-GUIDE.md` (the checklist; its section 4 lists known simplifications that are not bugs; section 5 has the rules repeated below), then the first 20 lines of each `experiments/E01..E13-*.md`.

## Hard rules

1. AWS access only through the npm scripts, which force `AWS_PROFILE=personal`. If you must call `aws` or `cdk` directly, prefix the command with `AWS_PROFILE=personal`. Never use any other profile; the other profiles on this machine belong to unrelated accounts. Before the first live step run `npm run whoami` and stop if `Account` is not `163395467013`.
2. Never run `cdk destroy`. Never delete the stack, the bucket, the table, log groups, or any object you did not create during this review.
3. Do not modify source under `lambdas/`, `lib/`, `cli/`, `test/`, `filters-3p/`, or the CDK entry point. If you believe a fix is needed, describe it in the report with file and line; do not apply it. Do not commit, do not push.
4. Scratch files (test images, scripts, logs, notes, the report) go under `experiments/scratch/` (gitignored).
5. If you redeploy with a context knob (`-c ...`) for an experiment, finish with `npm run deploy` to restore defaults and confirm in `outputs.json` under `Knobs`. Never leave the stack with a non-default knob.
6. Docker Desktop must be running for any deploy (the filter container image is rebuilt from cache). If a deploy fails with "Cannot connect to the Docker daemon", run `open -a Docker`, wait 30 seconds, retry.
7. Cost discipline: idle is about $0; one demo run is about 700 Step Functions state transitions against 4,000 free per month. Do not run the demo more than three times. Do not run E7 more than once. Do not upload more than about 200 images in total.
8. Time discipline: aim for 60–90 minutes. If a step blocks you for more than 10 minutes, record what you saw and move on. Do not repeat a failing command more than twice without a new hypothesis.
9. Do not send email, post anywhere, or create AWS resources outside what the API and CLI create for you (batches, images, pipelines, entitlements, policy, filter registrations).

## Phase 0: offline checks, no AWS calls (about 5 minutes)

Run, in the repo root:

    npm install
    npm test                        expected: Tests: 22 passed, 22 total
    npx tsc                         expected: no output
    npm run cdk -- synth --quiet    expected: cdk.out/AperturePrototypeStack.template.json is written

Then inspect `cdk.out/AperturePrototypeStack.template.json` and record pass/fail with the logical resource ID for each of these:

- (a) The child state machine (`aperture-proto-image`) has a `Retry` on its task states whose `ErrorEquals` includes `RetryableError`, `Lambda.TooManyRequestsException`, `Sandbox.Timedout`, and `States.Timeout`, with `MaxAttempts` 2, `IntervalSeconds` 2, `BackoffRate` 2, `JitterStrategy` FULL.
- (b) The `InvokeFilter` state has `TimeoutSeconds` and `FunctionName` as JSONata expressions (strings wrapped in `{% ... %}`), not constants.
- (c) The parent state machine (`aperture-proto-batch`) has a Distributed Map with `ToleratedFailurePercentage` 100 and `MaxConcurrency` 50, reading items with an S3 JSON item reader.
- (d) There is no `AWS::EC2::InternetGateway` and no `AWS::EC2::NatGateway` resource.
- (e) The DynamoDB gateway endpoint's `PolicyDocument` has a `Condition` on `aws:PrincipalArn`. The S3 gateway endpoint's policy allows `s3:GetObject`, `s3:PutObject`, `s3:PutObjectTagging`, `s3:DeleteObject` on the bucket's objects and `s3:ListBucket` on the bucket, and nothing on other buckets.
- (f) The IAM role used by the three `aperture-3p-*` functions has exactly one managed policy, `AWSLambdaVPCAccessExecutionRole`, and no inline policies granting S3 or DynamoDB access.
- (g) Reserved concurrency: the Proxy function has 100, the RunStep worker has 300.

## Phase 1: the live demo (about 5 minutes)

    npm run whoami
    npm run demo 2>&1 | tee experiments/scratch/demo-$(date +%Y%m%d-%H%M%S).log

Compare with `experiments/demo-run-2026-10-19.log`. The expected summary block at the end is:

    run 1: {"failed":2,"succeeded":18,"total":20} (expected 18 ok, 2 failed)
    retry: {"failed":0,"succeeded":20,"total":20} (expected 20 ok, 0 failed)
    marketplace sepia-3p: processed
    hostile filter: image processed; probes: all blocked
    liar filter: image failed, error class filter
    invocation records for the 3 single requests: 3 (expected 3: ok, ok, error)

Any difference in statuses, counts, error classes, or probe results is a finding. Timing differences are not.

Then dig into that demo run using the batch ID and image IDs printed in the output:

- The demo output includes the traces of img-007 and img-008 for both runs (the `trace` CLI command, run afterwards, shows only the latest execution recorded on the Image item, which is the retry). In the first-run trace of img-007, expect three `attempt` lines under `RunStep` at step 2 (the `fail-inject` step), each followed by `failed RetryableError: ...`, then `RecordFailure`. Record the actual attempt count and the gaps between attempts (roughly 2 s then 4 s, with jitter). In the first-run trace of img-008, expect one `attempt` at step 1 ending in `TerminalError` with message prefix `input:` (random bytes are not an image), no second attempt. Older executions are in the Step Functions console under `aperture-proto-image`, named `<batchId>-<imageId>-<runId>`.
- `npm run cli -- dump-table --batch <batchId>`: after the retry run, every image should be `processed` with `currentStep` 3 and no `error` attribute. For img-008, `sourceETag` should equal the ETag of the current original (`AWS_PROFILE=personal aws s3api head-object --bucket <bucket> --key acme/<batchId>/originals/<imageId>`), and `derived/<imageId>/1`'s metadata `source-etag` should match it.
- Checkpoint resume, the claim in the README's A-D4 row: for img-007, `head-object` on `acme/<batchId>/derived/<imageId>/1` should show a `LastModified` from the first run (older than the retry), while `/2` and `/3` are from the retry run. The retry trace's step 1 should take about 0.2 s (a HeadObject and a conditional update) rather than the 0.4–1.4 s of a real grayscale pass. The worker also logs its decision: find the RunStep log group with `AWS_PROFILE=personal aws lambda get-function-configuration --function-name <RunStepFunctionName from outputs.json> --query LoggingConfig.LogGroup`, then `aws logs filter-log-events --log-group-name <that> --filter-pattern '"<img-007's imageId>"'` and look for `"skipDecision":{"skip":true,"reason":"same-etag"}` at `stepNumber` 1 in the retry run and `"reason":"no-output"` at steps 2 and 3. Confirm from timestamps and logs, not from the README.
- `npm run cli -- status <batchId>`: `runs` should list two runs; `counts` should be 20 succeeded, 0 failed.
- `npm run cli -- invocations`: there should be records for the three single marketplace requests in the demo (sepia `ok`, hostile `ok`, liar `error`), each with `billable` consistent with the status (error records are not billable).

## Phase 2: recorded experiments against the default deployment (20–30 minutes)

Run these as written in their files: E1, E2, E4, E6, E9, E10, E12, E13. For each, record the exact command, the response (status code and body, or the trace lines), and whether it matched the file's "Result" section. Where a file's commands reference an ID from a previous session, create fresh resources; the IDs in the files are examples, not fixtures. Images for upload can be generated with `npm run cli:gen` (see `cli/gen-images.ts` for arguments) or any PNG/JPEG under 20 MB.

## Phase 3: knob experiments (optional; do if time allows)

Each requires a redeploy with a context knob and a redeploy back, about 90 seconds each way. Pick at most two of E3, E3b, E5b, E7. E3b and E5b are deliberate breakages: the point is that the system misbehaves in exactly the predicted way, which demonstrates why the Retry list and the ETag check exist. Always end this phase with `npm run deploy` and verify `outputs.json` shows the default `Knobs`.

## Phase 4: things the author did not test (15–25 minutes)

Do at least six of these and record status code and body for each. Expected results are given where the code is explicit; where it says "record", the correct behaviour is open to opinion and your observation is the deliverable.

1. Missing or wrong `x-api-key` on any route: expect `401 unauthorized`. Missing or malformed `x-org-id` (for example `ACME`, or a 40-character string): expect `400 bad_org`.
2. Org isolation: create a batch as org `acme`, then `GET /batches/{id}` as org `other-org`: expect `404 not_found`, not `200` and not `403` (a 403 would leak that the batch exists). Try the same for `GET /pipelines/{id}` and `GET /images/{id}`.
3. `POST /batches/{id}/upload-urls` with an empty `filenames` array and with 101 entries: expect `400 bad_page` both times.
4. Upload a 21 MB file against a presigned POST: S3 should reject it (`EntityTooLarge`, HTTP 400 from S3). Then submit the batch with `confirm: true`; that image should be `missing` in the table, not `processed` and not `failed`.
5. Upload a text file named `.png`, then submit: expect the image to end `failed` with class `input`, `retryable: false`, `attempts: 1`.
6. Submit the same batch twice: the second submit should be `409 batch_not_open`.
7. Create a pipeline with 11 steps; with a step naming an unknown `filterId`; with a parameter outside its declared range (for example `resize` width 0 or `blur` sigma 1000): expect `400 invalid_input` each time, with a message that names the step and the problem.
8. `POST /batches/{id}/retry-failed` on a completed batch with nothing failed: expect `400 nothing_to_retry`. On a batch that is still running: expect `409 batch_not_completed`.
9. `GET /batches/{id}/results?limit=5` and follow `cursor` until it is absent: the total number of URLs must equal the batch's `succeeded` count, with no duplicates and no `failed` image included.
10. Fetch two of those result URLs and inspect the bytes (sharp metadata or the `file` command): dimensions should match the pipeline's final `resize` step, and the object key in the URL should be the final step's `derived/<imageId>/<lastStep>`, never an intermediate step.
11. Per-org running-batch cap: the limit is 3 running batches per org. Submit four batches quickly as one org; the fourth should get `429 org_batch_cap` while three are still running. This is timing-sensitive; a heavier pipeline (for example `blur` with sigma 50 on 20 images) keeps batches running long enough. If you cannot line it up in two tries, record that and move on.
12. Marketplace parameter validation: `POST /images` with `filterId: sepia-3p` and `intensity: 1.5` (declared max is 1): expect `400`. With `intensity: 0.5`: expect `202` and, after `image-status --wait`, `processed`.
13. Policy and entitlement ordering. A fresh org (for example `acme-review`) with no policy item at all should get `403 third_party_disabled` on a marketplace request (deny by default; confirm that is what happens). After `PUT /org/policy {"allowThirdPartyFilters": true}` as that org, the same request should get `402 no_entitlement`. For org `acme`, set the policy to `false`: a marketplace request should be `403` even though `acme` has entitlements; restore it to `true` afterwards and confirm the request is `202` again.
14. Hostile filter evidence. The demo's "probes: all blocked" line is self-reported by the filter (it returns `metrics.probes` in its response, which ends up in the child execution's output under `lastResult.filterMetrics.probes`; open the hostile image's execution in the Step Functions console, or `AWS_PROFILE=personal aws stepfunctions describe-execution --execution-arn <arn> --query output`). Record the four probe strings (internet to example.com, `list_objects_v2` on our bucket, `dynamodb.list_tables`, `head_bucket` on a foreign bucket). Then verify the boundary independently of the filter's word: `AWS_PROFILE=personal aws ec2 describe-route-tables --filters Name=vpc-id,Values=<FilterVpcId from outputs.json>` should show no `0.0.0.0/0` route anywhere, and `aws ec2 describe-vpc-endpoints --filters Name=vpc-id,Values=<FilterVpcId>` should show exactly two gateway endpoints (S3, DynamoDB) with the policies described in Phase 0 (e). Also confirm `aws lambda get-function-configuration --function-name aperture-3p-hostile` shows `VpcConfig` with the isolated subnets and the role from Phase 0 (f).
15. The envelope contract: in the execution history of a marketplace image (console, or `aws stepfunctions get-execution-history`), find the `InvokeFilter` task's input (`TaskScheduled` event parameters). Confirm it contains only `{invocationId, contractVersion, input{url, contentType, width, height, bytes}, output{url, contentType}, params, deadline}`: no table name, no object key outside the URLs, no credentials. The output URL's `X-Amz-Expires` should be the filter's `timeoutSec` plus 60 (120 for `sepia-3p`), and the `InvokeFilter` state's `TimeoutSeconds` should be `timeoutSec` plus 15 (75).
16. Idempotency under duplicate delivery: `npm run cli -- rerun-step <processedImageId> 1` on an image processed today. Expect output `{"skipped":true, "advance":"duplicate"}`, the image's `currentStep` unchanged (still 3), and `derived/<img>/1` not rewritten (same `LastModified` before and after). Intermediate objects expire after one day, so use an image from this session's demo run.

## Phase 5: claims versus code (at most 20 minutes)

Take the "decision to code" table in `README.md`. For each row, open the file it points to and confirm the code does what the row says. Flag any row where the description overstates what is implemented, and any row where the implementation does something the README does not mention and a reader would want to know (for example, a condition that only applies in one branch). Also check that the `Known simplifications` table in `docs/REVIEWER-GUIDE.md` section 4 is complete: if you find a simplification not listed there, that is a finding.

## Report

Write `experiments/scratch/REVIEW-REPORT.md` with these sections:

1. Verdict, three sentences at most: does the prototype do what the README claims? Would you trust its experiment results?
2. Check table: one row per check in Phases 0–5, columns `check | expected | observed | pass / fail / not run`.
3. Findings, ordered by severity. Each finding: what you did (exact commands), what happened, what should have happened, where in the code it originates (`file:line`, your best estimate), and whether it contradicts a claim in the README or is a gap nobody claimed to have covered. Do not list items from `docs/REVIEWER-GUIDE.md` section 4 as findings unless you disagree with the stated justification. A finding without a reproducible command is a guess; label it as such.
4. The exact state you left the stack in: `Knobs` from `outputs.json`, the IDs of batches, pipelines, images, and entitlements you created, whether anything is still running, and the org policy value.
5. Time and cost: total minutes, number of demo runs, number of deploys, number of images uploaded.

Then summarise the verdict and the top three findings in chat, in plain prose, without reproducing the whole table.
