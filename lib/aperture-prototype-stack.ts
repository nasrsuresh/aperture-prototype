import * as cdk from 'aws-cdk-lib/core';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { Api } from './api';
import { Marketplace } from './marketplace';
import { Pipeline } from './pipeline';
import { Storage } from './storage';

// Prototype knobs. Design values are noted next to each.
export const CONFIG = {
  apiKey: 'dev-key', // auth is out of scope; static key for the CLI
  maxUploadBytes: 20 * 1024 * 1024, // design: 1 GB. 20 MB keeps experiments fast.
  notifyEmail: 'suresh.iit.product@gmail.com',
  // A Decision 2 / 6: concurrency. Account quota is 1000.
  proxyReservedConcurrency: 100, // design: a guaranteed slice for the synchronous API
  workerReservedConcurrency: 300, // design: the bulk worker's ceiling
  mapMaxConcurrency: 50, // design: per-batch Map concurrency
  maxRunningBatchesPerOrg: 3, // design: per-organization cap
};

export class AperturePrototypeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Deliberate breakages for experiments E3b and E5b:
    //   cdk deploy -c breakRetry=true
    //   cdk deploy -c skipCheckIgnoresEtag=true
    const breakRetry = this.node.tryGetContext('breakRetry') === 'true';
    const skipCheckIgnoresEtag = this.node.tryGetContext('skipCheckIgnoresEtag') === 'true';
    // Experiment knobs (E3 forced timeout, E7 throttling):
    //   cdk deploy -c workerTimeoutSec=20
    //   cdk deploy -c workerReservedConcurrency=1
    const workerTimeoutSec = Number(this.node.tryGetContext('workerTimeoutSec') ?? 15 * 60);
    const workerReservedConcurrency = Number(
      this.node.tryGetContext('workerReservedConcurrency') ?? CONFIG.workerReservedConcurrency,
    );

    const storage = new Storage(this, 'Storage');

    // sharp with linux/arm64 binaries, built by `npm run layer:sharp`.
    const sharpLayer = new lambda.LayerVersion(this, 'SharpLayer', {
      code: lambda.Code.fromAsset('layers/sharp'),
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      compatibleArchitectures: [lambda.Architecture.ARM_64],
      description: 'sharp (libvips) for linux arm64',
    });

    const marketplace = new Marketplace(this, 'Marketplace', { storage, sharpLayer });

    const pipeline = new Pipeline(this, 'Pipeline', {
      storage,
      sharpLayer,
      notifyEmail: CONFIG.notifyEmail,
      workerReservedConcurrency,
      workerTimeoutSec,
      maxConcurrency: CONFIG.mapMaxConcurrency,
      prepareInvocationFn: marketplace.prepareInvocationFn,
      validateOutputFn: marketplace.validateOutputFn,
      breakRetry,
      skipCheckIgnoresEtag,
    });

    const api = new Api(this, 'Api', {
      storage,
      pipeline,
      sharpLayer,
      apiKey: CONFIG.apiKey,
      maxUploadBytes: CONFIG.maxUploadBytes,
      maxRunningBatchesPerOrg: CONFIG.maxRunningBatchesPerOrg,
      proxyReservedConcurrency: CONFIG.proxyReservedConcurrency,
    });

    new cdk.CfnOutput(this, 'ApiUrl', { value: api.httpApi.apiEndpoint });
    new cdk.CfnOutput(this, 'BucketName', { value: storage.bucket.bucketName });
    new cdk.CfnOutput(this, 'TableName', { value: storage.table.tableName });
    new cdk.CfnOutput(this, 'ProxyFunctionName', { value: api.proxyFn.functionName });
    new cdk.CfnOutput(this, 'RunStepFunctionName', { value: pipeline.runStepFn.functionName });
    new cdk.CfnOutput(this, 'ParentStateMachineArn', { value: pipeline.parentSm.stateMachineArn });
    new cdk.CfnOutput(this, 'ChildStateMachineArn', { value: pipeline.childSm.stateMachineArn });
    new cdk.CfnOutput(this, 'FilterVpcId', { value: marketplace.vpc.vpcId });
    new cdk.CfnOutput(this, 'MaxUploadBytes', { value: String(CONFIG.maxUploadBytes) });
    new cdk.CfnOutput(this, 'Knobs', {
      value: JSON.stringify({ breakRetry, skipCheckIgnoresEtag, workerTimeoutSec, workerReservedConcurrency }),
    });
    new cdk.CfnOutput(this, 'ValidateOutputFunctionName', { value: marketplace.validateOutputFn.functionName });
    for (const [mode, fn] of Object.entries(marketplace.filterFunctions)) {
      new cdk.CfnOutput(this, `Filter${mode}Arn`, { value: fn.functionArn });
    }
  }
}
