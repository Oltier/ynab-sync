import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

export class YnabSyncAwsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here

    const ynabberLambda = new lambda.Function(this, "YnabberLambda", {
      code: lambda.Code.fromAsset("lambdas"),
    })

    // example resource
    // const queue = new sqs.Queue(this, 'YnabSyncAwsQueue', {
    //   visibilityTimeout: cdk.Duration.seconds(300)
    // });
  }
}
