// One way to build every Node Lambda in the stack: TypeScript bundled by
// esbuild, arm64, sharp from the layer, AWS SDK from the runtime.
import { Duration, Size } from 'aws-cdk-lib/core';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

export interface NodeFnProps {
  entry: string;
  memorySize: number;
  timeout: Duration;
  environment: Record<string, string>;
  sharpLayer?: lambda.ILayerVersion;
  reservedConcurrentExecutions?: number;
  ephemeralStorageSize?: Size;
  vpc?: lambda.FunctionOptions['vpc'];
  vpcSubnets?: lambda.FunctionOptions['vpcSubnets'];
  securityGroups?: lambda.FunctionOptions['securityGroups'];
}

export function nodeFn(scope: Construct, id: string, props: NodeFnProps): NodejsFunction {
  return new NodejsFunction(scope, id, {
    entry: props.entry,
    handler: 'handler',
    runtime: lambda.Runtime.NODEJS_20_X,
    architecture: lambda.Architecture.ARM_64,
    memorySize: props.memorySize,
    timeout: props.timeout,
    ephemeralStorageSize: props.ephemeralStorageSize,
    layers: props.sharpLayer ? [props.sharpLayer] : undefined,
    reservedConcurrentExecutions: props.reservedConcurrentExecutions,
    vpc: props.vpc,
    vpcSubnets: props.vpcSubnets,
    securityGroups: props.securityGroups,
    logGroup: new logs.LogGroup(scope, `${id}Logs`, { retention: logs.RetentionDays.ONE_WEEK }),
    environment: { ...props.environment, NODE_OPTIONS: '--enable-source-maps' },
    bundling: {
      format: OutputFormat.CJS,
      target: 'node20',
      sourceMap: true,
      minify: false,
      externalModules: ['sharp', '@aws-sdk/*'],
    },
  });
}
