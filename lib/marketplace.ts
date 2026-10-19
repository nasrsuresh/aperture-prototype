// Scenario B, B Decision 3: the execution boundary for third-party code.
//
// In the design this is a separate AWS account. The prototype keeps the
// boundary inside one account but builds the same walls:
//   - a VPC with isolated subnets only: no internet gateway, no NAT
//   - an S3 gateway endpoint whose policy allows only our bucket's objects
//   - a DynamoDB gateway endpoint whose policy allows only ValidateOutput's role
//   - filter functions whose role can do nothing but write logs and attach ENIs
//   - filter functions run from container images (Python + Pillow here)
//
// ValidateOutput runs inside the same VPC: it is the only platform code that
// reads the filter's untrusted output, and it does so inside the boundary.
import { Duration } from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import { nodeFn } from './functions';
import type { Storage } from './storage';

export interface MarketplaceProps {
  storage: Storage;
  sharpLayer: lambda.ILayerVersion;
}

export const FILTER_FUNCTION_PREFIX = 'aperture-3p-';

export class Marketplace extends Construct {
  readonly vpc: ec2.Vpc;
  readonly filterFunctions: Record<string, lambda.DockerImageFunction>;
  readonly prepareInvocationFn: NodejsFunction;
  readonly validateOutputFn: NodejsFunction;

  constructor(scope: Construct, id: string, props: MarketplaceProps) {
    super(scope, id);
    const { storage } = props;

    this.vpc = new ec2.Vpc(this, 'FilterVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
      restrictDefaultSecurityGroup: false,
    });

    // Platform code in the boundary: ValidateOutput. Its role is the only
    // principal the DynamoDB endpoint lets through.
    this.validateOutputFn = nodeFn(this, 'ValidateOutput', {
      entry: 'lambdas/marketplace/validate-output.ts',
      memorySize: 1769,
      timeout: Duration.minutes(2),
      sharpLayer: props.sharpLayer,
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      environment: { TABLE_NAME: storage.table.tableName, BUCKET_NAME: storage.bucket.bucketName },
    });
    storage.bucket.grantReadWrite(this.validateOutputFn);
    storage.bucket.grantDelete(this.validateOutputFn);
    storage.table.grantReadWriteData(this.validateOutputFn);

    // S3: any principal, but only objects in our bucket. Presigned URLs are
    // signed by PrepareInvocation's role, so "any principal" is needed for
    // them; the resource restriction is what keeps other buckets out.
    const s3Endpoint = this.vpc.addGatewayEndpoint('S3Endpoint', { service: ec2.GatewayVpcEndpointAwsService.S3 });
    s3Endpoint.addToPolicy(
      new iam.PolicyStatement({
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: [storage.bucket.arnForObjects('*')],
      }),
    );
    // ListBucket on our bucket only: S3 needs it to answer HeadObject on a
    // missing key with 404 instead of 403 (ValidateOutput's "wrote no output"
    // check). The filter role still has no S3 permission, so IAM denies the
    // hostile filter's ListObjects regardless.
    s3Endpoint.addToPolicy(
      new iam.PolicyStatement({
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:ListBucket'],
        resources: [storage.bucket.bucketArn],
      }),
    );

    // DynamoDB: only ValidateOutput's role, only our table. Endpoint policies
    // match assumed-role sessions through aws:PrincipalArn, not through a
    // role Principal (first deploy proved that: the role denied itself).
    const ddbEndpoint = this.vpc.addGatewayEndpoint('DynamoEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });
    ddbEndpoint.addToPolicy(
      new iam.PolicyStatement({
        principals: [new iam.AnyPrincipal()],
        actions: ['dynamodb:*'],
        resources: [storage.table.tableArn, `${storage.table.tableArn}/index/*`],
        conditions: { ArnEquals: { 'aws:PrincipalArn': this.validateOutputFn.role!.roleArn } },
      }),
    );

    // The filter role: logs and ENIs. No S3, no DynamoDB, no anything.
    const filterRole = new iam.Role(this, 'FilterRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole')],
    });

    // Three deployments of the same image, differing only in FILTER_MODE:
    // the honest filter, a hostile one that probes the boundary, and one
    // that reports success without writing output.
    const image = lambda.DockerImageCode.fromImageAsset('filters-3p/pillow-sepia', {
      platform: ecr_assets.Platform.LINUX_ARM64,
    });
    this.filterFunctions = {};
    for (const mode of ['sepia', 'hostile', 'liar'] as const) {
      this.filterFunctions[mode] = new lambda.DockerImageFunction(this, `Filter-${mode}`, {
        functionName: `${FILTER_FUNCTION_PREFIX}${mode}`,
        code: image,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 1024,
        timeout: Duration.seconds(60),
        role: filterRole,
        vpc: this.vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        environment: { FILTER_MODE: mode },
        description: `Third-party marketplace filter (Python + Pillow), mode=${mode}`,
      });
    }

    // PrepareInvocation runs in the main account side: it signs URLs and
    // reads the Image item, so it has normal access and is outside the VPC.
    this.prepareInvocationFn = nodeFn(this, 'PrepareInvocation', {
      entry: 'lambdas/marketplace/prepare-invocation.ts',
      memorySize: 1769,
      timeout: Duration.seconds(30),
      sharpLayer: props.sharpLayer,
      environment: { TABLE_NAME: storage.table.tableName, BUCKET_NAME: storage.bucket.bucketName },
    });
    storage.bucket.grantReadWrite(this.prepareInvocationFn);
    storage.table.grantReadWriteData(this.prepareInvocationFn);
  }
}
