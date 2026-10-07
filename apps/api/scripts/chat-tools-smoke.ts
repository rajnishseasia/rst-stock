/**
 * chat-tools-smoke.ts
 *
 * One-shot smoke test for the chat tool-calling loop. Bypasses HTTP+OAuth by
 * importing `createStockChatStream` directly and feeding it a real user id +
 * DB pool. Useful for verifying that:
 *   - `alpaca_*` tools execute end-to-end against a saved Alpaca credential.
 *   - `signa_*` tools populate from the MCP server and get invoked by the LLM.
 *
 * Run with:
 *   bun apps/api/scripts/chat-tools-smoke.ts "<prompt>"
 *
 * Env required (already in apps/api/.env):
 *   DATABASE_URL, ENCRYPTION_KEY, SIGNA_API_KEY (for signa_* tools)
 *
 * Extra:
 *   USER_EMAIL  — which user to act as (REQUIRED; no default)
 *   DEEPSEEK_API_KEY — if set, upserts a deepseek LLM credential for the user
 *   --yes-prod  — required when DATABASE_URL points at a non-local database
 */

// Bun auto-loads .env from cwd. We invoke this script from the repo root
// (`bun apps/api/scripts/chat-tools-smoke.ts ...`) with the env vars piped
// in via `--env-file` or loaded manually below from apps/api/.env.
import { readFileSync } from "node:fs";
{
  const envPath = new URL("../.env", import.meta.url).pathname;
  try {
    const text = readFileSync(envPath, "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const [, k, raw] = m;
      const v = raw.replace(/^['"](.*)['"]$/, "$1");
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch (err) {
    console.error(`(could not load ${envPath}: ${(err as Error).message})`);
  }
}

import { eq } from "drizzle-orm";
import { getDb, schema } from "@trade-bot/db";
import { encrypt } from "@trade-bot/utils";
import { createStockChatStream } from "../src/lib/chat/stream.js";
import { maskEmail, requireLocalDbOrExplicitConsent } from "./lib/guard.js";

// Audit M2: this script reads a user row and can INSERT an LLM credential.
// Refuse to run against a non-local DB without an explicit --yes-prod, and
// require the target user to be named explicitly rather than defaulting to a
// hardcoded real address.
requireLocalDbOrExplicitConsent("chat-tools-smoke");

// Flags (e.g. --yes-prod) are consumed by the guard, never used as the prompt.
const PROMPT =
  process.argv.slice(2).find((arg) => !arg.startsWith("--")) ??
  "What's in my Alpaca paper account right now?";
const USER_EMAIL = process.env.USER_EMAIL ?? "";
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;

if (!USER_EMAIL) {
  console.error(
    "USER_EMAIL is required (which user to act as). Example: USER_EMAIL=you@example.com bun apps/api/scripts/chat-tools-smoke.ts",
  );
  process.exit(1);
}

async function main() {
  const db = getDb();

  // 1. Find the user.
  const user = await db.query.users.findFirst({
    where: (u, { eq }) => eq(u.email, USER_EMAIL),
  });
  if (!user) {
    console.error(`No user with email=${maskEmail(USER_EMAIL)}. Aborting.`);
    process.exit(1);
  }
  console.log(`✓ User: ${maskEmail(user.email)} (${user.id})`);

  // 2. Ensure a DeepSeek LLM credential exists for the user.
  let llmCred = await db.query.userLlmApiCredentials.findFirst({
    where: (c, { and, eq }) =>
      and(eq(c.userId, user.id), eq(c.provider, "deepseek")),
  });
  if (!llmCred && DEEPSEEK_KEY) {
    const last4 = DEEPSEEK_KEY.slice(-4);
    const encryptedApiKey = encrypt(DEEPSEEK_KEY);
    const [inserted] = await db
      .insert(schema.userLlmApiCredentials)
      .values({
        userId: user.id,
        provider: "deepseek",
        label: "DeepSeek (smoke test)",
        encryptedApiKey,
        apiKeyLast4: last4,
        baseUrl: "https://api.deepseek.com",
        defaultModel: "deepseek-v4-pro",
      })
      .returning();
    llmCred = inserted;
    console.log(`✓ Inserted DeepSeek credential ${llmCred!.id}`);
  } else if (!llmCred) {
    console.error("No DeepSeek credential and DEEPSEEK_API_KEY not provided.");
    process.exit(1);
  } else {
    console.log(`✓ Existing LLM credential ${llmCred.id} (${llmCred.provider})`);
  }

  // 3. Find an Alpaca credential if available (optional — alpaca tools will
  //    return a helpful error if missing instead of crashing).
  const alpacaCred = await db.query.userApiCredentials.findFirst({
    where: (c, { and, eq }) =>
      and(eq(c.userId, user.id), eq(c.provider, "alpaca")),
  });
  if (alpacaCred) {
    console.log(`✓ Alpaca credential ${alpacaCred.id} (${alpacaCred.accountType ?? "?"})`);
  } else {
    console.log("• No Alpaca credential — alpaca_* tools will error out.");
  }

  // 4. Build the chat stream.
  const stream = createStockChatStream({
    db,
    userId: user.id,
    input: {
      llmCredentialId: llmCred!.id,
      messages: [{ role: "user", content: PROMPT }],
      alpacaCredentialId: alpacaCred?.id,
      activeAccountType: alpacaCred?.accountType === "LIVE" ? "LIVE" : "PAPER",
    },
  });

  // 5. Pipe SSE frames to stdout, decoded.
  console.log(`\n──── PROMPT ────\n${PROMPT}\n──── STREAM ────`);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (;;) {
      const idx = buf.indexOf("\n\n");
      if (idx < 0) break;
      const frame = buf.slice(0, idx).replace(/^data:\s*/, "");
      buf = buf.slice(idx + 2);
      try {
        const payload = JSON.parse(frame);
        console.log(JSON.stringify(payload));
      } catch {
        if (frame.trim()) console.log(`[raw] ${frame}`);
      }
    }
  }
  console.log("──── END ────");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
