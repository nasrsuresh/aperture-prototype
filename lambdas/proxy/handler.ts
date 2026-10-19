// The Proxy Lambda: API Gateway forwards every route here. It does
// control-plane work only (auth, validation, metadata, presigned URLs,
// starting executions) plus the baseline synchronous single-image filter.
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { authOrg, HttpError, pathParam, toHttp } from '../shared/http';
import { postImage } from './images';
import { getPipeline, postPipeline } from './pipelines';
import { getBatch, postBatch, postUploadUrls } from './batches';

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
  try {
    const orgId = authOrg(event);
    switch (event.routeKey) {
      // Baseline: synchronous, untouched by the batch work.
      case 'POST /images':
        return await postImage(orgId, event);

      // A Decision 3: pipelines are versioned data.
      case 'POST /pipelines':
        return await postPipeline(orgId, event);
      case 'GET /pipelines/{id}':
        return await getPipeline(orgId, pathParam(event, 'id'));

      // A Decision 1 and 5: batch lifecycle.
      case 'POST /batches':
        return await postBatch(orgId, event);
      case 'POST /batches/{id}/upload-urls':
        return await postUploadUrls(orgId, pathParam(event, 'id'), event);
      case 'GET /batches/{id}':
        return await getBatch(orgId, pathParam(event, 'id'));

      default:
        throw new HttpError(404, 'not_found', `no route ${event.routeKey}`);
    }
  } catch (e) {
    return toHttp(e);
  }
};
