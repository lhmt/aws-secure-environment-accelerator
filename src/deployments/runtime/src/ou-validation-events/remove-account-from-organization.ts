import { ScheduledEvent } from 'aws-lambda';
import { CodeCommit } from '@aws-accelerator/common/src/aws/codecommit';
import { AcceleratorConfig, AcceleratorUpdateConfig } from '@aws-accelerator/common-config/src';
import { SecretsManager } from '@aws-accelerator/common/src/aws/secrets-manager';
import { Account } from '@aws-accelerator/common-outputs/src/accounts';
import { getFormattedObject, getStringFromObject } from '@aws-accelerator/common/src/util/common';
import { pretty } from '@aws-accelerator/common/src/util/perttier';
import { JSON_FORMAT, YAML_FORMAT } from '@aws-accelerator/common/src/util/constants';

interface RemoveAccountOrganization extends ScheduledEvent {
  version?: string;
}

const defaultRegion = process.env.ACCELERATOR_DEFAULT_REGION!;
const configRepositoryName = process.env.CONFIG_REPOSITORY_NAME!;
const configFilePath = process.env.CONFIG_FILE_PATH!;
const configBranch = process.env.CONFIG_BRANCH_NAME!;
const acceleratorRoleName = process.env.ACCELERATOR_STATEMACHINE_ROLENAME!;
const acceleratorAccountsSecretId = process.env.ACCOUNTS_SECRET_ID!;
const configRootFilePath = process.env.CONFIG_ROOT_FILE_PATH!;

const codecommit = new CodeCommit(undefined, defaultRegion);
const secrets = new SecretsManager(undefined, defaultRegion);

export const handler = async (input: RemoveAccountOrganization) => {
  console.log(`RemoveAccountFromOrganization, Remove account configuration from Accelerator config...`);
  console.log(JSON.stringify(input, null, 2));
  const requestDetail = input.detail;
  const invokedBy = requestDetail.userIdentity.sessionContext.sessionIssuer.userName;
  if (invokedBy === acceleratorRoleName) {
    console.log(`Move Account Performed by Accelerator, No operation required`);
    return {
      status: 'NO_OPERATION_REQUIRED',
    };
  }
  console.log(`Reading account information from request`);
  const { accountId } = requestDetail.requestParameters;

  const accoutsString = await secrets.getSecret(acceleratorAccountsSecretId);
  const accounts = JSON.parse(accoutsString.SecretString!) as Account[];
  const account = accounts.find(acc => acc.id === accountId);
  if (!account) {
    console.error(`Account is not processed through Accelerator Statemachine "${accountId}"`);
    return;
  }
  await removeAccountConfig(account);
  return 'SUCCESS';
};

async function removeAccountConfig(account: Account): Promise<string> {
  console.log(`Removing Account "${account.name}" from Configuration`);
  const extension = configRootFilePath?.split('.').slice(-1)[0];
  const format = extension === JSON_FORMAT ? JSON_FORMAT : YAML_FORMAT;

  const rawConfigResponse = await codecommit.getFile(configRepositoryName, configFilePath, configBranch);
  const rawConfig: AcceleratorConfig = getFormattedObject(rawConfigResponse.fileContent.toString(), format);
  let isMandatoryAccount = true;
  let accountInfo = Object.entries(rawConfig['mandatory-account-configs']).find(
    ([_, accConfig]) => accConfig.email === account.email,
  );
  if (!accountInfo) {
    isMandatoryAccount = false;
    accountInfo = Object.entries(rawConfig['workload-account-configs']).find(
      ([_, accConfig]) => accConfig.email === account.email,
    );
  }
  console.log(
    accountInfo,
    isMandatoryAccount,
    account,
    Object.entries(rawConfig['mandatory-account-configs']).find(([_, accConfig]) => accConfig.email === account.email),
  );
  if (!accountInfo) {
    return 'NO_ACCOUNT_FOUND';
  }
  const filename = accountInfo[1]['src-filename'];
  if (filename === configRootFilePath) {
    const configResponse = await codecommit.getFile(configRepositoryName, filename, configBranch);
    const config: AcceleratorUpdateConfig = getFormattedObject(configResponse.fileContent.toString(), format);
    if (isMandatoryAccount) {
      const accountConfig = Object.entries(config['mandatory-account-configs']).find(
        ([_, accConfig]) => accConfig.email === account.email,
      );
      if (!accountConfig) {
        return 'NO_ACCOUNT_FOUND';
      }
      const accountKey = accountConfig[0];
      const accountConfigObject = accountConfig[1];
      accountConfigObject.deleted = true;
      config['mandatory-account-configs'][accountKey] = accountConfigObject;
    } else {
      const accountConfig = Object.entries(config['workload-account-configs']).find(
        ([_, accConfig]) => accConfig.email === account.email,
      );
      if (!accountConfig) {
        return 'NO_ACCOUNT_FOUND';
      }
      const accountKey = accountConfig[0];
      const accountConfigObject = accountConfig[1];
      accountConfigObject.deleted = true;
      config['workload-account-configs'][accountKey] = accountConfigObject;
    }
    try {
      console.log('Commiting');
      await codecommit.commit({
        branchName: configBranch,
        repositoryName: configRepositoryName,
        putFiles: [
          {
            filePath: filename,
            fileContent: pretty(getStringFromObject(config, format), format),
          },
        ],
        parentCommitId: configResponse.commitId,
      });
    } catch (error) {
      if (error.code === 'NoChangeException') {
        console.log(`Config is already update for account: ${account.email}`);
      } else {
        throw Error(error);
      }
    }
  } else {
    const accountConfigResponse = await codecommit.getFile(configRepositoryName, filename, configBranch);
    // tslint:disable-next-line: no-any
    const accountsConfig: { [accountKey: string]: any } = getFormattedObject(
      accountConfigResponse.fileContent.toString(),
      format,
    );
    const accountConfig = Object.entries(accountsConfig).find(([_, accConfig]) => accConfig.email === account.email);
    if (accountConfig) {
      const accountKey = accountConfig[0];
      const accountConfigObject = accountConfig[1];
      accountConfigObject.deleted = true;
      accountsConfig[accountKey] = accountConfigObject;
      try {
        await codecommit.commit({
          branchName: configBranch,
          repositoryName: configRepositoryName,
          putFiles: [
            {
              filePath: filename,
              fileContent: pretty(getStringFromObject(accountsConfig, format), format),
            },
          ],
          parentCommitId: accountConfigResponse.commitId,
        });
      } catch (error) {
        if (error.code === 'NoChangeException') {
          console.log(`Config is already update for account: ${accountKey}`);
        } else {
          throw Error(error);
        }
      }
    }
  }
  return 'SUCCESS';
}