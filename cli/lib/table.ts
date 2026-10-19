// Dump DynamoDB items for an organization (optionally one batch) as rows, so
// state changes are visible: pending_upload -> uploaded -> processed/failed,
// currentStep advancing, sourceETag set at submit.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Config } from './config';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function queryOrg(cfg: Config, skPrefix?: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: cfg.table,
        KeyConditionExpression: skPrefix ? 'PK = :pk AND begins_with(SK, :sk)' : 'PK = :pk',
        ExpressionAttributeValues: skPrefix
          ? { ':pk': `ORG#${cfg.orgId}`, ':sk': skPrefix }
          : { ':pk': `ORG#${cfg.orgId}` },
        ExclusiveStartKey,
      }),
    );
    items.push(...((page.Items ?? []) as Record<string, unknown>[]));
    ExclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return items;
}

export async function queryBatchImages(cfg: Config, batchId: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: cfg.table,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :b',
        ExpressionAttributeValues: { ':b': `BATCH#${batchId}` },
        ExclusiveStartKey,
      }),
    );
    items.push(...((page.Items ?? []) as Record<string, unknown>[]));
    ExclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return items;
}

const COLUMNS = ['SK', 'type', 'status', 'currentStep', 'sourceETag', 'filename', 'version', 'declaredCount', 'error'];

export function printRows(items: Record<string, unknown>[]): void {
  const rows = items
    .sort((a, b) => String(a.SK).localeCompare(String(b.SK)))
    .map((it) =>
      COLUMNS.map((c) => {
        const v = it[c];
        if (v === undefined) return '';
        if (typeof v === 'object') return JSON.stringify(v);
        return String(v);
      }),
    );
  const widths = COLUMNS.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(line(COLUMNS));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
  console.log(`${rows.length} item(s)`);
}
