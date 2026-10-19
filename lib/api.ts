// HTTP API + the Proxy Lambda. Every route goes to one function, as in the
// baseline. The function gets reserved concurrency once the account quota
// allows it (A Decision 6).
import { Duration } from 'aws-cdk-lib/core';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import type { Storage } from './storage';

export interface ApiProps {
  storage: Storage;
  sharpLayer: lambda.ILayerVersion;
  apiKey: string;
  maxUploadBytes: number;
  // undefined until the concurrency quota is raised; see README Phase 0.
  proxyReservedConcurrency?: number;
}

export const ROUTES: Array<[apigw.HttpMethod, string]> = [
  [apigw.HttpMethod.POST, '/images'],
  [apigw.HttpMethod.POST, '/pipelines'],
  [apigw.HttpMethod.GET, '/pipelines/{id}'],
  [apigw.HttpMethod.POST, '/batches'],
  [apigw.HttpMethod.POST, '/batches/{id}/upload-urls'],
  [apigw.HttpMethod.GET, '/batches/{id}'],
];

export class Api extends Construct {
  readonly httpApi: apigw.HttpApi;
  readonly proxyFn: NodejsFunction;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);
    const { storage } = props;

    this.proxyFn = new NodejsFunction(this, 'Proxy', {
      entry: 'lambdas/proxy/handler.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1769, // one full vCPU
      timeout: Duration.seconds(29), // HTTP API integration timeout is 30 s
      layers: [props.sharpLayer],
      reservedConcurrentExecutions: props.proxyReservedConcurrency,
      logGroup: new logs.LogGroup(this, 'ProxyLogs', { retention: logs.RetentionDays.ONE_WEEK }),
      environment: {
        TABLE_NAME: storage.table.tableName,
        BUCKET_NAME: storage.bucket.bucketName,
        MAX_UPLOAD_BYTES: String(props.maxUploadBytes),
        API_KEY: props.apiKey,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: {
        format: OutputFormat.CJS,
        target: 'node20',
        sourceMap: true,
        minify: false,
        // sharp comes from the layer (linux/arm64 binaries); the AWS SDK v3 is
        // in the runtime. Neither is bundled.
        externalModules: ['sharp', '@aws-sdk/*'],
      },
    });
    storage.table.grantReadWriteData(this.proxyFn);
    storage.bucket.grantReadWrite(this.proxyFn);

    this.httpApi = new apigw.HttpApi(this, 'HttpApi', { apiName: 'aperture-prototype' });
    const integration = new HttpLambdaIntegration('ProxyIntegration', this.proxyFn);
    for (const [method, path] of ROUTES) {
      this.httpApi.addRoutes({ path, methods: [method], integration });
    }
  }
}
