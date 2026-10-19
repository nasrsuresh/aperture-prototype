// Image-item state transitions shared by the worker and the marketplace
// branch. The conditional update is the idempotency primitive from Fact 10.
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, env } from './clients';
import { classify } from './errors';
import { nowIso, pk, sk } from './keys';
import type { ImageError, ImageItem } from './types';

export type AdvanceOutcome = 'advanced' | 'duplicate';

// Advance currentStep from n-1 to n. If the condition fails, a duplicate
// already did it (A Decision 2: "ConditionalCheckFailed means a duplicate
// already did it and counts as success").
export async function advanceStep(
  orgId: string,
  imageId: string,
  stepNumber: number,
  isLast: boolean,
): Promise<AdvanceOutcome> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: env.TABLE_NAME,
        Key: { PK: pk.org(orgId), SK: sk.image(imageId) },
        UpdateExpression: isLast
          ? 'SET currentStep = :n, #s = :status, completedAt = :now REMOVE #e'
          : 'SET currentStep = :n, #s = :status REMOVE #e',
        ConditionExpression: 'currentStep = :prev',
        ExpressionAttributeNames: { '#s': 'status', '#e': 'error' },
        ExpressionAttributeValues: {
          ':n': stepNumber,
          ':prev': stepNumber - 1,
          ':status': isLast ? 'processed' : 'processing',
          ...(isLast ? { ':now': nowIso() } : {}),
        },
      }),
    );
    return 'advanced';
  } catch (e) {
    if ((e as { name?: string }).name === 'ConditionalCheckFailedException') return 'duplicate';
    throw classify(e);
  }
}

export async function markFailed(orgId: string, imageId: string, error: ImageError, executionArn?: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: env.TABLE_NAME,
      Key: { PK: pk.org(orgId), SK: sk.image(imageId) },
      // executionArn is set here too, so an image that never reached a step
      // (throttled before its first attempt) is still traceable.
      UpdateExpression: executionArn ? 'SET #s = :failed, #e = :error, executionArn = :arn' : 'SET #s = :failed, #e = :error',
      ExpressionAttributeNames: { '#s': 'status', '#e': 'error' },
      ExpressionAttributeValues: { ':failed': 'failed', ':error': error, ...(executionArn ? { ':arn': executionArn } : {}) },
    }),
  );
}

// Record the child execution ARN on the Image item the first time a step runs.
export async function recordExecution(orgId: string, imageId: string, executionArn: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: env.TABLE_NAME,
      Key: { PK: pk.org(orgId), SK: sk.image(imageId) },
      UpdateExpression: 'SET executionArn = :arn',
      ExpressionAttributeValues: { ':arn': executionArn },
    }),
  );
}

export async function getImage(orgId: string, imageId: string): Promise<ImageItem | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: env.TABLE_NAME, Key: { PK: pk.org(orgId), SK: sk.image(imageId) } }),
  );
  return (res.Item as ImageItem | undefined) ?? null;
}
