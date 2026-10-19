# E3: a Lambda timeout and an error we throw are retried the same way; E3b: unless the Retry list forgets one

**Claim in submission (A Decision 4, Fact 6):** failures are classified `{class, retryable}`. Our code throws `RetryableError` / `TerminalError`; Step Functions matches on the error *name*. A Lambda timeout never runs our code, so it surfaces as `Sandbox.Timedout` (or `Lambda.Unknown`) and must be listed in `Retry` explicitly, or it falls straight to `Catch`.

**Prediction:** with the worker timeout set to 20 s, an image whose step hangs shows three `Sandbox.Timedout` attempts about 20 s apart (plus 2 s / 4 s backoff), then `RecordFailure` with `class: platform, retryable: true, attempts: 3`. An image whose step throws `RetryableError` shows the same three-attempt shape in under 10 s. With `breakRetry=true` (Retry lists only `RetryableError`), the timeout is attempted once.

**Commands**

```
AWS_PROFILE=personal npx cdk deploy --require-approval never --outputs-file outputs.json -c workerTimeoutSec=20
npm run cli -- create-pipeline '[{"filterId":"fail-inject","params":{"match":"img-001","mode":"timeout","failures":99}},
                                 {"filterId":"fail-inject","params":{"match":"img-002","mode":"retryable","failures":99}}]'
npm run cli -- create-batch <pipe> 1 2 ; upload img-001.png img-002.png ; submit ; status --wait
npm run cli -- trace <imageId>          # for each image

# E3b
AWS_PROFILE=personal npx cdk deploy ... -c workerTimeoutSec=20 -c breakRetry=true
(same batch shape with img-001 only)
```

**Result: img-001, forced hang (E3)**

```
error: {"attempts":3,"class":"platform","message":"Sandbox.Timedout: ... Task timed out after 20.00 seconds","retryable":true,"step":1}
     0.02s  attempt   RunStep
    21.10s  failed    RunStep   Sandbox.Timedout: Task timed out after 20.00 seconds
    23.16s  attempt   RunStep
    43.31s  failed    RunStep   Sandbox.Timedout
    45.41s  attempt   RunStep
    65.55s  failed    RunStep   Sandbox.Timedout
    65.57s  enter     RecordFailure
    65.76s  EXECUTION FAILED
```

**Result: img-002, thrown `RetryableError` (E3)**

```
error: {"attempts":3,"class":"platform","message":"platform: fail-inject: transient failure, attempt 3","retryable":true,"step":2}
     1.69s  attempt   RunStep
     1.96s  failed    RunStep   RetryableError: platform: fail-inject: transient failure, attempt 1
     1.98s  attempt   RunStep
     2.19s  failed    RunStep   RetryableError: ... attempt 2
     6.24s  attempt   RunStep
     6.43s  failed    RunStep   RetryableError: ... attempt 3
     6.45s  enter     RecordFailure
```

**Result: E3b, Retry list = `['RetryableError']` only**

```
     0.02s  attempt   RunStep
    20.15s  failed    RunStep   Sandbox.Timedout: Task timed out after 20.00 seconds
    20.16s  enter     RecordFailure                       <- no second attempt
    20.39s  EXECUTION FAILED
```

**Explanation:** both error kinds end up as `platform / retryable / 3 attempts` on the Image item, which is what a customer should see: "not your fault, we tried three times". Internally they are different animals. `RetryableError` is a name our code chose; Lambda reports it as `errorType` and Step Functions matches it. `Sandbox.Timedout` is raised by the Lambda service after killing our process; our code never got to classify anything. The design's Retry list therefore names both families, and E3b shows the cost of forgetting one: a transient hang becomes a permanent failure after one try. The backoff is visible in the gaps (2 s, then 4 s, with jitter, so 1.98 s and 4.05 s). RecordFailure reads the real attempt count from `$states.context.State.RetryCount`, which is why E3b recorded `attempts: 1` correctly after that fix.

**Teach-back:** _(write in your own words after reading)_
