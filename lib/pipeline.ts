// Scenario A, A Decision 2 and 4: the two state machines.
//
// Child ("one image, all steps"): a loop SelectStep -> RouteStep -> run the
// step -> AdvanceStep -> Done?. First-party steps call the worker Lambda.
// Marketplace steps go PrepareInvocation -> InvokeFilter -> ValidateOutput.
// Every task has the same Retry list (our RetryableError plus Lambda-level
// failures) and a Catch to RecordFailure.
//
// Parent ("one batch"): a Distributed Map over manifest.json that starts one
// child execution per image, then Finalize.
import { Duration, Size, Stack } from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import { nodeFn } from './functions';
import { FILTER_FUNCTION_PREFIX } from './marketplace';
import type { Storage } from './storage';

export interface PipelineProps {
  storage: Storage;
  sharpLayer: lambda.ILayerVersion;
  notifyEmail: string;
  workerReservedConcurrency?: number;
  workerTimeoutSec: number;
  maxConcurrency: number;
  prepareInvocationFn: NodejsFunction;
  validateOutputFn: NodejsFunction;
  // Deliberate breakages for the experiments.
  breakRetry: boolean; // E3b: Retry matches only RetryableError
  skipCheckIgnoresEtag: boolean; // E5b: skip check ignores sourceETag
}

// The errors Step Functions retries (A Decision 4). RetryableError is ours;
// the rest are raised by the Lambda service, not by our code.
export const RETRYABLE_ERRORS = [
  'RetryableError',
  'Lambda.TooManyRequestsException',
  'Lambda.ServiceException',
  'Lambda.AWSLambdaException',
  'Lambda.SdkClientException',
  'Lambda.Unknown',
  'Sandbox.Timedout',
  'States.Timeout',
];

