// Per-image status via GSI1 (images by batch). Shared by the Proxy's status
// route and by Finalize.
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, env } from './clients';
import { gsi } from './keys';
import type { ImageItem, ImageStatus } from './types';

export type StatusCounts = Partial<Record<ImageStatus, number>> & { total: number };

export async function countImagesByStatus(batchId: string): Promise<StatusCounts> {
  const counts: Record<string, number> = { total: 0 };
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: env.TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :b',
        ExpressionAttributeValues: { ':b': gsi.batchImages(batchId) },
        ProjectionExpression: '#s',
        ExpressionAttributeNames: { '#s': 'status' },
        ExclusiveStartKey,
      }),
    );
    for (const it of page.Items ?? []) {
      const s = (it as { status: string }).status;
      counts[s] = (counts[s] ?? 0) + 1;
      counts.total += 1;
    }
    ExclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return counts as StatusCounts;
}

// All Image items of a batch (GSI1 projects all attributes).
export async function listBatchImages(batchId: string): Promise<ImageItem[]> {
  const items: ImageItem[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: env.TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :b',
        ExpressionAttributeValues: { ':b': gsi.batchImages(batchId) },
        ExclusiveStartKey,
      }),
    );
    items.push(...((page.Items ?? []) as ImageItem[]));
    ExclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return items;
}
