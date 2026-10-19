// The Proxy Lambda: API Gateway forwards every route here. It does
// control-plane work only (auth, validation, metadata, presigned URLs,
// starting executions) plus the baseline synchronous single-image filter.
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { authOrg, HttpError, pathParam, toHttp } from '../shared/http';
import { getImageRoute, postImage } from './images';
import { getPipeline, postPipeline } from './pipelines';
import {
  getBatch,
  getResults,
  postBatch,
  postRetryFailed,
  postReuploadUrl,
  postSubmit,
  postUploadUrls,
} from './batches';
import { getFilterRoute, postEntitlement, putPolicy, registerFilter } from './marketplace';

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
  try {
    const orgId = authOrg(event);
    const id = () => pathParam(event, 'id');
    switch (event.routeKey) {
      // Baseline: synchronous for first-party filters. 202 for marketplace
      // filters (B Decision 1).
      case 'POST /images':
        return await postImage(orgId, event);
      case 'GET /images/{id}':
        return await getImageRoute(orgId, id());

      // A Decision 3: pipelines are versioned data.
      case 'POST /pipelines':
        return await postPipeline(orgId, event);
      case 'GET /pipelines/{id}':
        return await getPipeline(orgId, id());

      // A Decision 1, 4 and 5: batch lifecycle.
      case 'POST /batches':
        return await postBatch(orgId, event);
      case 'POST /batches/{id}/upload-urls':
        return await postUploadUrls(orgId, id(), event);
      case 'POST /batches/{id}/submit':
        return await postSubmit(orgId, id(), event);
      case 'GET /batches/{id}':
        return await getBatch(orgId, id());
      case 'GET /batches/{id}/results':
        return await getResults(orgId, id(), event);
      case 'POST /batches/{id}/retry-failed':
        return await postRetryFailed(orgId, id());
      case 'POST /batches/{id}/images/{imageId}/upload-url':
        return await postReuploadUrl(orgId, id(), pathParam(event, 'imageId'));

      // Scenario B control plane.
      case 'PUT /org/policy':
        return await putPolicy(orgId, event);
      case 'POST /entitlements':
        return await postEntitlement(orgId, event);
      case 'POST /admin/filters':
        return await registerFilter(event);
      case 'GET /filters/{id}':
        return await getFilterRoute(id());

      default:
        throw new HttpError(404, 'not_found', `no route ${event.routeKey}`);
    }
  } catch (e) {
    return toHttp(e);
  }
};
