// Dump DynamoDB items for an organization (optionally one batch) as rows, so
// state changes are visible: pending_upload -> uploaded -> processed/failed,
// currentStep advancing, sourceETag set at submit.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Config } from './config';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function queryPk(cfg: Config, pk: string, skPrefix?: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: cfg.table,
        KeyConditionExpression: skPrefix ? 'PK = :pk AND begins_with(SK, :sk)' : 'PK = :pk',
        ExpressionAttributeValues: skPrefix ? { ':pk': pk, ':sk': skPrefix } : { ':pk': pk },
        ExclusiveStartKey,
      }),
    );
    items.push(...((page.Items ?? []) as Record<string, unknown>[]));
    ExclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return items;
}

export function queryOrg(cfg: Config, skPrefix?: string) {
  return queryPk(cfg, `ORG#${cfg.orgId}`, skPrefix);
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

export async function getItem(cfg: Config, pk: string, sk: string): Promise<Record<string, unknown> | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: cfg.table, Key: { PK: pk, SK: sk } }));
  return res.Item as Record<string, unknown> | undefined;
}

// Invocation records for an org in a month (B Decision 5 metering).
export function queryInvocations(cfg: Config, yyyymm: string) {
  return queryPk(cfg, `ORG#${cfg.orgId}#${yyyymm}`, 'INVOCATION#');
}

const DEFAULT_COLUMNS = ['SK', 'type', 'status', 'currentStep', 'sourceETag', 'filename', 'version', 'declaredCount', 'error'];
const INVOCATION_COLUMNS = ['invocationId', 'imageId', 'step', 'filterId', 'attempt', 'status', 'billable', 'durationMs', 'errorClass', 'errorMessage'];

export function printRows(items: Record<string, unknown>[], columns = DEFAULT_COLUMNS): void {
  const rows = items
    .sort((a, b) => String(a.SK).localeCompare(String(b.SK)))
    .map((it) =>
      columns.map((c) => {
        const v = it[c];
        if (v === undefined) return '';
        if (typeof v === 'object') return JSON.stringify(v).slice(0, 120);
        return String(v).slice(0, 120);
      }),
    );
  const widths = columns.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(line(columns));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
  console.log(`${rows.length} item(s)`);
}

export function printInvocations(items: Record<string, unknown>[]): void {
  printRows(items, INVOCATION_COLUMNS);
}
