// Read a child execution's history and print it as a timeline: which state
// ran, how many attempts, what error, how long. This is the "show me what
// happened to this one image" view from A Decision 4.
import {
  DescribeExecutionCommand,
  GetExecutionHistoryCommand,
  type HistoryEvent,
  SFNClient,
} from '@aws-sdk/client-sfn';

const sfn = new SFNClient({});

export interface TraceLine {
  t: number; // ms since start
  kind: string;
  state?: string;
  detail?: string;
}

export async function traceExecution(executionArn: string): Promise<{ status: string; lines: TraceLine[] }> {
  const desc = await sfn.send(new DescribeExecutionCommand({ executionArn }));
  const events: HistoryEvent[] = [];
  let nextToken: string | undefined;
  do {
    const page = await sfn.send(new GetExecutionHistoryCommand({ executionArn, nextToken, maxResults: 500 }));
    events.push(...(page.events ?? []));
    nextToken = page.nextToken;
  } while (nextToken);

  const start = events[0]?.timestamp?.getTime() ?? 0;
  const lines: TraceLine[] = [];
  const stateById = new Map<number, string>();
  let current: string | undefined;
  for (const e of events) {
    const t = (e.timestamp?.getTime() ?? start) - start;
    const type = e.type ?? '';
    if (e.stateEnteredEventDetails) {
      current = e.stateEnteredEventDetails.name;
      stateById.set(e.id ?? 0, current ?? '');
      lines.push({ t, kind: 'enter', state: current });
    } else if (type === 'TaskScheduled' || type === 'LambdaFunctionScheduled') {
      lines.push({ t, kind: 'attempt', state: current });
    } else if (type === 'TaskFailed' || type === 'LambdaFunctionFailed' || type === 'LambdaFunctionTimedOut' || type === 'TaskTimedOut') {
      const d = e.taskFailedEventDetails ?? e.lambdaFunctionFailedEventDetails ?? e.lambdaFunctionTimedOutEventDetails ?? e.taskTimedOutEventDetails;
      lines.push({ t, kind: 'failed', state: current, detail: `${d?.error ?? '?'}: ${short(d?.cause)}` });
    } else if (type === 'TaskSucceeded' || type === 'LambdaFunctionSucceeded') {
      lines.push({ t, kind: 'ok', state: current });
    } else if (type === 'ExecutionFailed') {
      lines.push({ t, kind: 'EXECUTION FAILED', detail: `${e.executionFailedEventDetails?.error ?? ''}: ${short(e.executionFailedEventDetails?.cause)}` });
    } else if (type === 'ExecutionSucceeded') {
      lines.push({ t, kind: 'EXECUTION SUCCEEDED' });
    } else if (type === 'ExecutionTimedOut') {
      lines.push({ t, kind: 'EXECUTION TIMED OUT' });
    }
  }
  return { status: desc.status ?? 'UNKNOWN', lines };
}

function short(cause?: string): string {
  if (!cause) return '';
  try {
    const j = JSON.parse(cause) as { errorMessage?: string; errorType?: string };
    if (j.errorMessage) return j.errorMessage.slice(0, 160);
  } catch {
    /* plain text */
  }
  return cause.slice(0, 160);
}

export function printTrace(executionArn: string, trace: { status: string; lines: TraceLine[] }): void {
  console.log(`execution ${executionArn.split(':').slice(-1)[0]}  status=${trace.status}`);
  for (const l of trace.lines) {
    const t = `${(l.t / 1000).toFixed(2)}s`.padStart(8);
    const kind = l.kind.padEnd(20);
    console.log(`  ${t}  ${kind} ${(l.state ?? '').padEnd(18)} ${l.detail ?? ''}`);
  }
}
