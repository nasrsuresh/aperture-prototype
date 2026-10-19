# E5: retry only the failed images, reuse what is still valid; E5b: what "still valid" has to mean

**Claim in submission (A Decision 4):** a retry run contains only the failed images. A step is skipped when its output already exists for the same original (`sourceETag`), so a transient failure at step 2 does not redo step 1; a re-uploaded original has a new ETag and recomputes everything.

**Prediction:** in a 20-image batch with `img-007` failing transiently at step 2 and `img-008` not being an image, run 1 ends 18/2. After re-uploading `img-008`, `retry-failed` runs exactly 2 images and ends 20/0. In the retry trace, `img-007` step 1 takes about 0.2 s (skip) instead of 1.4 s; `img-008` runs all three steps at full length. With the skip check ignoring the ETag (E5b), a re-uploaded image's step 1 is skipped and the final output is silently built from the old original.

**Commands:** `npm run demo` covers E5 (sections 3 to 5). E5b:

```
AWS_PROFILE=personal npx cdk deploy ... -c skipCheckIgnoresEtag=true
npm run cli -- create-pipeline '[{"filterId":"grayscale"},{"filterId":"fail-inject","params":{"match":"img-001","mode":"terminal","failures":1}},{"filterId":"resize","params":{"width":400}}]'
create-batch 1 image, upload img-001.png, submit, wait                      # fails at step 2
aws s3api head-object --key acme/<batch>/derived/<img>/1 --query Metadata   # source-etag = 8fef...
npm run cli -- reupload <batch> <img> img-002.png                           # different picture, same imageId
npm run cli -- retry-failed <batch>; status --wait                          # "processed"
aws s3api head-object ... derived/<img>/1 and /3
```

**Result (E5, from the demo run)**

```
run 1:  batch counts {"failed":2,"succeeded":18,"total":20}
  img-007.png: {"attempts":3,"class":"platform","retryable":true,"step":2, "message":"platform: fail-inject: transient failure, attempt 3"}
  img-008.png: {"attempts":1,"class":"input","retryable":false,"step":1, "message":"input: Input buffer contains unsupported image format"}
retry run contains 2 images (not 20)
retry:  batch counts {"failed":0,"succeeded":20,"total":20}

img-007 on retry:          img-008 on retry (new ETag):
  0.02s attempt RunStep      0.02s attempt RunStep
  0.21s ok      RunStep      0.41s ok      RunStep        <- step 1 recomputed
  0.23s attempt RunStep      0.43s attempt RunStep
  0.52s ok      RunStep      0.70s ok      RunStep
  0.53s attempt RunStep      0.71s attempt RunStep
  0.82s ok      RunStep      0.99s ok      RunStep
```

(On a warm Lambda the grayscale step on a 2 MB PNG is ~0.4 s; a skip is ~0.2 s, mostly the HeadObject and the conditional update. The first run's 1.4 s step 1 included the cold start.)

**Result (E5b, skip check ignores ETag)**

```
before retry:  derived/1 metadata {"source-etag":"8fefdf6b...","filter":"grayscale"}
re-uploaded img-002 content:  new sourceETag b1a3150e...
after retry:   Image.status=processed  Image.sourceETag=b1a3150e...
               derived/1 metadata {"source-etag":"8fefdf6b..."}     <- stale: still from the OLD original
               derived/3 metadata {"source-etag":"b1a3150e..."}     <- claims the new one, built on stale step 1
retry trace: step 1 "ok" in 0.20 s (skipped)

after restoring the real check:  rerun-step <img> 1 -> {"skipped":false,"advance":"duplicate"}; derived/1 source-etag = b1a3150e...
```

**Explanation:** "output exists" is not enough to skip; "output exists *for this original*" is. Every derived object records the ETag of the original it was computed from, and `submit`/`retry-failed` record the original's current ETag on the Image item. The skip check compares the two. E5b is the failure mode the ETag prevents: the batch reports success, every status is green, and the customer's fixed photo was never actually processed. Nothing in the control plane would catch it; only the bytes are wrong. `advance: duplicate` in the last line is the other idempotency rule at work: the conditional `currentStep` update refused to move 3 → 1, so a stray re-run cannot roll an image backwards.

**Teach-back:** _(write in your own words after reading)_
