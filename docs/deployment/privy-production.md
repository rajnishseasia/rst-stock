# Privy Custom Auth Production Handoff

This checklist is for the maintainer deploying the zero-extra-login Hyperliquid
wallet flow. Better Auth remains the site's login system. Privy accepts the
short-lived Better Auth JWT and creates or restores the user's embedded perps
wallet without asking for a second Google or email login.

The local proof used a temporary Cloudflare tunnel as the JWKS endpoint. **Do
not use that tunnel URL in production.** Production must use the canonical web
origin and a Privy app whose public and server credentials are deployed to the
corresponding services.

## 1. Confirm the Privy app

Use the Privy application whose ID will be set as both:

- `NEXT_PUBLIC_PRIVY_APP_ID` in the web deployment.
- `PRIVY_APP_ID` in the API and worker deployments.

The app ID, app secret, client ID, and authorization key must belong to the same
Privy app. A separate Privy app for local development is recommended because a
Privy app has one active JWKS configuration; replacing the local tunnel with the
production endpoint will stop that app from trusting locally generated keys.

Privy Development mode can sign mainnet requests but has Privy's development
user limits. Upgrade the app before exceeding those limits.

## 2. Configure JWT-based authentication in Privy

Before the JWT form is available, the Privy app must have **Custom Auth
Support** enabled. In the Privy Dashboard, open **App settings -> Integrations
-> Plugins** and enable or request access to Custom Auth Support. Privy may
require an organization owner/admin or Privy support to approve this feature.

If **User management -> Authentication -> JWT integration** shows only the
introductory paragraph and no enable toggle or configuration form, Custom Auth
Support is not enabled for that app (or the signed-in dashboard member lacks
permission). Do not work around this by using credentials from a different
Privy app.

In the Privy Dashboard, open:

**User management -> Authentication -> JWT integration**

Configure the page as follows:

| Setting | Production value |
| --- | --- |
| JWT-based authentication | Enabled |
| User ID claim | `sub` |
| Sub-user ID claim | Leave blank |
| Verification method | JWKS endpoint |
| JWKS endpoint | `https://www.readysettrade.app/api/auth/jwks` |
| Authentication environment | Client side |
| Allowed `aud` value | `https://www.readysettrade.app` |
| Allowed `iss` value | `https://www.readysettrade.app` |

Client-side authentication is required because `@privy-io/react-auth` obtains
the Better Auth JWT in the browser. The server-side Privy Wallet API uses the
app secret and authorization key instead of this user JWT.

Save the dashboard configuration. Also confirm the Privy app client referenced
by `NEXT_PUBLIC_PRIVY_CLIENT_ID` permits `https://www.readysettrade.app` as an
application origin.

Finally, compare the app ID in the Privy dashboard URL with
`NEXT_PUBLIC_PRIVY_APP_ID` and `PRIVY_APP_ID`. Dashboard display names and
organization names are not reliable identifiers. If the IDs differ, configure
the app used by the deployment or deliberately update every web/API/worker
Privy variable to the new app's matching credentials before redeploying.

Privy's setup reference:
<https://docs.privy.io/authentication/user-authentication/jwt-based-auth/setup>

## 3. Configure production environment variables

### Web Vercel project (`apps/web-v2`)

Set these for the Production environment:

```env
NEXT_PUBLIC_API_URL=https://<deployed-api-project>.vercel.app
NEXT_PUBLIC_PRIVY_APP_ID=<production-privy-app-id>
NEXT_PUBLIC_PRIVY_CLIENT_ID=<production-privy-client-id>
NEXT_PUBLIC_PRIVY_CUSTOM_AUTH=true
NEXT_PUBLIC_ARBITRUM_RPC_URL=https://<keyed-arbitrum-rpc>
```

`NEXT_PUBLIC_API_URL` must be the separate API deployment, not the web app or
custom domain. All `NEXT_PUBLIC_*` values are compiled into the web bundle, so
changing them requires a new web deployment.

### API Vercel project (`apps/api`)

Set these for the Production environment:

```env
WEB_URL=https://www.readysettrade.app
TRUSTED_ORIGINS=https://www.readysettrade.app
PRIVY_APP_ID=<same-production-privy-app-id>
PRIVY_APP_SECRET=<production-privy-app-secret>
PRIVY_AUTHORIZATION_KEY=<production-p256-authorization-key>
```

Keep the existing production `BETTER_AUTH_SECRET`, database variables, Google
OAuth credentials, and encryption key configured. `WEB_URL` is load-bearing:
it becomes the JWT `iss` and `aud`. If multiple origins are temporarily listed,
`https://www.readysettrade.app` must be the first value.

The `jwks` table is created by migration
`packages/db/migrations/0018_classy_sue_storm.sql`, applied by the Railway
worker's `preDeployCommand`; confirm that migration succeeds against the
production database. Better Auth creates the ES256 signing key lazily and stores
it in this table encrypted with `BETTER_AUTH_SECRET`.

### Worker deployment

The worker's Hyperliquid order reconciliation requires the same server-side
Privy values:

