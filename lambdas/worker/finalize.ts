// Finalize (A Decision 5): the Map Run's counts are the run's counts. They go
// on the Batch item as the latest run; the batch-level counts aggregate the
// Image items (so a retry run of 2 images reports 20/0 for the batch, not
// 2/0). Then notify.
import { DescribeMapRunCommand } from '@aws-sdk/client-sfn';
import { PublishCommand } from '@aws-sdk/client-sns';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { countImagesByStatus } from '../shared/batch-query';
import { ddb, env, sfn, sns } from '../shared/clients';
import { gsi, nowIso, pk, sk } from '../shared/keys';
import type { BatchCounts } from '../shared/types';

interface FinalizeInput {
  orgId: string;
  batchId: string;
  runId: string;
  mapRunArn: string;
}

export const handler = async (event: FinalizeInput) => {
  const run = await sfn.send(new DescribeMapRunCommand({ mapRunArn: event.mapRunArn }));
  const c = run.itemCounts!;
  const runCounts: BatchCounts = { total: c.total ?? 0, succeeded: c.succeeded ?? 0, failed: c.failed ?? 0 };

  const images = await countImagesByStatus(event.batchId);
  const counts: BatchCounts = {
    total: images.total - (images.missing ?? 0),
    succeeded: images.processed ?? 0,
    failed: images.failed ?? 0,
  };
  const completedAt = nowIso();

  await ddb.send(
    new UpdateCommand({
      TableName: env.TABLE_NAME,
      Key: { PK: pk.org(event.orgId), SK: sk.batch(event.batchId) },
      UpdateExpression:
        'SET #s = :completed, counts = :counts, completedAt = :now, GSI2SK = :gsi2, runs = list_append(if_not_exists(runs, :empty), :run)',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':completed': 'completed',
        ':counts': counts,
        ':now': completedAt,
        ':gsi2': gsi.batchStatus('completed', completedAt),
        ':empty': [],
        ':run': [{ runId: event.runId, mapRunArn: event.mapRunArn, counts: runCounts, completedAt }],
      },
    }),
  );

  // Webhook for API users, email for UI users; the prototype has one SNS
  // topic with an email subscription standing in for both.
  await sns.send(
    new PublishCommand({
      TopicArn: env.TOPIC_ARN,
      Subject: `Aperture batch ${event.batchId}: ${counts.succeeded}/${counts.total} succeeded`,
      Message: JSON.stringify({ event: 'batch.completed', ...event, runCounts, counts, completedAt }, null, 2),
    }),
  );

  return { batchId: event.batchId, runId: event.runId, runCounts, counts };
};
