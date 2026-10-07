# CI And Secret Rotation

## Required repository setting

Protect `main` with the required status check named `build-and-test` from the
`CI` workflow. Require it for pull requests and prevent bypasses except for
the repository administrators who are responsible for incident response.

## Historical credential follow-up

The CI secret scan checks the checked-out tree only. It does not rewrite Git
history or rotate credentials that may have appeared in older commits. A
maintainer must rotate each affected category and record an explicit rotation
confirmation in the incident or change record:

- brokerage, market-data, and trading-provider API keys and secrets;
- database connection URLs and Redis connection credentials;
- OAuth client secrets and application authentication secrets;
- AI, notification, logging, and third-party service API tokens;
- worker-to-API and log-bridge shared secrets;
- blockchain, treasury, and Polymarket private keys;
- the credential-encryption master key.

Do not put replacement values in tickets, pull requests, CI logs, or this
document. Confirm the old credential is revoked, the replacement is deployed,
and dependent services are healthy before closing the rotation.

## Encryption-key rotation

Rotating the credential-encryption master key requires a coordinated data
migration. Decrypt every stored credential with the old key, re-encrypt it with
the new key, verify that the application can read the migrated records, and
only then retire the old key. Do not rotate this key as a simple environment
variable replacement: doing so would make existing stored credentials
unreadable.