```env
PRIVY_APP_ID=<same-production-privy-app-id>
PRIVY_APP_SECRET=<production-privy-app-secret>
PRIVY_AUTHORIZATION_KEY=<production-p256-authorization-key>
```

Never place `PRIVY_APP_SECRET`, `PRIVY_AUTHORIZATION_KEY`, wallet private keys,
or Better Auth tokens in GitHub, screenshots, browser comments, or client-side
environment variables.

## 4. Point the production domain at the new deployment

In the web Vercel project:

1. Confirm `www.readysettrade.app` is attached to the web project.
2. Promote or redeploy the commit containing the custom-auth implementation.
3. Confirm the custom domain resolves to that successful Production deployment,
   not an older deployment or a preview alias.
4. Redeploy the API after setting `WEB_URL` and the Privy server credentials.
5. Redeploy the web app after setting the public Privy values.

The production deployment must return the same app at both the custom domain
and its Vercel production alias; the application redirects Vercel production
hosts to the canonical custom domain.

## 5. Verify production before announcing the feature

### Public endpoint checks

```bash
curl -fsS https://www.readysettrade.app/api/auth/jwks | jq .
curl -I https://www.readysettrade.app/app
```

The JWKS response must contain a non-empty `keys` array with an ES256 public key
and must not redirect to a login page, return HTML, or expose private key data.

### Signed-in browser checks

1. Use a private browser window and create a new Ready Set Trade account with
   Google.
2. Open `/settings` and select **Perps**.
3. Confirm there is no second Privy Google/email prompt and no persistent
   **Connect Perps Wallet** action.
4. Wait for wallet preparation to finish, then confirm a wallet address appears.
5. Refresh the page and confirm the same wallet is restored rather than replaced.
6. Confirm an existing perps user still sees the previously enrolled wallet.
7. Open `/app`, select **Perps**, search for a standard perp and an `xyz:` HIP-3
   market, and confirm market data and the trade ticket load.

In browser developer tools, `GET /api/auth/token` should return 200 for a signed-
in user. Do not copy the token into a ticket or third-party JWT debugger.

### Wallet-management troubleshooting

The server-side Hyperliquid agent and the client-side Privy wallet-management
session are separate. An account can therefore keep trading with its approved
agent while wallet export, funding, withdrawal, and agent-management controls
remain unavailable until Privy restores the embedded wallet session.

Privy export is not a one-time recovery operation: for a client-side embedded
wallet, an authenticated user can export the key at any time with the Privy
wallet export flow. The user does not need to have exported it previously. This
application uses that client-side flow for wallets created or imported in the
web app. Server-created wallets must instead be exported through the Privy
server-side SDK or REST API. See the [Privy export documentation](https://docs.privy.io/wallets/wallets/export).

- `GET /api/auth/jwks` returning `200` only proves that the public key endpoint
  is reachable. It does not prove that the production Privy app has Custom Auth
  enabled or is using the correct issuer and audience.
- `GET /api/auth/token` returning `401` without the signed-in browser cookie is
  expected. With a signed-in user on the canonical web origin it must return
  `200` and a JSON token. Never paste that token into a ticket or debugger.
- If the UI says **Wallet-management session unavailable**, use **Try again**
  first, then **Reset wallet session**. The reset logs out only the Privy
  browser session, reloads the app, and re-syncs the current Better Auth
  session; it does not remove the Hyperliquid account, balance, or approved
  agent. It should not prompt for Google/email again.
- If reset still fails, verify the production Privy dashboard values exactly:
  Custom Auth enabled, JWKS endpoint
  `https://www.readysettrade.app/api/auth/jwks`, issuer
  `https://www.readysettrade.app`, and audience
  `https://www.readysettrade.app`. Also verify that the web deployment's public
  Privy app/client IDs match the API and worker app ID.
- If the UI asks for a private key that the user never received, do not ask them
  to invent or re-enter one. First restore the authenticated Privy session for
  the embedded wallet; once it is present, the normal **Export Private Key**
  action works even if the user has never exported it before. If the wallet was
  created server-side, use the server-side Privy export flow instead.

## 6. Failure guide

- **Connect Perps Wallet still appears:** confirm the web deployment was rebuilt
  with `NEXT_PUBLIC_PRIVY_CUSTOM_AUTH=true` and the same Privy app/client IDs as
  the dashboard configuration.
- **Privy custom auth times out:** check that the production JWKS URL returns
  JSON publicly, the `jwks` migration exists in production, and Privy has the
  exact production `iss` and `aud` values.
- **JWKS is empty or errors:** inspect the API deployment logs and confirm the
  database and stable `BETTER_AUTH_SECRET` are available to the API.
- **A user gets a different wallet after refresh:** stop rollout and verify the
  Privy app IDs match across web/API/worker before funding or trading.
- **Emergency rollback:** set `NEXT_PUBLIC_PRIVY_CUSTOM_AUTH=false` and redeploy
  the web app. This restores the legacy second-login flow without deleting any
  existing wallets.
