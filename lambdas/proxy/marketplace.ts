// Scenario B control plane: filter registry (FilterVersion items), per-org
// policy (allowThirdPartyFilters), entitlements with pinned price terms, and
// the resolver that pipeline validation uses for marketplace steps.
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, env } from '../shared/clients';
import type { MarketplaceResolver } from '../shared/filters';
import { HttpError, json, parseBody } from '../shared/http';
import { filterKey, nowIso, pk, sk } from '../shared/keys';
import type {
  EntitlementItem,
  FilterManifest,
  FilterVersionItem,
  FilterVersionRef,
  OrgPolicyItem,
  PipelineStep,
  PriceTerms,
} from '../shared/types';

// ---- registry ----

export async function getFilterVersion(filterId: string, version?: string): Promise<FilterVersionItem | null> {
  if (version) {
    const res = await ddb.send(
      new GetCommand({ TableName: env.TABLE_NAME, Key: { PK: pk.filter(filterId), SK: sk.filterVersion(version) } }),
    );
    return (res.Item as FilterVersionItem | undefined) ?? null;
  }
  // No version pinned: latest published (SK sort is lexical; fine for the
  // prototype's single version, noted in README).
  const res = await ddb.send(
    new QueryCommand({
      TableName: env.TABLE_NAME,
      KeyConditionExpression: 'PK = :p',
      FilterExpression: '#st = :published',
      ExpressionAttributeNames: { '#st': 'state' },
      ExpressionAttributeValues: { ':p': pk.filter(filterId), ':published': 'published' },
      ScanIndexForward: false,
    }),
  );
  return ((res.Items ?? [])[0] as FilterVersionItem | undefined) ?? null;
}

function toRef(item: FilterVersionItem): FilterVersionRef {
  return {
    filterId: item.filterId,
    version: item.version,
    developerId: item.developerId,
    functionArn: item.functionArn,
    manifest: item.manifest,
  };
}

// ---- org policy and entitlements ----

export async function getOrgPolicy(orgId: string): Promise<OrgPolicyItem | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: env.TABLE_NAME, Key: { PK: pk.org(orgId), SK: sk.policy() } }),
  );
  return (res.Item as OrgPolicyItem | undefined) ?? null;
}

export async function getEntitlement(orgId: string, filterId: string): Promise<EntitlementItem | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: env.TABLE_NAME, Key: { PK: pk.org(orgId), SK: sk.entitlement(filterId) } }),
  );
  return (res.Item as EntitlementItem | undefined) ?? null;
}

// The resolver pipeline validation calls for each marketplace step: the
// version must exist and be published, and the organization must allow
// third-party filters at all. Entitlement is an admission check (see
// `admitEntitlements`), so a pipeline can be authored before purchase.
export function resolverFor(orgId: string): MarketplaceResolver {
  return async (filterId, version) => {
    const policy = await getOrgPolicy(orgId);
    if (!policy?.allowThirdPartyFilters) {
      throw new HttpError(403, 'third_party_disabled', 'third-party filters are disabled for this organization');
    }
    const item = await getFilterVersion(filterId, version);
    if (!item) throw new HttpError(400, 'unknown_filter', `marketplace filter ${filterId}${version ? `@${version}` : ''} not found`);
    if (item.state !== 'published') {
      throw new HttpError(409, 'filter_unavailable', `filter ${filterId}@${item.version} is ${item.state}`);
    }
    return toRef(item);
  };
}

// B Decision 5: a batch (or single request) runs with the entitlements and
// price terms it was admitted with. Returns the pinned terms per filter.
export async function admitEntitlements(orgId: string, steps: PipelineStep[]): Promise<Record<string, PriceTerms>> {
  const out: Record<string, PriceTerms> = {};
  for (const step of steps) {
    if (step.type !== 'marketplace' || out[step.filterId]) continue;
    const ent = await getEntitlement(orgId, step.filterId);
    if (!ent) throw new HttpError(402, 'no_entitlement', `organization has no entitlement for filter ${step.filterId}`);
    out[step.filterId] = ent.priceTerms;
  }
  return out;
}

// The child workflow carries function ARNs and manifests for every marketplace
// step so it never reads the registry mid-run.
export async function buildFilterVersions(steps: PipelineStep[]): Promise<Record<string, FilterVersionRef>> {
  const out: Record<string, FilterVersionRef> = {};
  for (const step of steps) {
    if (step.type !== 'marketplace') continue;
    const key = filterKey(step.filterId, step.version);
    if (out[key]) continue;
    const item = await getFilterVersion(step.filterId, step.version);
    if (!item) throw new HttpError(409, 'filter_unavailable', `filter ${key} disappeared`);
    if (item.state === 'suspended' || item.state === 'retired') {
      throw new HttpError(409, 'filter_unavailable', `filter ${key} is ${item.state}`);
    }
    out[key] = toRef(item);
  }
  return out;
}

