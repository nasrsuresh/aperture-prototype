# E7: the bulk worker cannot starve the synchronous API

**Claim in submission (A Decision 6, Fact 7):** the Proxy Lambda has reserved concurrency (a guaranteed slice), the worker has its own ceiling, and the Distributed Map has `MaxConcurrency`. Throttles on the worker surface as `Lambda.TooManyRequestsException`, which is in the Retry list, so they are retried with backoff rather than failing the image outright.

**Prediction:** with the worker's reserved concurrency set to 1 and a 10-image batch (2 steps each), most steps get `Lambda.TooManyRequestsException`; some images exhaust 3 attempts and fail as `platform / retryable`. Throughout, `POST /images` (single, grayscale) keeps returning 200 in its usual ~1.3 s, because the Proxy's 100 reserved slots are untouched. After restoring the worker's concurrency, `retry-failed` processes the failed ones with no change to the inputs.

**Commands**

```
AWS_PROFILE=personal npx cdk deploy ... -c workerReservedConcurrency=1
npm run cli:gen -- experiments/scratch/e7 10 --mb 1 --prefix e7
create-batch <pipe grayscale→resize> 1 10 ; upload ; submit
(in parallel) 5x: npm run cli -- single experiments/scratch/small.jpg grayscale
npm run cli -- status <batch> --wait
npm run deploy                                   # back to worker reserved = 300
npm run cli -- retry-failed <batch>; status --wait
```

**Result**

```
POST /images -> 200 (1336 ms)         <- while the batch is running
POST /images -> 200 (1346 ms)
POST /images -> 200 (1623 ms)
POST /images -> 200 (1761 ms)
POST /images -> 200 (1464 ms)

20:26:02  batch running   images {"processed":4,"uploaded":5,"failed":1}  mapRun running=8 ok=2 failed=0
20:26:11  batch completed images {"total":10,"processed":6,"failed":4}

e7-003.png  failed  {"attempts":3,"class":"platform","retryable":true,
                     "message":"Lambda.TooManyRequestsException: Rate Exceeded. (Service: Lambda, Status Code: 429 ...)"}
(3 more like it)

after restoring concurrency:  retry-failed -> 4 images;  20:27:51  batch completed images {"total":10,"processed":10}
```

**Explanation:** reserved concurrency is both a floor and a ceiling. For the Proxy it is a floor: 100 executions nobody else in the account can take, so a bulk run cannot push the synchronous endpoint into throttling. For the worker it is a ceiling: here deliberately 1, so Lambda refused most concurrent invocations with 429. Step Functions saw those as `Lambda.TooManyRequestsException`, matched the Retry list, and backed off; six images squeezed through, four did not within 3 attempts. The recorded class is `platform` and `retryable: true`, which is accurate: the customer did nothing wrong and the same input succeeds once capacity returns, which `retry-failed` showed. In production the worker ceiling is 300 and the per-batch `MaxConcurrency` is 50, so this only happens when several large batches overlap; the per-organization cap on running batches (checked at `submit` via GSI2, 429 `org_batch_cap`) bounds how much one tenant can contribute to that.

**Teach-back:** _(write in your own words after reading)_
