# E12: `POST /images` with a marketplace filter answers 202, then `processed`

**Claim in submission (B Decision 1):** first-party single-image requests stay synchronous (200, as today). A single-image request that names a marketplace filter cannot be synchronous (cold container, 60 s filter timeout, isolated boundary), so it returns 202 with a status URL and runs through the same child workflow a batch step uses.

**Prediction:** `POST /images {filterId: "sepia-3p"}` returns 202 with `statusUrl: /images/<id>` in about a second; `GET /images/<id>` shows `processing` then `processed` with a presigned URL; the URL serves a 300x300 JPEG re-encoded by `ValidateOutput`. The execution has exactly one step and the same `PrepareInvocation → InvokeFilter → ValidateOutput` states as a batch.

**Commands:** `npm run demo`, section 8; or:

```
npm run cli -- single experiments/scratch/small.jpg sepia-3p '{"intensity":0.8}'
npm run cli -- image-status <imageId> --wait
npm run cli -- trace <imageId>
```

**Result**

```
POST /images -> 202 (1366 ms)
{ "imageId": "img_5bf4fba65684", "status": "processing", "statusUrl": "/images/img_5bf4fba65684", "executionArn": "...:aperture-proto-image:single-img_5bf4fba65684-run_..." }
20:35:16  status=processing
20:35:19  status=processed
GET result URL -> 200, 61885 bytes, 300x300 jpeg

trace (warm):            trace (first ever call, cold container):
  0.03s PrepareInvocation   0.03s PrepareInvocation
  0.30s ok                  1.28s ok
  0.31s InvokeFilter        1.30s InvokeFilter
  0.87s ok                  5.53s ok          <- ~4 s cold start of the Python container in the VPC
  0.88s ValidateOutput      5.55s ValidateOutput
  1.28s ok                  ...
```

**Explanation:** the request body is the same shape as the baseline (`image`, `filterId`, `params`), so the client change is "handle a 202". Server-side, the Proxy stores the original under `{org}/single/originals/{imageId}`, writes an Image item in `processing`, and starts the child state machine directly with a one-step pipeline and `batchId: "single"`; no parent, no manifest, no Map. Everything after that (URL minting, isolated invoke, validation, metering) is byte-for-byte the batch code, which is the point: one implementation of the dangerous part. The cold-start number is why this cannot be synchronous: a 4 s cold start plus up to 60 s of filter time does not fit a 29 s API timeout, and the Proxy should not hold a reserved slot waiting for someone else's container.

**Teach-back:** _(write in your own words after reading)_
