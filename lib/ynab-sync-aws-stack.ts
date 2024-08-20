import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

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
  NORDIGEN_REQUISITION_S3_BUCKET_NAME: process.env.NORDIGEN_REQUISITION_S3_BUCKET_NAME!,
}

export class YnabSyncAwsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here


    // Build the lambda with GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o bootstrap cmd/ynabber/main.go
    const ynabberErsteLambda = new lambda.Function(this, "YnabberErsteLambda", {
      code: lambda.Code.fromAsset("lambdas"),
      handler: "bootstrap",
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      environment: {
        ...DEFAULT_YNABBER_ENV_VARS,
        NORDIGEN_BANKID: process.env.ERSTE_NORDIGEN_BANKID!,
        YNAB_ACCOUNTMAP: process.env.ERSTE_YNAB_ACCOUNTMAP!,
      }
    });

    const ynabberOtpLambda = new lambda.Function(this, "YnabberOtpLambda", {
      code: lambda.Code.fromAsset("lambdas"),
      handler: "bootstrap",
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      environment: {
        ...DEFAULT_YNABBER_ENV_VARS,
        NORDIGEN_BANKID: process.env.OTP_NORDIGEN_BANKID!,
        YNAB_ACCOUNTMAP: process.env.OTP_YNAB_ACCOUNTMAP!,
      }
    });

    // example resource
    // const queue = new sqs.Queue(this, 'YnabSyncAwsQueue', {
    //   visibilityTimeout: cdk.Duration.seconds(300)
    // });
  }
}
