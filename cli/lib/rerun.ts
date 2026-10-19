// Re-invoke a step's Lambda by hand with the exact payload it already ran
// with. This is how E6 and E10 show idempotency: the second call must report
// `duplicate` and change nothing.
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetExecutionHistoryCommand, SFNClient, type HistoryEvent } from '@aws-sdk/client-sfn';
import type { Config } from './config';
import { getItem } from './table';

const lambda = new LambdaClient({});
const sfn = new SFNClient({});

export async function invokeJson(functionName: string, payload: unknown): Promise<unknown> {
  const res = await lambda.send(
    new InvokeCommand({ FunctionName: functionName, Payload: Buffer.from(JSON.stringify(payload)) }),
  );
  const text = Buffer.from(res.Payload ?? []).toString('utf8');
  if (res.FunctionError) throw new Error(`${res.FunctionError}: ${text}`);
  return JSON.parse(text);
}

// Rebuild the child state for one image and one step from the table, then
// call RunStep directly (first-party steps only).
export async function rerunStep(cfg: Config, imageId: string, stepNumber: number) {
  const image = await getItem(cfg, `ORG#${cfg.orgId}`, `IMAGE#${imageId}`);
  if (!image?.batchId) throw new Error(`image ${imageId} is not a batch image`);
  const batch = await getItem(cfg, `ORG#${cfg.orgId}`, `BATCH#${image.batchId}`);
  if (!batch) throw new Error(`no batch ${image.batchId}`);
  const snapshot = await getItem(cfg, `ORG#${cfg.orgId}`, `PIPELINE#${batch.pipelineId}#V#${batch.pipelineVersion}`);
  if (!snapshot) throw new Error('no pipeline snapshot');
  const steps = snapshot.steps as Array<{ type: string }>;
  const step = steps[stepNumber - 1];
  if (!step) throw new Error(`no step ${stepNumber}`);
  if (step.type !== 'first_party') throw new Error('rerun-step handles first-party steps; use rerun-validate for marketplace');
  const payload = {
    orgId: cfg.orgId,
    batchId: image.batchId,
    imageId,
    sourceETag: image.sourceETag,
    runId: 'manual',
    steps,
    stepCount: steps.length,
    stepIndex: stepNumber - 1,
    filterVersions: {},
  };
  return { payload, result: await invokeJson(cfg.outputs.RunStepFunctionName, payload) };
}

// Find the ValidateOutput input in the image's execution history and send it
// to the function again.
export async function rerunValidate(cfg: Config, imageId: string) {
  const image = await getItem(cfg, `ORG#${cfg.orgId}`, `IMAGE#${imageId}`);
  const arn = image?.executionArn as string | undefined;
  if (!arn) throw new Error(`image ${imageId} has no executionArn`);
  const events: HistoryEvent[] = [];
  let nextToken: string | undefined;
  do {
    const page = await sfn.send(new GetExecutionHistoryCommand({ executionArn: arn, nextToken, maxResults: 500 }));
    events.push(...(page.events ?? []));
    nextToken = page.nextToken;
  } while (nextToken);

  let inValidate = false;
  let input: string | undefined;
  for (const e of events) {
    if (e.stateEnteredEventDetails) inValidate = e.stateEnteredEventDetails.name === 'ValidateOutput';
    if (inValidate && e.type === 'LambdaFunctionScheduled') input = e.lambdaFunctionScheduledEventDetails?.input;
  }
  if (!input) throw new Error('no ValidateOutput invocation in this execution');
  const payload = JSON.parse(input);
  return { payload, result: await invokeJson(cfg.outputs.ValidateOutputFunctionName, payload) };
}
