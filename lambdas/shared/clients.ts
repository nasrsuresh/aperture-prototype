// One SDK client per service, created once per Lambda environment and reused
// across invocations (module scope = warm-start cache).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SFNClient } from '@aws-sdk/client-sfn';
import { SNSClient } from '@aws-sdk/client-sns';

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export const s3 = new S3Client({});
export const sfn = new SFNClient({});
export const sns = new SNSClient({});

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
  get PARENT_SM_ARN() {
    return envVar('PARENT_SM_ARN');
  },
  get CHILD_SM_ARN() {
    return envVar('CHILD_SM_ARN');
  },
  get TOPIC_ARN() {
    return envVar('TOPIC_ARN');
  },
  get MAX_RUNNING_BATCHES_PER_ORG() {
    return Number(process.env.MAX_RUNNING_BATCHES_PER_ORG ?? '3');
  },
  // Deliberate breakage for E5b: ignore sourceETag in the skip check.
  get SKIP_CHECK_IGNORES_ETAG() {
    return process.env.SKIP_CHECK_IGNORES_ETAG === 'true';
  },
};
