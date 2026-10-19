// One SDK client per service, created once per Lambda environment and reused
// across invocations (module scope = warm-start cache).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export const s3 = new S3Client({});

export function envVar(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env var ${name}`);
  return v;
}

export const env = {
  get TABLE_NAME() {
    return envVar('TABLE_NAME');
  },
  get BUCKET_NAME() {
    return envVar('BUCKET_NAME');
  },
  get MAX_UPLOAD_BYTES() {
    return Number(envVar('MAX_UPLOAD_BYTES'));
  },
  get API_KEY() {
    return envVar('API_KEY');
  },
};
