# E9: a third-party step in the middle of a first-party pipeline

**Claim in submission (B Decision 2, A Decision 2):** the child workflow routes each step on its type. First-party steps call the worker; marketplace steps go `PrepareInvocation → InvokeFilter → ValidateOutput`. Both branches write to the same `derived/{image}/{n}` key layout with the same `source-etag` metadata and the same intermediate tag, so steps can be mixed freely and checkpoint resume works across them.

**Prediction:** a pipeline `grayscale → sepia-3p (intensity 0.6) → resize(500)` runs 3 images to `processed`, with the trace showing both branches in one execution. The step-2 object carries the `intermediate=true` tag and `filter: sepia-3p@1.0.0`.

**Commands**

```
npm run cli -- create-pipeline '[{"filterId":"grayscale"},{"type":"marketplace","filterId":"sepia-3p","params":{"intensity":0.6}},{"filterId":"resize","params":{"width":500}}]' --name e9-mixed
npm run cli -- create-batch <pipe> 1 3 ; upload 3 images ; submit ; status --wait
npm run cli -- trace <imageId>
aws s3api get-object-tagging / head-object on acme/<batch>/derived/<img>/2
```

**Result (first run: found a real bug)**

```
error: {"attempts":3,"class":"platform","retryable":true,"step":2,
        "message":"platform: AccessDenied: ... not authorized to perform: s3:PutObjectTagging ... because no VPC endpoint policy allows the s3:PutObjectTagging action"}
```

The single-image marketplace path (E12) had passed because there the marketplace step is the last step and the output is not tagged. Mid-pipeline, `ValidateOutput` tags the output `intermediate=true` for the lifecycle rule, and the S3 endpoint policy did not list `s3:PutObjectTagging`. Fixed in `lib/marketplace.ts`; redeployed; `retry-failed` on the same batch:

```
20:32:00  batch completed images {"total":3,"processed":3}
     0.02s  attempt  RunStep              (grayscale: skipped, output from run 1 has the same sourceETag)
     0.37s  ok       RunStep
     0.39s  attempt  PrepareInvocation
     0.71s  ok       PrepareInvocation
     0.73s  attempt  InvokeFilter          (Python + Pillow, in the VPC)
     2.03s  ok       InvokeFilter
     2.04s  attempt  ValidateOutput        (decode, re-encode, advance, meter)
     2.46s  ok       ValidateOutput
     2.47s  attempt  RunStep              (resize)
     2.72s  ok       RunStep
     2.74s  EXECUTION SUCCEEDED

derived/<img>/2 tags:     {"TagSet":[{"Key":"intermediate","Value":"true"}]}
derived/<img>/2 metadata: {"step":"2","source-etag":"8fefdf6b...","filter":"sepia-3p@1.0.0"}
```

**Explanation:** the retry trace is the nicest single picture of the design: step 1 was skipped by checkpoint resume (0.35 s, the `source-etag` matched), step 2 ran the whole marketplace detour, step 3 ran first-party, all inside one child execution with one `stepIndex` counter. The error classification also did its job on the bug: the failure was correctly recorded as `platform` (our misconfiguration, not the customer's or the developer's), retryable, and `retry-failed` after the fix needed no re-upload. The bug itself is a good example of why the boundary is built as deny-by-default: an action that was not explicitly allowed did not work, and the fix was to allow exactly that action on exactly our objects.

**Teach-back:** _(write in your own words after reading)_