export class Pipeline extends Construct {
  readonly childSm: sfn.StateMachine;
  readonly parentSm: sfn.StateMachine;
  readonly runStepFn: NodejsFunction;
  readonly recordFailureFn: NodejsFunction;
  readonly finalizeFn: NodejsFunction;
  readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props: PipelineProps) {
    super(scope, id);
    const { storage } = props;
    const stack = Stack.of(this);
    const common = { TABLE_NAME: storage.table.tableName, BUCKET_NAME: storage.bucket.bucketName };

    // ---- Lambdas ----

    // The worker: the only function that handles image bytes in bulk.
    // Design: 10 GB memory and /tmp, 15 min, so the 1 GB limit fits. New AWS
    // accounts cap Lambda memory at 3008 MB until a quota increase, so the
    // prototype uses that; /tmp is 10 GB as designed.
    this.runStepFn = nodeFn(this, 'RunStepFn', {
      entry: 'lambdas/worker/run-step.ts',
      memorySize: 3008,
      ephemeralStorageSize: Size.gibibytes(10),
      timeout: Duration.seconds(props.workerTimeoutSec),
      sharpLayer: props.sharpLayer,
      reservedConcurrentExecutions: props.workerReservedConcurrency,
      environment: { ...common, SKIP_CHECK_IGNORES_ETAG: String(props.skipCheckIgnoresEtag) },
    });
    storage.bucket.grantReadWrite(this.runStepFn);
    storage.table.grantReadWriteData(this.runStepFn);

    this.recordFailureFn = nodeFn(this, 'RecordFailureFn', {
      entry: 'lambdas/worker/record-failure.ts',
      memorySize: 512,
      timeout: Duration.seconds(30),
      environment: common,
    });
    storage.table.grantReadWriteData(this.recordFailureFn);

    this.topic = new sns.Topic(this, 'Notifications', { displayName: 'Aperture batch notifications' });
    this.topic.addSubscription(new subs.EmailSubscription(props.notifyEmail));

    this.finalizeFn = nodeFn(this, 'FinalizeFn', {
      entry: 'lambdas/worker/finalize.ts',
      memorySize: 512,
      timeout: Duration.minutes(2),
      environment: { ...common, TOPIC_ARN: this.topic.topicArn },
    });
    storage.table.grantReadWriteData(this.finalizeFn);
    this.topic.grantPublish(this.finalizeFn);
    this.finalizeFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['states:DescribeMapRun'],
        resources: [`arn:aws:states:${stack.region}:${stack.account}:mapRun:*`],
      }),
    );

    // ---- Child state machine (JSONata) ----

    const retry: sfn.RetryProps = {
      errors: props.breakRetry ? ['RetryableError'] : RETRYABLE_ERRORS,
      interval: Duration.seconds(2),
      maxAttempts: 2, // 3 attempts in total
      backoffRate: 2,
      jitterStrategy: sfn.JitterType.FULL,
    };

    // Every task's payload is the whole state plus the execution id, and its
    // output merges the result back into the state. `$states.input` is the
    // state's input, `$states.result` the Lambda's return value.
    const payload = sfn.TaskInput.fromText("{% $merge([$states.input, {'executionArn': $states.context.Execution.Id}]) %}");
    // RetryCount is how many retries the state made before giving up, so the
    // recorded attempt count is exact whatever the Retry list says.
    const catchOutput = (state: string) =>
      `{% $merge([$states.input, {'failure': $states.errorOutput, 'failedState': '${state}', 'attempts': $states.context.State.RetryCount + 1}]) %}`;

    const recordFailure = tasks.LambdaInvoke.jsonata(this, 'RecordFailure', {
      lambdaFunction: this.recordFailureFn,
      payload,
      payloadResponseOnly: true,
      retryOnServiceExceptions: false, // one explicit Retry list, so experiments see exactly what is configured
      outputs: '{% $states.input %}',
    });
    recordFailure.addRetry({ ...retry, errors: RETRYABLE_ERRORS });
    const imageFailed = sfn.Fail.jsonata(this, 'ImageFailed', {
      error: '{% $states.input.failure.Error %}',
      cause: '{% $states.input.failure.Cause %}',
    });
    recordFailure.next(imageFailed);

    const selectStep = sfn.Pass.jsonata(this, 'SelectStep', {
      outputs:
        "{% $merge([$states.input, {'step': $states.input.steps[$states.input.stepIndex], 'invocation': null, 'filterResult': null, 'lastResult': null}]) %}",
    });

    const runStep = tasks.LambdaInvoke.jsonata(this, 'RunStep', {
      lambdaFunction: this.runStepFn,
      payload,
      payloadResponseOnly: true,
      retryOnServiceExceptions: false, // one explicit Retry list, so experiments see exactly what is configured
      outputs: "{% $merge([$states.input, {'lastResult': $states.result}]) %}",
    });
    runStep.addRetry(retry);
    runStep.addCatch(recordFailure, { errors: ['States.ALL'], outputs: catchOutput('RunStep') });

    // Marketplace branch.
    const prepareInvocation = tasks.LambdaInvoke.jsonata(this, 'PrepareInvocation', {
      lambdaFunction: props.prepareInvocationFn,
      payload,
      payloadResponseOnly: true,
      retryOnServiceExceptions: false, // one explicit Retry list, so experiments see exactly what is configured
      outputs: '{% $merge([$states.input, $states.result]) %}',
    });
    prepareInvocation.addRetry(retry);
    prepareInvocation.addCatch(recordFailure, { errors: ['States.ALL'], outputs: catchOutput('PrepareInvocation') });

    // The function ARN and the timeout come from the state (FilterVersion
    // pinned at submit), so this is a CustomState rather than LambdaInvoke.
    const invokeFilter = new sfn.CustomState(this, 'InvokeFilter', {
      stateJson: {
        Type: 'Task',
        Resource: 'arn:aws:states:::lambda:invoke',
        Arguments: {
          FunctionName: '{% $states.input.invocation.functionArn %}',
          Payload: '{% $states.input.invocation.payload %}',
        },
        TimeoutSeconds: '{% $states.input.invocation.taskTimeoutSec %}',
        Output:
          "{% $merge([$states.input, {'filterResult': $states.result.Payload, 'invokeAttempts': $states.context.State.RetryCount + 1}]) %}",
        // CustomState.addCatch drops `outputs`, so the Catch is spelled out.
        // RecordFailure is in the graph through the other states' catches.
        Catch: [{ ErrorEquals: ['States.ALL'], Output: catchOutput('InvokeFilter'), Next: 'RecordFailure' }],
      },
    });
    invokeFilter.addRetry(retry);

    const validateOutput = tasks.LambdaInvoke.jsonata(this, 'ValidateOutput', {
      lambdaFunction: props.validateOutputFn,
      payload,
      payloadResponseOnly: true,
      retryOnServiceExceptions: false, // one explicit Retry list, so experiments see exactly what is configured
      outputs: "{% $merge([$states.input, {'lastResult': $states.result}]) %}",
    });
    validateOutput.addRetry(retry);
    validateOutput.addCatch(recordFailure, { errors: ['States.ALL'], outputs: catchOutput('ValidateOutput') });

    const advanceStep = sfn.Pass.jsonata(this, 'AdvanceStep', {
      outputs: "{% $merge([$states.input, {'stepIndex': $states.input.stepIndex + 1}]) %}",
    });

    const done = sfn.Succeed.jsonata(this, 'ImageDone', {
      outputs: "{% {'imageId': $states.input.imageId, 'stepCount': $states.input.stepCount, 'lastResult': $states.input.lastResult} %}",
    });

    const routeStep = sfn.Choice.jsonata(this, 'RouteStep')
      .when(sfn.Condition.jsonata("{% $states.input.step.type = 'marketplace' %}"), prepareInvocation)
      .otherwise(runStep);

    const isDone = sfn.Choice.jsonata(this, 'Done?')
      .when(sfn.Condition.jsonata('{% $states.input.stepIndex < $states.input.stepCount %}'), selectStep)
      .otherwise(done);

    selectStep.next(routeStep);
    runStep.next(advanceStep);
    prepareInvocation.next(invokeFilter);
    invokeFilter.next(validateOutput);
    validateOutput.next(advanceStep);
    advanceStep.next(isDone);

    this.childSm = new sfn.StateMachine(this, 'Child', {
      stateMachineName: 'aperture-proto-image',
      definitionBody: sfn.DefinitionBody.fromChainable(selectStep),
      queryLanguage: sfn.QueryLanguage.JSONATA,
      timeout: Duration.hours(2),
      logs: {
        destination: new logs.LogGroup(this, 'ChildLogs', { retention: logs.RetentionDays.ONE_WEEK }),
        level: sfn.LogLevel.ERROR,
      },
    });
    // InvokeFilter's function is dynamic; grant by name prefix (the boundary).
    this.childSm.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [`arn:aws:lambda:${stack.region}:${stack.account}:function:${FILTER_FUNCTION_PREFIX}*`],
      }),
    );

    // ---- Parent state machine (JSONPath) ----

    const processImages = new sfn.DistributedMap(this, 'ProcessImages', {
      mapExecutionType: sfn.StateMachineType.STANDARD,
      maxConcurrency: props.maxConcurrency,
      toleratedFailurePercentage: 100, // independent images: one failure never stops the batch
      label: 'images',
      itemReader: new sfn.S3JsonItemReader({
        bucket: storage.bucket,
        key: sfn.JsonPath.stringAt('$.manifestKey'),
      }),
      resultWriterV2: new sfn.ResultWriterV2({ bucket: storage.bucket, prefix: 'map-results' }),
      itemSelector: {
        orgId: sfn.JsonPath.stringAt('$.orgId'),
        batchId: sfn.JsonPath.stringAt('$.batchId'),
        runId: sfn.JsonPath.stringAt('$.runId'),
        steps: sfn.JsonPath.objectAt('$.steps'),
        stepCount: sfn.JsonPath.numberAt('$.stepCount'),
        filterVersions: sfn.JsonPath.objectAt('$.filterVersions'),
        imageId: sfn.JsonPath.stringAt('$$.Map.Item.Value.imageId'),
        sourceETag: sfn.JsonPath.stringAt('$$.Map.Item.Value.sourceETag'),
        stepIndex: 0,
      },
      resultPath: '$.mapResult',
    });
    processImages.itemProcessor(
      new tasks.StepFunctionsStartExecution(this, 'RunImage', {
        stateMachine: this.childSm,
        integrationPattern: sfn.IntegrationPattern.RUN_JOB,
        input: sfn.TaskInput.fromObject({
          orgId: sfn.JsonPath.stringAt('$.orgId'),
          batchId: sfn.JsonPath.stringAt('$.batchId'),
          runId: sfn.JsonPath.stringAt('$.runId'),
          steps: sfn.JsonPath.objectAt('$.steps'),
          stepCount: sfn.JsonPath.numberAt('$.stepCount'),
          filterVersions: sfn.JsonPath.objectAt('$.filterVersions'),
          imageId: sfn.JsonPath.stringAt('$.imageId'),
          sourceETag: sfn.JsonPath.stringAt('$.sourceETag'),
          stepIndex: sfn.JsonPath.numberAt('$.stepIndex'),
        }),
        name: sfn.JsonPath.format(
          '{}-{}-{}',
          sfn.JsonPath.stringAt('$.batchId'),
          sfn.JsonPath.stringAt('$.imageId'),
          sfn.JsonPath.stringAt('$.runId'),
        ),
        associateWithParent: true,
      }),
    );

    const finalize = new tasks.LambdaInvoke(this, 'Finalize', {
      lambdaFunction: this.finalizeFn,
      payload: sfn.TaskInput.fromObject({
        orgId: sfn.JsonPath.stringAt('$.orgId'),
        batchId: sfn.JsonPath.stringAt('$.batchId'),
        runId: sfn.JsonPath.stringAt('$.runId'),
        mapRunArn: sfn.JsonPath.stringAt('$.mapResult.MapRunArn'),
      }),
      payloadResponseOnly: true,
      retryOnServiceExceptions: false, // one explicit Retry list, so experiments see exactly what is configured
      resultPath: '$.finalize',
    });
    finalize.addRetry({ errors: RETRYABLE_ERRORS, interval: Duration.seconds(2), maxAttempts: 3, backoffRate: 2 });

    this.parentSm = new sfn.StateMachine(this, 'Parent', {
      stateMachineName: 'aperture-proto-batch',
      definitionBody: sfn.DefinitionBody.fromChainable(processImages.next(finalize)),
      timeout: Duration.hours(24),
      logs: {
        destination: new logs.LogGroup(this, 'ParentLogs', { retention: logs.RetentionDays.ONE_WEEK }),
        level: sfn.LogLevel.ERROR,
      },
    });
  }
}
