# E11: a filter that says "ok" without writing anything

**Claim in submission (B Decision 2):** the filter's self-reported status never decides success. `ValidateOutput`, platform code inside the boundary, checks that the output object exists, is within size bounds, decodes as the declared format, and re-encodes it. A filter that lies is failed with `class: filter`.

**Prediction:** the `liar` build (identical to `sepia`, but skips the PUT and returns `{"status":"ok"}`) ends with the image `failed`, error class `filter`, one attempt, message naming the missing output.

**Commands:** `npm run demo`, section 10; or `single ... sepia-3p-liar` then `image-status --wait`.

**Result**

```
image status=failed
error: {"attempts":1,"class":"filter","message":"filter: reported ok but wrote no output object","retryable":false,"step":1}
invocation: sepia-3p-liar  attempt 1  status=error  billable=false  errorClass=filter
```

**Explanation:** trust nothing that comes back from third-party code except the bytes it wrote to the one key it was allowed to write. `ValidateOutput` does a `HeadObject` on the staging key: absent means the filter lied or crashed after reporting. If present, the bytes are decoded with sharp inside the VPC (so a malicious image file is parsed inside the boundary, not by the Proxy or the worker), compared with the manifest's declared format and size, and re-encoded, so downstream steps only ever read platform-produced bytes. The error is `filter`, not `platform` and not `input`: the customer's image was fine, our system was fine, the developer's code did not do its job. That class is what feeds the developer's error rate and, in the design, auto-suspension.

First run of this experiment recorded `platform: 403: UnknownError` instead. Cause: S3 answers `HeadObject` on a missing key with 403 rather than 404 when the caller lacks `s3:ListBucket`, and the S3 endpoint policy did not allow `ListBucket`. The fix allows `s3:ListBucket` on our bucket only (the filter role still has no S3 permission, so E8's probe stays denied). A good reminder that "no output" and "not allowed to look" are indistinguishable from the outside unless the permissions are right.

**Teach-back:** _(write in your own words after reading)_
