# E8: a hostile third-party filter cannot reach anything

**Claim in submission (B Decision 3):** third-party code runs in an isolated execution boundary: a VPC with no internet gateway and no NAT, an S3 gateway endpoint whose policy admits only our bucket, a DynamoDB endpoint that admits only `ValidateOutput`'s role, and a function role that can do nothing but write logs. The filter receives presigned URLs, not credentials or bucket names.

**Prediction:** the `hostile` build of the Pillow filter, which does the real work and additionally tries (1) an HTTPS call to the internet, (2) `ListObjectsV2` on the bucket it can infer from the input URL hostname, (3) `ListTables` on DynamoDB, (4) `HeadBucket` on an unrelated public bucket, still produces a correct sepia image, and all four probes fail: the first with a network error (no route), the other three with 403.

**Commands:** `npm run demo`, section 9. Or by hand:

```
npm run cli -- register-filter hostile          # registers sepia-3p-hostile -> aperture-3p-hostile
npm run cli -- entitle sepia-3p-hostile
npm run cli -- single experiments/scratch/small.jpg sepia-3p-hostile
npm run cli -- image-status <imageId> --wait
```

**Result**

```
image status=processed
internet     blocked: URLError: <urlopen error [Errno 99] Cannot assign requested address>
listBucket   denied: AccessDenied: ... ListObjectsV2 ... User: arn:aws:sts::163395467013:assumed-role/...FilterRole... is not authorized to perform: s3:ListBucket
dynamodb     denied: ClientError: AccessDeniedException ... ListTables ... is not authorized to perform: dynamodb:ListTables
otherBucket  denied: ClientError: An error occurred (403) when calling the HeadBucket operation: Forbidden
```

**Explanation:** four different walls, and it is worth knowing which one answered.

- *internet*: there is no route. An isolated subnet has no default route, so the TCP connect fails locally (`Cannot assign requested address`) before any packet leaves. This is the strongest guarantee: exfiltration has nowhere to go.
- *listBucket on our bucket*: the request did travel, through the S3 gateway endpoint, and S3 answered 403 because the filter's IAM role has no S3 permissions at all. (The endpoint policy would also have stopped a `ListBucket` from anyone but it is written to allow it, see E11; IAM is what said no here.)
- *dynamodb*: same shape, two layers: the filter role has no DynamoDB permission, and the endpoint policy only admits `ValidateOutput`'s role (matched via `aws:PrincipalArn`).
- *otherBucket*: 403 from the S3 endpoint policy (resource not in the allow list) and from IAM.

The filter still got its job done because the two presigned URLs it was given are the one thing the walls let through: GET and PUT on two specific object keys in our bucket, signed by the platform's role, valid for the step's timeout plus a minute. That is the whole contract.

One prototype shortcut: in the design the boundary is a separate AWS account, so even a misconfigured endpoint policy would land in an account with nothing in it. Here it is one account with the same walls built inside a VPC.

**Teach-back:** _(write in your own words after reading)_
