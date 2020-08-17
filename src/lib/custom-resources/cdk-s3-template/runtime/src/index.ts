import * as AWS from 'aws-sdk';
import { CloudFormationCustomResourceEvent } from 'aws-lambda';
import { errorHandler } from '@aws-accelerator/custom-resource-runtime-cfn-response';

export type TemplateParameters = { [key: string]: string };

export interface HandlerProperties {
  templateBucketName: string;
  templatePath: string;
  outputBucketName: string;
  outputPath: string;
  parameters: TemplateParameters;
}

const s3 = new AWS.S3();

async function onEvent(event: CloudFormationCustomResourceEvent) {
  console.log(`Creating S3 object from template...`);
  console.log(JSON.stringify(event, null, 2));

  // tslint:disable-next-line: switch-default
  switch (event.RequestType) {
    case 'Create':
      return onCreate(event);
    case 'Update':
      return onUpdate(event);
    case 'Delete':
      return onDelete(event);
  }
}

export const handler = errorHandler(onEvent);

async function onCreate(event: CloudFormationCustomResourceEvent) {
  const properties = (event.ResourceProperties as unknown) as HandlerProperties;
  const { templateBucketName, templatePath, outputBucketName, outputPath } = properties;

  // Load template
  console.debug(`Loading template ${templateBucketName}/${templatePath}`);
  let bodyString;
  try {
    const object = await s3
      .getObject({
        Bucket: properties.templateBucketName,
        Key: properties.templatePath,
      })
      .promise();
    const body = object.Body!;
    bodyString = body.toString();
  } catch (e) {
    throw new Error(`Unable to get S3 object s3://${templateBucketName}/${templatePath}: ${e}`);
  }

  // Replace variables
  let replaced = bodyString;
  for (const [key, value] of Object.entries(properties.parameters)) {
    replaced = replaceAll(replaced, key, value);
  }

  try {
    // Save the template with replacements to S3
    console.debug(`Saving output ${outputBucketName}/${outputPath}`);
    await s3
      .putObject({
        Bucket: outputBucketName,
        Key: outputPath,
        Body: Buffer.from(replaced),
      })
      .promise();
  } catch (e) {
    throw new Error(`Unable to put S3 object s3://${outputBucketName}/${outputPath}: ${e}`);
  }
}

async function onUpdate(event: CloudFormationCustomResourceEvent) {
  return onCreate(event);
}

async function onDelete(_: CloudFormationCustomResourceEvent) {
  console.log(`Nothing to do for delete...`);
}

function replaceAll(str: string, needle: string, replacement: string) {
  let index = 0;
  let replaced = str;
  while (true) {
    index = str.indexOf(needle, index + 1);
    if (index === -1) {
      break;
    }
    replaced = replaced.replace(needle, replacement);
  }
  return replaced;
}