import { eq } from "drizzle-orm";
import { getDb, schema } from "@trade-bot/db";

export type TwitterProfileSyncResult =
  | { ok: true }
  | { ok: false; reason: "api_error" | "invalid_profile" | "update_error" };

/**
 * Fetch a Twitter profile with an OAuth access token and persist its public
 * identity fields (username, twitterName, image) to the users table.
 *
 * This is called exactly ONCE: right when a user links their Twitter account,
 * using the fresh OAuth access token that Better Auth just obtained. After
 * this runs successfully the leaderboard and feed read from the DB forever —
 * no further Twitter API calls are made for this user.
 */
export async function syncUserFromTwitterToken(
  userId: string,
  accessToken: string,
): Promise<TwitterProfileSyncResult> {
  try {
    const resp = await fetch(
      "https://api.x.com/2/users/me?user.fields=name,username,profile_image_url",
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => "(unreadable)");
      console.error(`[Twitter sync] GET /2/users/me returned ${resp.status}: ${body}`);
      return { ok: false, reason: "api_error" };
    }
    const json = (await resp.json()) as {
      data?: { name?: string; username?: string; profile_image_url?: string };
    };
    if (!json?.data) return { ok: false, reason: "invalid_profile" };

    const { name, username, profile_image_url } = json.data;
    if (!name && !username) return { ok: false, reason: "invalid_profile" };

    // Twitter returns _normal (48px) images; upgrade to 400x400 for sharper display.
    const image = profile_image_url
      ? profile_image_url.replace(/_normal(\.[a-z]+)$/i, "_400x400$1")
      : undefined;
    await getDb()
      .update(schema.users)
      .set({
        ...(username ? { username } : {}),
        ...(name ? { twitterName: name } : {}),
        ...(image ? { image } : {}),
      })
      .where(eq(schema.users.id, userId));
    return { ok: true };
  } catch (error) {
    console.error("[Twitter sync] failed to update user profile:", error);
    return { ok: false, reason: "update_error" };
  }
}
