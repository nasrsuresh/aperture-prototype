# E6: running the same step twice changes nothing

**Claim in submission (A Decision 2, Fact 10):** Step Functions may deliver a task more than once. `RunStep` is idempotent: outputs go to deterministic keys, and `currentStep` is advanced with a conditional update (`currentStep = n-1`). `ConditionalCheckFailed` means a duplicate already did the work and counts as success.

**Prediction:** invoking the worker Lambda by hand with the exact payload of an already-completed step returns `skipped: true` (output present for the same ETag) and `advance: 'duplicate'` (conditional update refused), with no error and no change to the item.

**Commands**

```
npm run cli -- rerun-step img_40c3879b354a 2
npm run cli -- rerun-step img_40c3879b354a 1
```

**Result**

```
RunStep re-invoked for img_40c3879b354a step 2: {"outputKey":"acme/batch_ae96e797c7a6/derived/img_40c3879b354a/2","skipped":true,"advance":"duplicate"}
RunStep re-invoked for img_40c3879b354a step 1: {"outputKey":"acme/batch_ae96e797c7a6/derived/img_40c3879b354a/1","skipped":true,"advance":"duplicate"}
```

`dump-table` afterwards: `status processed, currentStep 2`, unchanged.

**Explanation:** two independent guards. The S3 side: the output key is a pure function of (org, batch, image, step), so a second run would overwrite the same object with the same bytes; here it did not even get that far because the skip check found the object with the matching `source-etag`. The DynamoDB side: the update says "set currentStep to n only if it is currently n-1"; for step 1 the item was at 2, so DynamoDB refused, and the worker treats that refusal as "someone already advanced it", not as an error. The item can only ever move forward by one, once.

**Teach-back:** _(write in your own words after reading)_