// ---- routes ----

interface PolicyBody {
  allowThirdPartyFilters: boolean;
}

export async function putPolicy(orgId: string, event: APIGatewayProxyEventV2) {
  const body = parseBody<PolicyBody>(event);
  if (typeof body.allowThirdPartyFilters !== 'boolean') {
    throw new HttpError(400, 'bad_policy', 'allowThirdPartyFilters (boolean) required');
  }
  const now = nowIso();
  const item: OrgPolicyItem = {
    PK: pk.org(orgId),
    SK: sk.policy(),
    type: 'OrgPolicy',
    orgId,
    allowThirdPartyFilters: body.allowThirdPartyFilters,
    createdAt: now,
    updatedAt: now,
  };
  await ddb.send(new PutCommand({ TableName: env.TABLE_NAME, Item: item }));
  return json(200, { orgId, allowThirdPartyFilters: item.allowThirdPartyFilters });
}

interface EntitlementBody {
  filterId: string;
  perInvocationCents?: number;
  developerShare?: number;
}

export async function postEntitlement(orgId: string, event: APIGatewayProxyEventV2) {
  const body = parseBody<EntitlementBody>(event);
  if (!body.filterId) throw new HttpError(400, 'bad_entitlement', 'filterId required');
  const latest = await getFilterVersion(body.filterId);
  if (!latest) throw new HttpError(400, 'unknown_filter', `marketplace filter ${body.filterId} not found`);
  const item: EntitlementItem = {
    PK: pk.org(orgId),
    SK: sk.entitlement(body.filterId),
    type: 'Entitlement',
    orgId,
    filterId: body.filterId,
    priceTerms: { perInvocationCents: body.perInvocationCents ?? 2, developerShare: body.developerShare ?? 0.7 },
    createdAt: nowIso(),
  };
  await ddb.send(new PutCommand({ TableName: env.TABLE_NAME, Item: item }));
  return json(201, { orgId, filterId: item.filterId, priceTerms: item.priceTerms });
}

// Stands in for the submission pipeline's last step ("published"). In the
// design this is driven by the developer portal after scan and validation;
// here the operator registers the deployed function directly.
interface RegisterFilterBody {
  filterId: string;
  version: string;
  developerId: string;
  functionArn: string;
  imageDigest?: string;
  state?: FilterVersionItem['state'];
  manifest: FilterManifest;
}

export async function registerFilter(event: APIGatewayProxyEventV2) {
  const body = parseBody<RegisterFilterBody>(event);
  for (const f of ['filterId', 'version', 'developerId', 'functionArn', 'manifest'] as const) {
    if (!body[f]) throw new HttpError(400, 'bad_filter', `${f} required`);
  }
  if (!body.functionArn.includes(':function:aperture-3p-')) {
    throw new HttpError(400, 'bad_filter', 'functionArn must be an aperture-3p-* function (the execution boundary)');
  }
  const m = body.manifest;
  if (!m.limits?.timeoutSec || !m.input?.maxBytes || !m.output?.format || !m.params?.properties) {
    throw new HttpError(400, 'bad_manifest', 'manifest needs params.properties, input.maxBytes, output.format, limits.timeoutSec');
  }
  const item: FilterVersionItem = {
    PK: pk.filter(body.filterId),
    SK: sk.filterVersion(body.version),
    type: 'FilterVersion',
    filterId: body.filterId,
    version: body.version,
    developerId: body.developerId,
    functionArn: body.functionArn,
    imageDigest: body.imageDigest ?? 'unknown',
    state: body.state ?? 'published',
    manifest: m,
    createdAt: nowIso(),
  };
  await ddb.send(new PutCommand({ TableName: env.TABLE_NAME, Item: item }));
  return json(201, { filterId: item.filterId, version: item.version, state: item.state, functionArn: item.functionArn });
}

export async function getFilterRoute(filterId: string) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: env.TABLE_NAME,
      KeyConditionExpression: 'PK = :p',
      ExpressionAttributeValues: { ':p': pk.filter(filterId) },
    }),
  );
  const versions = ((res.Items ?? []) as FilterVersionItem[]).map((v) => ({
    version: v.version,
    state: v.state,
    developerId: v.developerId,
    functionArn: v.functionArn,
    manifest: v.manifest,
  }));
  if (versions.length === 0) throw new HttpError(404, 'not_found', `filter ${filterId}`);
  return json(200, { filterId, versions });
}
