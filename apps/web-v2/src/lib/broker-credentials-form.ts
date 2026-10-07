import type { BrokerAccountType } from "./broker-account-default";

export type SaveBrokerCredentialsFormFields = {
  provider: "alpaca";
  accountType: BrokerAccountType;
  accessToken: string;
  username: string;
};

export function buildSaveBrokerCredentialsInput({
  provider,
  accountType,
  accessToken,
  username,
}: SaveBrokerCredentialsFormFields) {
  return {
    provider,
    accountType,
    accessToken,
    username: username || undefined,
  };
}
