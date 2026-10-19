// The two stores. One bucket for every image byte; one DynamoDB table for
// every item (single-table design), with two GSIs:
//   GSI1: images by batch (per-image status listing)
//   GSI2: batches by organization and status (per-org running cap)
import { Duration, RemovalPolicy } from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export class Storage extends Construct {
  readonly bucket: s3.Bucket;
  readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, 'Images', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Prototype only: tear down cleanly with `cdk destroy`.
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      // Browser uploads with presigned POST need CORS from the app origin.
      cors: [
        {
          allowedMethods: [s3.HttpMethods.POST, s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
        },
      ],
      // A Decision 5: intermediate outputs are tagged and expire by lifecycle
      // rule. Design says 30 days; the prototype uses 1 so we can watch it.
      lifecycleRules: [
        {
          id: 'expire-intermediates',
          tagFilters: { intermediate: 'true' },
          expiration: Duration.days(1),
        },
      ],
    });

    this.table = new dynamodb.Table(this, 'Main', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
    });
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI2',
      partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
    });
  }
}
