# E1: the upload size limit is enforced by S3, not by us

**Claim in submission (A Decision 1):** uploads go straight to S3 with a presigned POST whose policy carries `content-length-range`; the limit is enforced server-side by S3 and no image bytes pass through the API. A presigned PUT cannot do this.

**Prediction:** a 26 MB file against a 20 MB policy is rejected by S3 with HTTP 400 `EntityTooLarge` before any byte is stored. The same file through a presigned PUT URL is accepted.

**Commands**

```
npm run cli:gen -- experiments/scratch/e1 1 --mb 25 --prefix big
npm run cli -- create-batch <pipelineId> 1 1
npm run cli -- upload <batchId> experiments/scratch/e1/big-001.png
NODE_NO_WARNINGS=1 AWS_PROFILE=personal npx tsx experiments/e1-presigned-put.ts experiments/scratch/e1/big-001.png
```

**Result**

```
FAIL big-001.png  26.41 MB  http 400  attempts 1  EntityTooLarge: Your proposed upload exceeds the maximum allowed size
0/1 uploaded in 23531 ms

presigned PUT of 27690994 bytes -> 200 (a PUT URL has no size policy; the object is in the bucket)
```

**Explanation:** the POST policy is a signed JSON document; `content-length-range` is one of its conditions and S3 evaluates it on receipt. The client cannot loosen it because changing the policy breaks the signature. A presigned PUT signs the request headers and key, not a size, so S3 has nothing to check. This is the whole reason the design uses POST rather than the more common PUT. The 23 s is the file travelling from India to us-east-1 before S3 could say no; S3 has to read the body to know its length when the client streams it, and the CLI did not retry a 4xx.

**Teach-back:** _(write in your own words after reading)_
