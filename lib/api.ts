// HTTP API + the Proxy Lambda. Every route goes to one function, as in the
// baseline. The function has reserved concurrency so bulk work can never
// starve the synchronous path (A Decision 6).
import { Duration } from 'aws-cdk-lib/core';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import { nodeFn } from './functions';
import type { Pipeline } from './pipeline';
import type { Storage } from './storage';

export interface ApiProps {
  storage: Storage;
  pipeline: Pipeline;
  sharpLayer: lambda.ILayerVersion;
  apiKey: string;
  maxUploadBytes: number;
  maxRunningBatchesPerOrg: number;
  proxyReservedConcurrency?: number;
}

export const ROUTES: Array<[apigw.HttpMethod, string]> = [
  [apigw.HttpMethod.POST, '/images'],
  [apigw.HttpMethod.GET, '/images/{id}'],
  [apigw.HttpMethod.POST, '/pipelines'],
  [apigw.HttpMethod.GET, '/pipelines/{id}'],
  [apigw.HttpMethod.POST, '/batches'],
  [apigw.HttpMethod.POST, '/batches/{id}/upload-urls'],
  [apigw.HttpMethod.POST, '/batches/{id}/submit'],
  [apigw.HttpMethod.GET, '/batches/{id}'],
  [apigw.HttpMethod.GET, '/batches/{id}/results'],
  [apigw.HttpMethod.POST, '/batches/{id}/retry-failed'],
  [apigw.HttpMethod.POST, '/batches/{id}/images/{imageId}/upload-url'],
  [apigw.HttpMethod.PUT, '/org/policy'],
  [apigw.HttpMethod.POST, '/entitlements'],
  [apigw.HttpMethod.POST, '/admin/filters'],
  [apigw.HttpMethod.GET, '/filters/{id}'],
];

export class Api extends Construct {
  readonly httpApi: apigw.HttpApi;
  readonly proxyFn: NodejsFunction;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);
    const { storage, pipeline } = props;

    this.proxyFn = nodeFn(this, 'Proxy', {
      entry: 'lambdas/proxy/handler.ts',
      memorySize: 1769, // one full vCPU
      timeout: Duration.seconds(29), // HTTP API integration timeout is 30 s
      sharpLayer: props.sharpLayer,
      reservedConcurrentExecutions: props.proxyReservedConcurrency,
      environment: {
        TABLE_NAME: storage.table.tableName,
        BUCKET_NAME: storage.bucket.bucketName,
        MAX_UPLOAD_BYTES: String(props.maxUploadBytes),
        MAX_RUNNING_BATCHES_PER_ORG: String(props.maxRunningBatchesPerOrg),
        API_KEY: props.apiKey,
        PARENT_SM_ARN: pipeline.parentSm.stateMachineArn,
        CHILD_SM_ARN: pipeline.childSm.stateMachineArn,
      },
    });
    storage.table.grantReadWriteData(this.proxyFn);
    storage.bucket.grantReadWrite(this.proxyFn);
    pipeline.parentSm.grantStartExecution(this.proxyFn);
    pipeline.childSm.grantStartExecution(this.proxyFn);
    pipeline.parentSm.grantRead(this.proxyFn);
    pipeline.childSm.grantRead(this.proxyFn);
    this.proxyFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['states:ListMapRuns', 'states:DescribeMapRun'], resources: ['*'] }),
    );

    this.httpApi = new apigw.HttpApi(this, 'HttpApi', { apiName: 'aperture-prototype' });
    const integration = new HttpLambdaIntegration('ProxyIntegration', this.proxyFn);
    for (const [method, path] of ROUTES) {
      this.httpApi.addRoutes({ path, methods: [method], integration });
    }
  }
}
