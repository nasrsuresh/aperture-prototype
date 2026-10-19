# E4: declared 5, uploaded 3

**Claim in submission (A Decision 5, Fact 9):** S3 does not tell us when a presigned upload lands, so `submit` lists the batch's prefix, reconciles against the declared count, and asks the customer to confirm a discrepancy rather than guessing.

**Prediction:** `submit` returns 409 `count_mismatch` naming the two missing images; `submit --confirm` runs with the three present, marks the other two `missing`, and the batch completes 3 processed / 2 missing.

**Commands**

```
npm run cli -- create-batch <pipe> 1 5
npm run cli -- upload <batch> img-001.png img-002.png img-003.png
curl -X POST .../batches/<batch>/upload-urls -d '{"filenames":["never-1.png","never-2.png"]}'   # minted, never used
npm run cli -- submit <batch>
npm run cli -- submit <batch> --confirm
npm run cli -- status <batch> --wait
npm run cli -- dump-table --batch <batch>
```

**Result**

```
POST /batches/batch_6597314544fd/submit -> 409
  "code": "count_mismatch",
  "message": "declared 5, uploaded 3, missing 2; re-submit with {\"confirm\": true} to run with what is there",
  "missingImages": [ {"imageId":"img_325a3d472561","filename":"never-1.png"}, {"imageId":"img_628157175261","filename":"never-2.png"} ]

POST .../submit {"confirm":true} -> 202   "uploaded": 3, "missing": 2
20:16:10  batch completed images {"total":5,"processed":3,"missing":2}

IMAGE#img_0dab19390974  processed  2  8fefdf6b...  img-001.png
IMAGE#img_325a3d472561  missing    0               never-1.png
IMAGE#img_628157175261  missing    0               never-2.png
IMAGE#img_d50c92e4d809  processed  2  b1a3150e...  img-002.png
IMAGE#img_de60b18e8021  processed  2  89a5b322...  img-003.png
```

**Explanation:** `submit` is where S3 and DynamoDB are brought into agreement. Every Image item created by `upload-urls` is looked up in the S3 listing: present means `uploaded` with its ETag recorded (that ETag is what checkpoint resume keys on later), absent means `missing`. The manifest written for the Distributed Map contains only the three uploaded images, so the Map Run reports 3 total, not 5, while the batch-level view still shows the two missing ones. `missing` images can be uploaded later via the per-image `upload-url` route and picked up by `retry-failed`.

**Teach-back:** _(write in your own words after reading)_
