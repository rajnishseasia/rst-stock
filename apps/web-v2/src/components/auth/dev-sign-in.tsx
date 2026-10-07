"use client";

/**
 * DEV-ONLY email/password sign-in.
 *
 * Google is the only sign-in path in the product, and it cannot work on a dev
 * machine: there is no real Google OAuth client locally, so the placeholder
 * credentials return "Error 401: invalid_client". Without this, the local app is
 * impossible to sign into at all, which blocks every signed-in surface (the
 * terminal, perps, settings) from being developed or reviewed against a real
 * session.
 *
 * The API already enables Better Auth's email/password provider when
 * `NODE_ENV === "development"` (apps/api/src/lib/auth/better-auth.ts). This is
 * the matching client affordance, and nothing more.
 *
 * NOT SHIPPABLE TO PRODUCTION, by construction, with two independent gates:
 *   - `process.env.NODE_ENV` is inlined by the bundler at build time, so in a
 *     production build the early return is statically true and this component's
 *     body is dead code that gets stripped.
 *   - Even if it rendered, the server rejects the request, because the API only
 *     enables the email/password provider in development.
 */

import { useState } from "react";
import { signIn, signUp } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function DevSignIn() {
  // Statically false in a production build, so everything below is stripped.
  if (process.env.NODE_ENV !== "development") return null;
  return <DevSignInForm />;
}

function DevSignInForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await signIn.email({ email, password });
      if (!result.error) {
        // Land in the terminal, matching the Google callback destination.
        window.location.href = "/app";
        return;
      }

      // A fresh development database has NO password credentials: every account
      // was created through Google, which cannot work locally. Sign-in alone
      // would therefore fail forever and this form would never unblock anyone.
      // Fall back to creating the account, which is safe because the provider is
      // only enabled when the API is running in development.
      const created = await signUp.email({
        email,
        password,
        name: email.split("@")[0] ?? "Dev User",
      });
      if (created.error) {
        setError(
          `${result.error.message ?? "Sign-in failed."} Creating the account also failed: ${created.error.message ?? "unknown error"}`,
        );
        return;
      }
      window.location.href = "/app";
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="w-full max-w-sm space-y-3 rounded-lg border border-dashed border-amber-500/50 bg-amber-500/5 p-4 text-left"
    >
      <div>
        <p className="text-sm font-semibold text-amber-600 dark:text-amber-400">
          Local development sign-in
        </p>
        <p className="text-xs text-muted-foreground">
          Google OAuth is not configured on a dev machine. Signs in, or creates
          the account if it does not exist yet, since a fresh dev database has no
          password credentials. Compiled out of production builds and rejected by
          the API outside development.
        </p>
      </div>

      <div className="space-y-1">
        <Label htmlFor="dev-email" className="text-xs">
          Email
        </Label>
        <Input
          id="dev-email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="qa-tester@local.test"
          required
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="dev-password" className="text-xs">
          Password
        </Label>
        <Input
          id="dev-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <Button type="submit" disabled={busy} className="w-full">
        {busy ? "Signing in..." : "Sign in / create (dev)"}
      </Button>
    </form>
  );
}
