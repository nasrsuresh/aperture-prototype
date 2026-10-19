// Helpers for the HTTP API (API Gateway v2, payload format 2.0).
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { env } from './clients';
import { TerminalError } from './errors';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function json(status: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export function parseBody<T>(event: APIGatewayProxyEventV2): T {
  if (!event.body) throw new HttpError(400, 'empty_body', 'request body required');
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, 'bad_json', 'body is not valid JSON');
  }
}

// Auth is out of scope for both scenarios (cut.md). The prototype uses a
// static key plus an explicit organization header so items land under the
// right ORG#<o> partition.
const ORG_RE = /^[a-z0-9-]{1,32}$/;

export function authOrg(event: APIGatewayProxyEventV2): string {
  const headers = event.headers ?? {};
  const key = headers['x-api-key'];
  if (key !== env.API_KEY) throw new HttpError(401, 'unauthorized', 'bad or missing x-api-key');
  const org = headers['x-org-id'];
  if (!org || !ORG_RE.test(org)) throw new HttpError(400, 'bad_org', 'x-org-id header required: [a-z0-9-]{1,32}');
  return org;
}

export function pathParam(event: APIGatewayProxyEventV2, name: string): string {
  const v = event.pathParameters?.[name];
  if (!v) throw new HttpError(400, 'bad_path', `missing path parameter ${name}`);
  return v;
}

// Map internal errors to HTTP. A TerminalError('input') raised during
// validation is the caller's fault: 400 with the message.
export function toHttp(e: unknown): APIGatewayProxyStructuredResultV2 {
  if (e instanceof HttpError) return json(e.status, { code: e.code, message: e.message });
  if (e instanceof TerminalError && e.cls === 'input') return json(400, { code: 'invalid_input', message: e.message });
  console.error('unhandled', e);
  return json(500, { code: 'internal', message: 'internal error' });
}
