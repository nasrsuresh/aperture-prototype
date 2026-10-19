import * as cdk from 'aws-cdk-lib/core';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { Storage } from './storage';
import { Api } from './api';

// Prototype knobs. Design values are noted next to each.
const CONFIG = {
  apiKey: 'dev-key', // auth is out of scope; static key for the CLI
  maxUploadBytes: 20 * 1024 * 1024, // design: 1 GB. 20 MB keeps E1 fast.
};

export class AperturePrototypeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const storage = new Storage(this, 'Storage');

    // sharp with linux/arm64 binaries, built by `npm run layer:sharp`.
    const sharpLayer = new lambda.LayerVersion(this, 'SharpLayer', {
      code: lambda.Code.fromAsset('layers/sharp'),
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      compatibleArchitectures: [lambda.Architecture.ARM_64],
      description: 'sharp (libvips) for linux arm64',
    });

    const api = new Api(this, 'Api', {
      storage,
      sharpLayer,
      apiKey: CONFIG.apiKey,
      maxUploadBytes: CONFIG.maxUploadBytes,
      // Set once the Lambda concurrency quota is raised (A Decision 6).
      proxyReservedConcurrency: undefined,
    });

    new cdk.CfnOutput(this, 'ApiUrl', { value: api.httpApi.apiEndpoint });
    new cdk.CfnOutput(this, 'BucketName', { value: storage.bucket.bucketName });
    new cdk.CfnOutput(this, 'TableName', { value: storage.table.tableName });
    new cdk.CfnOutput(this, 'ProxyFunctionName', { value: api.proxyFn.functionName });
    new cdk.CfnOutput(this, 'MaxUploadBytes', { value: String(CONFIG.maxUploadBytes) });
  }
}
