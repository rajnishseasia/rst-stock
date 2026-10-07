interface LlmProviderOption {
  provider: string;
}

interface SavedLlmCredential {
  provider: string;
}

/**
 * Prefer the provider the user has already configured. The provider catalog's
 * first entry is only a fallback for users adding their first key.
 */
export function resolveLlmProviderDefault(
  providers: readonly LlmProviderOption[],
  credentials: readonly SavedLlmCredential[],
): string {
  const configuredProvider = credentials.find((credential) =>
    providers.some((provider) => provider.provider === credential.provider),
  )?.provider;

  return configuredProvider ?? providers[0]?.provider ?? "";
}

export function isLlmCredentialsQuerySettled({
  isSuccess,
  isError,
}: {
  isSuccess: boolean;
  isError: boolean;
}): boolean {
  return isSuccess || isError;
}
