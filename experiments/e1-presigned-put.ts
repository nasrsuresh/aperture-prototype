// E1 counter-example: a presigned PUT URL cannot carry a size limit, so the
// same 26 MB file that the presigned POST policy rejected is accepted.
//   NODE_NO_WARNINGS=1 AWS_PROFILE=personal npx tsx experiments/e1-presigned-put.ts <file>
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { readFileSync } from 'node:fs';

async function main() {
  const o = JSON.parse(readFileSync('outputs.json', 'utf8')).AperturePrototypeStack;
  const s3 = new S3Client({});
  const key = 'acme/e1/put-test';
  const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: o.BucketName, Key: key }), { expiresIn: 300 });
  const bytes = readFileSync(process.argv[2]);
  const res = await fetch(url, { method: 'PUT', body: bytes });
  console.log(`presigned PUT of ${bytes.length} bytes -> ${res.status} (a PUT URL has no size policy; the object is in the bucket)`);
  await s3.send(new DeleteObjectCommand({ Bucket: o.BucketName, Key: key }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
