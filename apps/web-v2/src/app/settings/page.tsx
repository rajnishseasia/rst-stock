"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient, useSession } from "@/lib/auth-client";
import { trpc } from "@/lib/trpc";
import { PerpsOnboardingCard } from "@/components/perps/perps-onboarding-card";
import {
  brokerConnectedAccounts,
  findHyperliquidAccount,
  removeAccountConfirm,
} from "@/lib/perps-card-display";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UserMenu } from "@/components/auth/user-menu";
// BYOK disabled: LlmProviderGuide and llm-provider-default helpers unused until BYOK returns.
// import { LlmProviderGuide } from "@/components/settings/llm-provider-guide";
import { ThemeSelector } from "@/components/settings/theme-selector";
import { Badge } from "@/components/ui/badge";
import { DEFAULT_BROKER_ACCOUNT_TYPE, type BrokerAccountType } from "@/lib/broker-account-default";
import { buildSaveBrokerCredentialsInput } from "@/lib/broker-credentials-form";
import { CopyTradeLeverageSettings } from "@/components/copy-trade/copy-trade-leverage-settings";
import {
  buildSettingsTabHref,
  navigateToSettingsTab,
  resolveSettingsTabFromSearchParams,
} from "@/lib/settings-tabs";
import { useCompleteApiCredentials } from "@/lib/use-complete-api-credentials";
// BYOK disabled: restore these when user-supplied keys return.
// import {
//   isLlmCredentialsQuerySettled,
//   resolveLlmProviderDefault,
// } from "@/lib/llm-provider-default";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import Link from "next/link";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { AlpacaCredentialSettingsRecoveryNotice } from "@/lib/alpaca-credential-reimport-notice";

/**
 * `useSearchParams` requires a Suspense boundary in the App Router, so the page
 * body lives in an inner component and the default export wraps it. The fallback
 * mirrors the session-loading state below so there is no visual jump.
 */
export default function SettingsPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-background p-6 text-sm text-muted-foreground">
          Loading settings...
        </div>
      }
    >
      <SettingsPageInner />
    </Suspense>
  );
}

