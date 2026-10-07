-- Paper/SIM Alpaca activity is never public. Remove any exact, account-scoped
-- rows produced before this policy was enforced at publication time. Legacy
-- rows without order_id are also hidden by the read-side eligibility guard.
DELETE FROM "social_trades" AS "social"
USING "orders" AS "orders", "user_api_credentials" AS "credentials"
WHERE "social"."order_id" = "orders"."id"
  AND "credentials"."provider" = 'alpaca'
  AND "credentials"."account_type" IN ('PAPER', 'SIM')
  AND (
    "orders"."broker_credential_id" = "credentials"."id"
    OR (
      "orders"."broker_credential_id" IS NULL
      AND "orders"."user_id" = "credentials"."user_id"
      AND "orders"."broker_account_id" = "credentials"."account_id"
    )
  );
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "share_trades";
