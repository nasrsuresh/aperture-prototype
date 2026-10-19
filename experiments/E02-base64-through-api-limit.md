# E2: why the baseline `POST /images` cannot be the bulk path

**Claim in submission (Fact 1, Fact 3):** API Gateway caps a request body at 10 MB and Lambda at 6 MB for synchronous payloads; base64 inflates by a third. A 5 MB image cannot go through the baseline endpoint.

**Prediction:** a 5.3 MB PNG (7 MB as base64 inside JSON) returns 413 from API Gateway and never reaches the Proxy Lambda. A 3.2 MB PNG (4.4 MB base64) goes through and returns 200.

**Commands**

```
npm run cli:gen -- experiments/scratch/e2 1 --mb 5 --prefix five
npm run cli -- single experiments/scratch/e2/five-001.png grayscale
npm run cli:gen -- experiments/scratch/e2 1 --mb 3 --prefix three
npm run cli -- single experiments/scratch/e2/three-001.png grayscale
```

**Result**

```
five-001.png  1322x1322  5.28 MB
POST /images -> 413 (9316 ms)
{ "message": "Request Entity Too Large" }

three-001.png  1024x1024  3.17 MB
POST /images -> 200 (3754 ms)
  "status": "processed", "inputBytes": 3323967, "outputBytes": 673649
```

**Explanation:** the 413 body is API Gateway's own wording (our Lambda's errors are `{code, message}`), which shows the request was rejected at the gateway. The real limit for HTTP APIs is the Lambda synchronous payload cap of 6 MB; 5.28 MB of image is 7.0 MB of base64 plus JSON. The baseline stays as it is for small single images (a 3 MB image round-trips in under 4 s from India, most of it transfer), and everything larger, or more than one image, goes through batches.

**Teach-back:** _(write in your own words after reading)_
