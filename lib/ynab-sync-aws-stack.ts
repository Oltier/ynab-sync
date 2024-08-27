import * as cdk from 'aws-cdk-lib';
import {RemovalPolicy} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cloudWatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudWatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import {ServicePrincipal} from "aws-cdk-lib/aws-iam";

require('dotenv').config({
  path: ['.env.common', '.env.erste', '.env.otp']
})

const DEFAULT_YNABBER_ENV_VARS = {
  YNABBER_INTERVAL: process.env.YNABBER_INTERVAL!,
  YNABBER_DEBUG: process.env.YNABBER_DEBUG!,
  NORDIGEN_SECRET_ID: process.env.NORDIGEN_SECRET_ID!,
  NORDIGEN_SECRET_KEY: process.env.NORDIGEN_SECRET_KEY!,
  NORDIGEN_PAYEE_STRIP: process.env.NORDIGEN_PAYEE_STRIP!,
  NORDIGEN_PAYEE_SOURCE: process.env.NORDIGEN_PAYEE_SOURCE!,
  YNAB_BUDGETID: process.env.YNAB_BUDGETID!,
  YNAB_CLEARED: process.env.YNAB_CLEARED!,
  YNAB_TOKEN: process.env.YNAB_TOKEN!,
  NORGIDEN_REQUISITION_FILE_STORAGE: process.env.NORGIDEN_REQUISITION_FILE_STORAGE!,
}

const LAMBDA_TIMEOUT_SEC: number = 30;
// 24 HOURS / 10 INVOCATIONS
const INVOKE_OTP_LAMBDA_SCHEDULE_MINUTES: number = 144;

export class YnabSyncAwsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here

    const ynabberBucket = new s3.Bucket(this, 'ynabber', {
      bucketName: 'ynabber',
      autoDeleteObjects: false,
      removalPolicy: RemovalPolicy.RETAIN,
      versioned: true,
    });


    // Build the lambda with GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o bootstrap cmd/ynabber/main.go
    const ynabberErsteLambda = new lambda.Function(this, "YnabberErsteLambda", {
      code: lambda.Code.fromAsset("lambdas"),
      handler: "bootstrap",
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      retryAttempts: 0,
      environment: {
        ...DEFAULT_YNABBER_ENV_VARS,
        NORDIGEN_BANKID: process.env.ERSTE_NORDIGEN_BANKID!,
        YNAB_ACCOUNTMAP: process.env.ERSTE_YNAB_ACCOUNTMAP!,
        NORDIGEN_REQUISITION_S3_BUCKET_NAME: ynabberBucket.bucketName,
        YNABBER_DEBUG: 'true',
      },
      timeout: cdk.Duration.seconds(LAMBDA_TIMEOUT_SEC),
    });

    ynabberBucket.grantRead(ynabberErsteLambda);

    const ynabberOtpLambda = new lambda.Function(this, "YnabberOtpLambda", {
      code: lambda.Code.fromAsset("lambdas"),
      handler: "bootstrap",
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      retryAttempts: 0,
      environment: {
        ...DEFAULT_YNABBER_ENV_VARS,
        NORDIGEN_BANKID: process.env.OTP_NORDIGEN_BANKID!,
        YNAB_ACCOUNTMAP: process.env.OTP_YNAB_ACCOUNTMAP!,
        NORDIGEN_REQUISITION_S3_BUCKET_NAME: ynabberBucket.bucketName,
      },
      timeout: cdk.Duration.seconds(LAMBDA_TIMEOUT_SEC),
    });

    ynabberBucket.grantRead(ynabberOtpLambda);

    const invokeOtpLambdaRule = new events.Rule(this, 'InvokeOtpLambdaSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(INVOKE_OTP_LAMBDA_SCHEDULE_MINUTES)),
      targets: [new targets.LambdaFunction(ynabberOtpLambda)],
    });

    const invokeErsteLambdaRule = new events.Rule(this, 'InvokeErsteLambdaSchedule', {
      schedule: events.Schedule.cron({hour: '5,19', minute: '0'}),
      targets: [new targets.LambdaFunction(ynabberErsteLambda)],
    });

    ynabberOtpLambda.addPermission('InvokeByEventBridgeOtp', {
      principal: new ServicePrincipal('events.amazonaws.com'),
      sourceArn: invokeOtpLambdaRule.ruleArn,
    });

    ynabberErsteLambda.addPermission('InvokeByEventBridgeErste', {
      principal: new ServicePrincipal('events.amazonaws.com'),
      sourceArn: invokeErsteLambdaRule.ruleArn,
    });


    const errorTopic = new sns.Topic(this, 'YnabErrorTopic', {
      displayName: 'YnabErrorTopic',
    });

    const emailSubscription = new sns.Subscription(this, 'YnabErrorEmailSubscription', {
      topic: errorTopic,
      protocol: sns.SubscriptionProtocol.EMAIL,
      endpoint: process.env.EMAIL!,
    });

    const alarmAction = new cloudWatchActions.SnsAction(errorTopic);

    const ersteErrorMonitor = new cloudWatch.Alarm(this, 'ErsteErrorMonitor', {
      metric: new cloudWatch.Metric({
        namespace: 'AWS/Lambda',
        metricName: 'Errors',
        dimensionsMap: {
          FunctionName: ynabberErsteLambda.functionName,
        },
        period: cdk.Duration.minutes(5),
        statistic: 'Sum'
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudWatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      actionsEnabled: true
    });

    ersteErrorMonitor.addAlarmAction(alarmAction);

    const otpErrorMonitor = new cloudWatch.Alarm(this, 'OtpErrorMonitor', {
      metric: new cloudWatch.Metric({
        namespace: 'AWS/Lambda',
        metricName: 'Errors',
        dimensionsMap: {
          FunctionName: ynabberOtpLambda.functionName,
        },
        period: cdk.Duration.minutes(5),
        statistic: 'Sum'
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudWatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      actionsEnabled: true
    });

    otpErrorMonitor.addAlarmAction(alarmAction);
  }
}
