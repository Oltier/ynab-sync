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
import {ServicePrincipal} from 'aws-cdk-lib/aws-iam';

require('dotenv').config({
  path: ['.env.common', '.env.erste', '.env.otp', '.env.nordea'],
});

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
  NORGIDEN_REQUISITION_FILE_STORAGE:
    process.env.NORGIDEN_REQUISITION_FILE_STORAGE!,
};

const LAMBDA_TIMEOUT_SEC = 60;

// Invocation schedules
const OTP_CALLS_PER_DAY = 10;
const NORDEA_CALLS_PER_DAY = 4;
const INVOKE_OTP_LAMBDA_SCHEDULE_MINUTES =
  (24 * 60) / (OTP_CALLS_PER_DAY - 1);
const INVOKE_NORDEA_LAMBDA_SCHEDULE_MINUTES =
  (24 * 60) / (NORDEA_CALLS_PER_DAY - 1);

interface BankConfig {
  name: string;
  lambdaId: string;
  nordigenBankIdEnvVar: string;
  ynabAccountMapEnvVar: string;
  schedule: events.Schedule;
  enabled: boolean;
  extraEnv?: { [key: string]: string };
}

const banks: BankConfig[] = [
  {
    name: 'Erste',
    lambdaId: 'YnabberErsteLambda',
    nordigenBankIdEnvVar: 'ERSTE_NORDIGEN_BANKID',
    ynabAccountMapEnvVar: 'ERSTE_YNAB_ACCOUNTMAP',
    schedule: events.Schedule.cron({hour: '5,19', minute: '0'}),
    enabled: true, // Disabled since it's commented out in the original code
    extraEnv: {
      YNABBER_DEBUG: 'true',
    },
  },
  {
    name: 'Otp',
    lambdaId: 'YnabberOtpLambda',
    nordigenBankIdEnvVar: 'OTP_NORDIGEN_BANKID',
    ynabAccountMapEnvVar: 'OTP_YNAB_ACCOUNTMAP',
    schedule: events.Schedule.rate(
      cdk.Duration.minutes(INVOKE_OTP_LAMBDA_SCHEDULE_MINUTES)
    ),
    enabled: true,
  },
  {
    name: 'Nordea',
    lambdaId: 'YnabberNordeaLambda',
    nordigenBankIdEnvVar: 'NORDEA_NORDIGEN_BANKID',
    ynabAccountMapEnvVar: 'NORDEA_YNAB_ACCOUNTMAP',
    schedule: events.Schedule.rate(
      cdk.Duration.minutes(INVOKE_NORDEA_LAMBDA_SCHEDULE_MINUTES)
    ),
    enabled: true,
  },
];

export class YnabSyncAwsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create the S3 bucket
    const ynabberBucket = new s3.Bucket(this, 'ynabber', {
      bucketName: 'ynabber',
      autoDeleteObjects: false,
      removalPolicy: RemovalPolicy.RETAIN,
      versioned: true,
    });

    // Create the SNS topic and subscription for error notifications
    const errorTopic = new sns.Topic(this, 'YnabErrorTopic', {
      displayName: 'YnabErrorTopic',
    });

    new sns.Subscription(this, 'YnabErrorEmailSubscription', {
      topic: errorTopic,
      protocol: sns.SubscriptionProtocol.EMAIL,
      endpoint: process.env.EMAIL!,
    });

    const alarmAction = new cloudWatchActions.SnsAction(errorTopic);

    // Iterate over each bank configuration to create resources
    banks
      .filter((bank) => bank.enabled)
      .forEach((bank) => {
        const bankLambda = new lambda.Function(this, bank.lambdaId, {
          code: lambda.Code.fromAsset('lambdas'),
          handler: 'bootstrap',
          runtime: lambda.Runtime.PROVIDED_AL2023,
          architecture: lambda.Architecture.ARM_64,
          retryAttempts: 0,
          environment: {
            ...DEFAULT_YNABBER_ENV_VARS,
            NORDIGEN_BANKID: process.env[bank.nordigenBankIdEnvVar]!,
            YNAB_ACCOUNTMAP: process.env[bank.ynabAccountMapEnvVar]!,
            NORDIGEN_REQUISITION_S3_BUCKET_NAME: ynabberBucket.bucketName,
            ...(bank.extraEnv || {}),
          },
          timeout: cdk.Duration.seconds(LAMBDA_TIMEOUT_SEC),
        });

        ynabberBucket.grantRead(bankLambda);

        const invokeLambdaRule = new events.Rule(
          this,
          `Invoke${bank.name}LambdaSchedule`,
          {
            schedule: bank.schedule,
            targets: [new targets.LambdaFunction(bankLambda)],
          }
        );

        bankLambda.addPermission(`InvokeByEventBridge${bank.name}`, {
          principal: new ServicePrincipal('events.amazonaws.com'),
          sourceArn: invokeLambdaRule.ruleArn,
        });

        // CloudWatch Alarm for Lambda errors
        const errorMonitor = new cloudWatch.Alarm(
          this,
          `${bank.name}ErrorMonitor`,
          {
            metric: new cloudWatch.Metric({
              namespace: 'AWS/Lambda',
              metricName: 'Errors',
              dimensionsMap: {
                FunctionName: bankLambda.functionName,
              },
              period: cdk.Duration.minutes(5),
              statistic: 'Sum',
            }),
            threshold: 0,
            evaluationPeriods: 1,
            comparisonOperator:
            cloudWatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            actionsEnabled: true,
          }
        );

        errorMonitor.addAlarmAction(alarmAction);
      });
  }
}