function SettingsPageInner() {
  const { data: session, isPending: isSessionLoading } = useSession();
  const searchParams = useSearchParams();
  const router = useRouter();
  // Deep-link support: `/settings?t=models` opens the AI Models tab (doc #15).
  // An unknown or missing value falls back to the default Broker tab.
  const activeTab = resolveSettingsTabFromSearchParams(searchParams);

  useEffect(() => {
    const search = searchParams.toString();
    const currentHref = search ? `/settings?${search}` : "/settings";
    const canonicalHref = buildSettingsTabHref(search, activeTab);
    if (canonicalHref === currentHref) return;
    router.replace(canonicalHref, { scroll: false });
  }, [activeTab, router, searchParams]);

  const setActiveTab = (value: string) => {
    navigateToSettingsTab(value, searchParams.toString(), (href) =>
      router.push(href, { scroll: false }),
    );
  };
  const settingsUtils = trpc.useUtils();
  const [provider, setProvider] = useState<"alpaca">("alpaca");
  const [accountType, setAccountType] = useState<BrokerAccountType>(DEFAULT_BROKER_ACCOUNT_TYPE);
  const [accessToken, setAccessToken] = useState("");
  const [username, setUsername] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [credentialToDelete, setCredentialToDelete] = useState<{
    id: string;
    provider: string;
  } | null>(null);
  const [socialMessage, setSocialMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);

  const socialIdentityQuery = trpc.userSettings.socialIdentity.useQuery(undefined, {
    enabled: !!session?.user,
  });

  const unlinkTwitterMutation = trpc.userSettings.unlinkTwitter.useMutation({
    onSuccess: async () => {
      await socialIdentityQuery.refetch();
    },
    onError: (err) => {
      setSocialMessage({ type: "error", text: err.message || "Could not disconnect X. Please try again." });
    },
  });

  const refreshTwitterMutation = trpc.userSettings.refreshTwitterProfile.useMutation({
    onSuccess: async (result) => {
      if (result.ok) {
        await socialIdentityQuery.refetch();
      }
    },
  });

  // If any public Twitter identity field is missing, the initial OAuth sync
  // failed. Trigger a re-sync automatically so the complete profile appears
  // without requiring a disconnect/reconnect cycle.
  useEffect(() => {
    const data = socialIdentityQuery.data;
    if (
      data?.twitterLinked &&
      data.twitterProfileComplete === false &&
      !refreshTwitterMutation.isPending &&
      !refreshTwitterMutation.isSuccess
    ) {
      refreshTwitterMutation.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    socialIdentityQuery.data?.twitterLinked,
    socialIdentityQuery.data?.twitterProfileComplete,
  ]);

  // Read the ?error= param that Better Auth appends when the OAuth callback
  // fails. This fires once on mount so the error appears immediately when the
  // user lands back on the Profile tab after a failed Twitter link attempt.
  useEffect(() => {
    const errorCode = searchParams.get("error");
    if (!errorCode) return;
    const messages: Record<string, string> = {
      unable_to_get_user_info: "Could not fetch your X profile. Check your X app settings and try again.",
      unable_to_link_account: "Your X account could not be linked. Please try again.",
      account_already_linked_to_different_user: "This X account is already linked to a different user.",
      "email_doesn't_match": "The X account email does not match your current account.",
      invalid_code: "The authorization code expired or was invalid. Please try again.",
      access_denied: "X authorization was cancelled. Please try again.",
    };
    const text = messages[errorCode] ?? `X linking failed (${errorCode}). Please try again.`;
    setSocialMessage({ type: "error", text });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const linkTwitter = async () => {
    setSocialMessage(null);
    const { error } = await authClient.linkSocial({
      provider: "twitter",
      callbackURL: "/settings?t=profile",
      // Redirect back to the Profile tab on error so the error banner is
      // visible instead of landing the user on the homepage with a raw
      // ?error= param and no explanation.
      errorCallbackURL: "/settings?t=profile",
    });
    if (error) setSocialMessage({ type: "error", text: error.message || "Could not connect X. Please try again." });
  };

  const unlinkTwitter = () => {
    setSocialMessage(null);
    unlinkTwitterMutation.mutate();
  };
  // BYOK disabled: LLM key state commented out. Restore when user-supplied keys return.
  // const [llmProvider, setLlmProvider] = useState<string>("");
  // const [llmApiKey, setLlmApiKey] = useState("");
  // const [isSavingLlmKey, setIsSavingLlmKey] = useState(false);
  // const [llmMessage, setLlmMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Fetch existing credentials
  const credentialsQuery = useCompleteApiCredentials(undefined, {
    enabled: !!session?.user,
  });
  const refetchCredentials = credentialsQuery.refetch;
  // BYOK disabled: provider/key management queries commented out. Restore when
  // user-supplied keys return.
  // const {
  //   isSuccess: llmCredentialsSucceeded,
  //   isError: llmCredentialsFailed,
  // } = trpc.llmCredentials.list.useQuery(undefined, { enabled: !!session?.user });
  // const llmCredentialsSettled = isLlmCredentialsQuerySettled({ isSuccess: llmCredentialsSucceeded, isError: llmCredentialsFailed });
  // const { data: llmProviders } = trpc.llmCredentials.providers.useQuery(undefined, { enabled: !!session?.user });
  // useEffect(() => {
  //   if (!llmProvider && llmProviders && llmProviders.length > 0 && llmCredentialsSettled) {
  //     setLlmProvider(resolveLlmProviderDefault(llmProviders, llmCredentials ?? []));
  //   }
  // }, [llmProvider, llmProviders, llmCredentials, llmCredentialsSettled]);

  // Platform-model status: the API schema allows OPENAI_API_KEY to be unset,
  // so the "Active" badge below must reflect that instead of always claiming
  // the model is available.
  const { data: platformStatus } = trpc.llmCredentials.platformStatus.useQuery(undefined, {
    enabled: !!session?.user,
  });
  const modelConfigured = platformStatus?.configured;

  // BYOK is disabled for new keys, but users who saved a provider key before
  // this rollout still have an encrypted row in user_llm_api_credentials with
  // no other UI to remove it from. Keep a list/remove-only view here.
  const { data: llmCredentials, refetch: refetchLlmCredentials } = trpc.llmCredentials.list.useQuery(
    undefined,
    { enabled: !!session?.user }
  );
  const deleteLlmCredentialsMutation = trpc.llmCredentials.delete.useMutation({
    onSuccess: () => {
      refetchLlmCredentials();
    },
  });

  // Save credentials mutation
  const saveCredentialsMutation = trpc.userSettings.saveApiCredentials.useMutation({
    onSuccess: () => {
      setMessage({ type: "success", text: "Credentials saved successfully!" });
      setAccessToken("");
      refetchCredentials();
    },
    onError: (error) => {
      setMessage({ type: "error", text: error.message });
    },
    onSettled: () => {
      setIsSaving(false);
    },
  });

  // Delete credentials mutation
  const deleteCredentialsMutation = trpc.userSettings.deleteApiCredentials.useMutation({
    onSuccess: () => {
      setMessage({ type: "success", text: "Credentials deleted!" });
      refetchCredentials();
      // Removing a Hyperliquid row disconnects perps, so the perps card's
      // enabled/wallet state is stale until `status` is refetched. Harmless for
      // an Alpaca delete (the query is only mounted when perps are configured).
      void settingsUtils.hyperliquid.status.invalidate();
    },
    onError: (error) => {
      setMessage({ type: "error", text: error.message });
    },
  });

  // BYOK disabled: upsert/test mutations commented out. Restore when user keys return.
  // const saveLlmCredentialsMutation = trpc.llmCredentials.upsert.useMutation({ ... });
  // const testLlmCredentialsMutation = trpc.llmCredentials.test.useMutation({ ... });
  // deleteLlmCredentialsMutation is active above (orphan-key removal).

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setMessage(null);

    saveCredentialsMutation.mutate(
      buildSaveBrokerCredentialsInput({
        provider,
        accountType,
        accessToken,
        username,
      }),
    );
  };

  // BYOK disabled: handleLlmSubmit commented out. Restore when user-supplied keys return.
  // const handleLlmSubmit = async (e: React.FormEvent) => { ... };

  // Hyperliquid shares the credentials table with Alpaca but is not a brokerage
  // the user linked keys to, so the two tabs read disjoint slices of one list.
  const brokerAccounts = brokerConnectedAccounts(credentialsQuery.accounts);
  const hyperliquidAccount = findHyperliquidAccount(credentialsQuery.accounts);
  const hasAlpacaCredentialsNeedingReentry = credentialsQuery.accounts.some(
    (account) => account.provider === "alpaca" && account.needsReentry === true,
  );

  const handleDeleteClick = (credentialId: string, provider: string) => {
    setCredentialToDelete({ id: credentialId, provider });
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = () => {
    if (credentialToDelete) {
      deleteCredentialsMutation.mutate({ credentialId: credentialToDelete.id });
      setDeleteDialogOpen(false);
      setCredentialToDelete(null);
    }
  };

  if (isSessionLoading) {
    return (
      <main className="flex min-h-screen flex-col items-center p-8 lg:p-24 bg-background">
        <div className="animate-pulse">Loading...</div>
      </main>
    );
  }

  if (!session?.user) {
    return (
      <main className="flex min-h-screen flex-col items-center p-8 lg:p-24 bg-background">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Sign in Required</CardTitle>
            <CardDescription>Please sign in to access settings</CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/app">
              <Button className="w-full">Go to Home</Button>
            </Link>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center p-8 lg:p-24 bg-background">
      <div className="z-10 w-full max-w-3xl items-center justify-between font-mono text-sm lg:flex mb-8">
        <div className="flex items-center gap-4">
          <Link href="/app" className="text-muted-foreground hover:text-foreground">
            ← Back
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        </div>
        <UserMenu />
      </div>

      <div className="w-full max-w-3xl">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="mb-6 grid h-auto w-full grid-cols-2 gap-1 sm:grid-cols-5">
            <TabsTrigger value="broker" className="min-w-0 whitespace-normal px-2 text-xs sm:text-sm">
              Broker
            </TabsTrigger>
            <TabsTrigger value="perps" className="min-w-0 whitespace-normal px-2 text-xs sm:text-sm">
              Perps
            </TabsTrigger>
            <TabsTrigger
              value="copy-trading"
              className="min-w-0 whitespace-normal px-2 text-xs sm:text-sm"
            >
              Copy Trading
            </TabsTrigger>
            <TabsTrigger value="models" className="min-w-0 whitespace-normal px-2 text-xs sm:text-sm">
              AI Models
            </TabsTrigger>
            <TabsTrigger
              value="profile"
              className="min-w-0 whitespace-normal px-2 text-xs sm:text-sm"
            >
              Profile
            </TabsTrigger>
          </TabsList>

          {/* Broker: connected accounts, add-account form, and the credential
              guide live together so the "how to get keys" steps sit right next
              to the form they feed. */}
          <TabsContent value="broker" className="space-y-6">
        <AlpacaCredentialSettingsRecoveryNotice needsReentry={hasAlpacaCredentialsNeedingReentry} />

        {/* Existing Accounts. Hyperliquid is filtered out: it lives in the same
            credentials table as Alpaca, but it is a venue traded through a
            self-custody wallet rather than a brokerage the user linked API keys
            to, and everything else about it lives under Perps. Its Remove now
            sits there too. */}
        {brokerAccounts.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Connected Accounts</CardTitle>
              <CardDescription>Your linked broker accounts</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {brokerAccounts.map((account) => (
                <div
                  key={account.id}
                  className="flex items-center justify-between p-3 border rounded-lg"
                >
                  <div className="flex items-center gap-3">
                    <div>
                      <div className="font-medium capitalize">{account.provider}</div>
                      <div className="text-sm text-muted-foreground">
                        {(account.accountType === "PAPER" || account.accountType === "SIM") ? "Paper" : "Live"} account: {account.accountId}
                        {account.username && ` (${account.username})`}
                      </div>
                    </div>
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => handleDeleteClick(account.id, account.provider)}
                    disabled={deleteCredentialsMutation.isPending}
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Add New Account */}
        <Card>
          <CardHeader>
            <CardTitle>Add Broker Account</CardTitle>
            <CardDescription>
              Connect your Alpaca paper or live account to execute trades. Your API keys are encrypted
              before storage.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Provider */}
              <div className="space-y-2">
                <Label htmlFor="provider">Broker</Label>
                <Select
                  value={provider}
                  onValueChange={(v) => setProvider(v as "alpaca")}
                >
                  <SelectTrigger id="provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="alpaca">Alpaca</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="accountType">Account Type</Label>
                <Select
                  value={accountType}
                  onValueChange={(v) => setAccountType(v as "PAPER" | "LIVE")}
                >
                  <SelectTrigger id="accountType">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PAPER">Paper Trading</SelectItem>
                    <SelectItem value="LIVE">Live Trading</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Username */}
              <div className="space-y-2">
                <Label htmlFor="username">API Key ID</Label>
                <Input
                  id="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Your Alpaca API Key ID"
                />
              </div>

              {/* Secret Key */}
              <div className="space-y-2">
                <Label htmlFor="accessToken">Secret Key</Label>
                <Input
                  id="accessToken"
                  type="password"
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                  placeholder="Your Alpaca Secret Key"
                  required
                />
                <p className="text-xs text-muted-foreground">
                  Alpaca only shows this once when you generate a new key pair.
                </p>
              </div>

              {/* Message */}
              {message && (
                <div
                  className={`p-3 rounded-lg text-sm ${
                    message.type === "success"
                      ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
                      : "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
                  }`}
                >
                  {message.text}
                </div>
              )}

              {/* Submit */}
              <Button type="submit" className="w-full" disabled={isSaving}>
                {isSaving ? "Saving..." : "Save Credentials"}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Help: Getting Your Alpaca Credentials, co-located with the add-account
            form above so the credential guide sits with the form it feeds. */}
        <Card>
          <CardHeader>
            <CardTitle>Getting Your Alpaca Credentials</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm dark:prose-invert max-w-none">
            <ol className="list-decimal pl-4 space-y-2 text-sm">
              <li>
                Go to{" "}
                <a
                  href="https://app.alpaca.markets/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  Alpaca Dashboard
                </a>
              </li>
              <li>Sign in or create an Alpaca account</li>
              <li>Click Trading Dashboard, not Documentation or API Reference</li>
              <li>Open Home, or go directly to https://app.alpaca.markets/dashboard/overview</li>
              <li>Switch to Paper Trading for test keys, or Live Trading for real-money keys</li>
              <li>Scroll to the bottom-right API Keys card</li>
              <li>Click "Generate New Keys" if you do not already have a key pair for that account type</li>
              <li>Copy the Key ID into the "API Key ID" field above</li>
              <li>Copy the Secret Key into the "Secret Key" field above immediately; Alpaca only shows it once</li>
            </ol>
            <p className="text-xs text-muted-foreground mt-4">
              Note: The encryption key is stored securely in Vercel environment variables.
              Your credentials are never stored in plain text.
            </p>
          </CardContent>
        </Card>
          </TabsContent>

          {/* Perps sits ABOVE Models in tab order. */}
          <TabsContent value="perps" className="space-y-6">
            <PerpsOnboardingCard enabledSession={!!session?.user} />

            {/* Removing perps belongs on the tab that sets perps up. It used to
                be reachable only from Broker -> Connected Accounts, a tab that
                never mentions perps, which is a bad place to hide the offboard
                for a feature configured entirely here. Same mutation and same
                provider-aware confirmation as before; only the location moved. */}
            {hyperliquidAccount && (
              <Card>
                <CardHeader>
                  <CardTitle>Remove perps</CardTitle>
                  <CardDescription>
                    Disconnects Hyperliquid from this account and removes the
                    trading agent. Your wallet and any balance on Hyperliquid
                    remain on-chain.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 text-sm text-muted-foreground">
                    Connected account:{" "}
                    <span className="font-data break-all">
                      {hyperliquidAccount.accountId}
                    </span>
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() =>
                      handleDeleteClick(
                        hyperliquidAccount.id,
                        hyperliquidAccount.provider,
                      )
                    }
                    disabled={deleteCredentialsMutation.isPending}
                  >
                    Remove
                  </Button>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="copy-trading" className="space-y-6">
            <CopyTradeLeverageSettings />
          </TabsContent>

          <TabsContent value="models" className="space-y-6">
            {/*
              BYOK disabled: the full key management UI (provider select, API key
              input, test button) is commented out below. The platform supplies a
              shared gpt-4o-mini key for all users. The saved-credentials list
              below stays active in list/remove-only mode so users who saved a
              key before this rollout can still delete it.

              To re-enable BYOK:
              1. Uncomment the state, queries, mutations, and handleLlmSubmit above.
              2. Restore the LlmProviderGuide import.
              3. Replace this Card's content with the original form.
              4. Restore llmCredentialId in the chat panel fetch body and schema.
            */}
            <Card>
              <CardHeader>
                <CardTitle>AI Model</CardTitle>
                <CardDescription>
                  AI Chat is powered by the platform. No key required.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-3 rounded-lg border p-3">
                  <div>
                    <div className="font-medium">OpenAI GPT-4o mini</div>
                    <div className="text-sm text-muted-foreground">
                      {modelConfigured === false
                        ? "Not configured yet. Contact support."
                        : "Provided by the platform for all users."}
                    </div>
                  </div>
                  <Badge
                    variant={modelConfigured === false ? "destructive" : "secondary"}
                    className="ml-auto shrink-0"
                  >
                    {modelConfigured === undefined
                      ? "Checking…"
                      : modelConfigured
                        ? "Active"
                        : "Unavailable"}
                  </Badge>
                </div>
              </CardContent>
            </Card>

            {llmCredentials && llmCredentials.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Saved provider keys</CardTitle>
                  <CardDescription>
                    BYOK is disabled, so AI Chat no longer uses these. Remove any
                    you no longer need.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {llmCredentials.map((credential) => (
                    <div
                      key={credential.id}
                      className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="font-medium">{credential.label}</div>
                          <Badge variant="outline">{credential.defaultModel}</Badge>
                        </div>
                        <div className="text-sm text-muted-foreground">
                          Key ending in {credential.apiKeyLast4}
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={() => deleteLlmCredentialsMutation.mutate({ credentialId: credential.id })}
                        disabled={deleteLlmCredentialsMutation.isPending}
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="profile" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Public trader identity</CardTitle>
                <CardDescription>
                  {socialIdentityQuery.data?.twitterLinked
                    ? "Your X profile is shown on the leaderboard, in trade webhooks, and on your public Hyperliquid profile."
                    : "Your anonymous name appears in shared trade webhooks, the user leaderboard, and your public Hyperliquid profile. Connect X to show that identity instead."}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
                  <Avatar>
                    {socialIdentityQuery.data?.traderImage && (
                      <AvatarImage
                        src={socialIdentityQuery.data.traderImage}
                        alt={socialIdentityQuery.data.traderName}
                      />
                    )}
                    <AvatarFallback>
                      {(socialIdentityQuery.data?.traderName ?? "Trader").slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      {socialIdentityQuery.data?.traderName ?? "Loading identity..."}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {socialIdentityQuery.data?.twitterLinked
                        ? socialIdentityQuery.data.twitterHandle
                          ? `@${socialIdentityQuery.data.twitterHandle}`
                          : "Connected to X"
                        : `Anonymous name: ${socialIdentityQuery.data?.anonymousIdentity.traderName ?? "loading"}`}
                    </p>
                  </div>
                  {socialIdentityQuery.data?.twitterLinked && <Badge variant="secondary">X linked</Badge>}
                </div>

                {socialMessage && (
                  <div
                    role="status"
                    className={`rounded-lg p-3 text-sm ${
                      socialMessage.type === "error"
                        ? "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
                        : "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
                    }`}
                  >
                    {socialMessage.text}
                  </div>
                )}

                {socialIdentityQuery.data?.twitterLinked ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={unlinkTwitter}
                    disabled={unlinkTwitterMutation.isPending}
                  >
                    {unlinkTwitterMutation.isPending ? "Disconnecting..." : "Disconnect X"}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    onClick={linkTwitter}
                    disabled={socialIdentityQuery.data?.twitterConfigured === false}
                  >
                    Connect X account
                  </Button>
                )}
                {socialIdentityQuery.data?.twitterConfigured === false && (
                  <p className="text-xs text-muted-foreground">
                    X linking is not configured on this deployment yet.
                  </p>
                )}
              </CardContent>
            </Card>

            <ThemeSelector />
          </TabsContent>
        </Tabs>
      </div>

      <footer className="mt-10 w-full max-w-3xl border-t pt-6 text-center">
        <a
          href="/legal"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Terms of Service &amp; Privacy Policy
        </a>
      </footer>

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          setDeleteDialogOpen(open);
          if (!open) {
            setCredentialToDelete(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {removeAccountConfirm(credentialToDelete?.provider).title}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {removeAccountConfirm(credentialToDelete?.provider).description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              variant="destructive"
              disabled={deleteCredentialsMutation.isPending}
            >
              {deleteCredentialsMutation.isPending
                ? "Removing..."
                : removeAccountConfirm(credentialToDelete?.provider).confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
