# X Signal Image Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove TweetShift's leading `Tweeted` label and add a first-image link to X Signal cards.

**Architecture:** Add pure worker parsing helpers for TweetShift text and Discord image selection, then have the poller persist the selected URL in existing JSON metadata. Add pure web helpers for metadata/content normalization so old rows render correctly before backfill, while the card renders one emoji-labeled image link.

**Tech Stack:** TypeScript, Bun test runner, Discord REST payloads, Drizzle JSON metadata, React 19

---

### Task 1: Parse And Persist Discord Images

**Files:**
- Create: `apps/worker/src/services/discord-signal-parser.ts`
- Create: `apps/worker/src/services/discord-signal-parser.test.ts`
- Modify: `apps/worker/src/services/discord-poller.ts`

- [ ] **Step 1: Write failing parser tests**

Create `apps/worker/src/services/discord-signal-parser.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  extractFirstDiscordImageUrl,
  stripLeadingTweeted,
} from "./discord-signal-parser";

describe("Discord signal parsing", () => {
  test("removes only a leading Tweeted label", () => {
    expect(stripLeadingTweeted("Tweeted $AMD is moving")).toBe("$AMD is moving");
    expect(stripLeadingTweeted("tweeted: $NVDA breakout")).toBe("$NVDA breakout");
    expect(stripLeadingTweeted("$AMD was tweeted yesterday")).toBe(
      "$AMD was tweeted yesterday"
    );
  });

  test("uses the first image attachment and skips non-images", () => {
    expect(
      extractFirstDiscordImageUrl({
        attachments: [
          {
            filename: "notes.pdf",
            content_type: "application/pdf",
            url: "https://cdn.discordapp.com/notes.pdf",
          },
          {
            filename: "chart.png",
            content_type: "image/png",
            url: "https://cdn.discordapp.com/chart.png",
          },
          {
            filename: "second.jpg",
            content_type: "image/jpeg",
            url: "https://cdn.discordapp.com/second.jpg",
          },
        ],
      })
    ).toBe("https://cdn.discordapp.com/chart.png");
  });

  test("recognizes an image attachment from its filename", () => {
    expect(
      extractFirstDiscordImageUrl({
        attachments: [
          {
            filename: "chart.webp",
            url: "https://cdn.discordapp.com/chart.webp?ex=123",
          },
        ],
      })
    ).toBe("https://cdn.discordapp.com/chart.webp?ex=123");
  });

  test("falls back to embed image and then thumbnail", () => {
    expect(
      extractFirstDiscordImageUrl({
        embeds: [
          {
            image: { url: "https://pbs.twimg.com/media/chart.jpg" },
            thumbnail: { url: "https://pbs.twimg.com/media/thumb.jpg" },
          },
        ],
      })
    ).toBe("https://pbs.twimg.com/media/chart.jpg");

    expect(
      extractFirstDiscordImageUrl({
        embeds: [
          {
            thumbnail: { url: "https://pbs.twimg.com/media/thumb.jpg" },
          },
        ],
      })
    ).toBe("https://pbs.twimg.com/media/thumb.jpg");
  });

  test("returns null when no image is available", () => {
    expect(
      extractFirstDiscordImageUrl({
        attachments: [
          {
            filename: "notes.pdf",
            content_type: "application/pdf",
            url: "https://cdn.discordapp.com/notes.pdf",
          },
        ],
        embeds: [],
      })
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run the parser tests and verify RED**

Run:

```bash
bun test apps/worker/src/services/discord-signal-parser.test.ts
```

Expected: FAIL because `discord-signal-parser.ts` does not exist.

- [ ] **Step 3: Implement the pure parser**

Create `apps/worker/src/services/discord-signal-parser.ts`:

```ts
export interface DiscordAttachment {
  filename?: string;
  content_type?: string | null;
  url?: string;
}

export interface DiscordMediaEmbed {
  image?: { url?: string };
  thumbnail?: { url?: string };
}

interface DiscordMediaMessage {
  attachments?: DiscordAttachment[];
  embeds?: DiscordMediaEmbed[];
}

const IMAGE_FILENAME_PATTERN = /\.(?:avif|gif|jpe?g|png|webp)$/i;

export function stripLeadingTweeted(content: string): string {
  return content.replace(/^tweeted\b[\s:]*/i, "").trim();
}

function isImageAttachment(attachment: DiscordAttachment): boolean {
  if (attachment.content_type?.toLowerCase().startsWith("image/")) return true;
  return IMAGE_FILENAME_PATTERN.test(attachment.filename ?? "");
}

export function extractFirstDiscordImageUrl(
  message: DiscordMediaMessage
): string | null {
  const attachment = message.attachments?.find(
    (candidate) => candidate.url && isImageAttachment(candidate)
  );
  if (attachment?.url) return attachment.url;

  for (const embed of message.embeds ?? []) {
    if (embed.image?.url) return embed.image.url;
  }
  for (const embed of message.embeds ?? []) {
    if (embed.thumbnail?.url) return embed.thumbnail.url;
  }

  return null;
}
```

- [ ] **Step 4: Run the parser tests and verify GREEN**

Run:

```bash
bun test apps/worker/src/services/discord-signal-parser.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Update the Discord poller payload types and normalization**

In `apps/worker/src/services/discord-poller.ts`, import the helpers:

```ts
import {
  extractFirstDiscordImageUrl,
  stripLeadingTweeted,
  type DiscordAttachment,
  type DiscordMediaEmbed,
} from "./discord-signal-parser";
```

Extend `DiscordEmbed`:

```ts
interface DiscordEmbed extends DiscordMediaEmbed {
  title?: string;
  description?: string;
  url?: string;
  author?: { name?: string; url?: string; icon_url?: string };
  fields?: { name: string; value: string }[];
}
```

Extend `DiscordMessage`:

```ts
interface DiscordMessage {
  id: string;
  content: string;
  author: {
    id: string;
    username: string;
    avatar?: string | null;
    bot?: boolean;
  };
  timestamp: string;
  channel_id: string;
  guild_id?: string;
  attachments?: DiscordAttachment[];
  embeds?: DiscordEmbed[];
}
```

After markdown links, floating URLs, and repeated whitespace are normalized,
strip the TweetShift prefix:

```ts
fullText = stripLeadingTweeted(fullText.replace(/\s+/g, " ").trim());
```

Before processing symbols, select the first image:

```ts
const imageUrl = extractFirstDiscordImageUrl(msg);
```

Build metadata once before the symbol loop:

```ts
const metadata = {
  authorId: msg.author.id,
  authorName: msg.author.username,
  authorAvatar,
  messageId: msg.id,
  tweetUrl,
  imageUrl,
};
```

Include metadata in existing-row repairs:

```ts
const updates: {
  url?: string | null;
  content?: string;
  metadata?: typeof metadata;
} = {};
if (tweetUrl && existing.url !== tweetUrl) updates.url = tweetUrl;
if (existing.content !== content) updates.content = content;
updates.metadata = metadata;
```

Store the object directly in the JSONB column for new rows:

```ts
metadata,
```

- [ ] **Step 6: Run worker tests and type checking**

Run:

```bash
bun test apps/worker/src/services/discord-signal-parser.test.ts
bun --filter @trade-bot/worker typecheck
```

Expected: parser tests pass and worker TypeScript exits 0.

- [ ] **Step 7: Commit the worker change**

```bash
git add apps/worker/src/services/discord-signal-parser.ts \
  apps/worker/src/services/discord-signal-parser.test.ts \
  apps/worker/src/services/discord-poller.ts
git commit -m "feat(worker): capture Discord signal images"
```

### Task 2: Normalize And Render Sidebar Actions

**Files:**
- Create: `apps/web-v2/src/components/feed/signal-feed-utils.ts`
- Create: `apps/web-v2/src/components/feed/signal-feed.test.ts`
- Modify: `apps/web-v2/src/components/feed/signal-feed.tsx`

- [ ] **Step 1: Write failing sidebar helper and source tests**

Create `apps/web-v2/src/components/feed/signal-feed.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  normalizeSignalContent,
  parseSignalMetadata,
} from "./signal-feed-utils";

const feedSource = readFileSync(
  new URL("./signal-feed.tsx", import.meta.url),
  "utf8"
);

describe("X signal display", () => {
  test("removes the legacy leading Tweeted label only", () => {
    expect(normalizeSignalContent("Tweeted $AMD is moving")).toBe(
      "$AMD is moving"
    );
    expect(normalizeSignalContent("$AMD was tweeted yesterday")).toBe(
      "$AMD was tweeted yesterday"
    );
  });

  test("parses author and image data from object metadata", () => {
    expect(
      parseSignalMetadata({
        authorName: "Serenity • TweetShift",
        authorAvatar: "https://example.com/avatar.png",
        imageUrl: "https://example.com/chart.png",
      })
    ).toEqual({
      authorName: "Serenity",
      authorAvatar: "https://example.com/avatar.png",
      imageUrl: "https://example.com/chart.png",
    });
  });

  test("parses image data from string metadata and tolerates malformed data", () => {
    expect(
      parseSignalMetadata(
        JSON.stringify({
          authorName: "Trader",
          imageUrl: "https://example.com/chart.jpg",
        })
      )
    ).toEqual({
      authorName: "Trader",
      authorAvatar: null,
      imageUrl: "https://example.com/chart.jpg",
    });
    expect(parseSignalMetadata("{bad json")).toEqual({
      authorName: "Unknown",
      authorAvatar: null,
      imageUrl: null,
    });
  });

  test("keeps emoji labels on every view action", () => {
    expect(feedSource).toContain("👀 View more");
    expect(feedSource).toContain("🙈 View less");
    expect(feedSource).toContain("🔗 View Original");
    expect(feedSource).toContain("🖼️ View image");
  });
});
```

- [ ] **Step 2: Run the sidebar test and verify RED**

Run:

```bash
bun test apps/web-v2/src/components/feed/signal-feed.test.ts
```

Expected: FAIL because `signal-feed-utils.ts` and `🖼️ View image` do not exist.

- [ ] **Step 3: Implement sidebar normalization helpers**

Create `apps/web-v2/src/components/feed/signal-feed-utils.ts`:

```ts
export interface SignalDisplayMetadata {
  authorName: string;
  authorAvatar: string | null;
  imageUrl: string | null;
}

export function cleanAuthorName(name: string): string {
  return name.replace(/\s*[•·|–-]\s*TweetShift\s*$/i, "").trim() || name;
}

export function normalizeSignalContent(content: string): string {
  return content.replace(/^tweeted\b[\s:]*/i, "").trim();
}

export function parseSignalMetadata(metadata: unknown): SignalDisplayMetadata {
  try {
    const parsed =
      typeof metadata === "string" ? JSON.parse(metadata) : metadata;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Invalid signal metadata");
    }

    const value = parsed as Record<string, unknown>;
    const rawAuthorName =
      typeof value.authorName === "string" ? value.authorName : "Unknown";

    return {
      authorName: cleanAuthorName(rawAuthorName),
      authorAvatar:
        typeof value.authorAvatar === "string" ? value.authorAvatar : null,
      imageUrl: typeof value.imageUrl === "string" ? value.imageUrl : null,
    };
  } catch {
    return {
      authorName: "Unknown",
      authorAvatar: null,
      imageUrl: null,
    };
  }
}
```

- [ ] **Step 4: Update the sidebar to use normalized metadata and content**

In `apps/web-v2/src/components/feed/signal-feed.tsx`:

1. Import `normalizeSignalContent` and `parseSignalMetadata`.
2. Remove the local `cleanAuthorName` and `deriveAuthor` functions.
3. Change `SignalContent` props to include `imageUrl`:

```ts
function SignalContent({
  content,
  url,
  imageUrl,
}: {
  content: string;
  url?: string | null;
  imageUrl?: string | null;
}) {
```

4. Include `imageUrl` in the action-row condition:

```tsx
{(overflowing || expanded || url || imageUrl) && (
```

5. Add the first-image action after `View Original`:

```tsx
{imageUrl && (
  <a
    href={imageUrl}
    target="_blank"
    rel="noreferrer"
    className="text-xs font-medium text-primary hover:underline"
    onClick={(event) => event.stopPropagation()}
  >
    🖼️ View image
  </a>
)}
```

6. Normalize each row in the existing `processed` memo:

```ts
const processed = useMemo(
  () =>
    signals.map((signal) => {
      const metadata = parseSignalMetadata(signal.metadata);
      return {
        ...signal,
        ...metadata,
        content: normalizeSignalContent(signal.content),
      };
    }),
  [signals]
);
```

7. Pass the image URL into `SignalContent`:

```tsx
<SignalContent
  content={signal.content}
  url={signal.url}
  imageUrl={signal.imageUrl}
/>
```

- [ ] **Step 5: Run the sidebar tests and verify GREEN**

Run:

```bash
bun test apps/web-v2/src/components/feed/signal-feed.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 6: Run web type checking**

Run:

```bash
bun --filter @trade-bot/web typecheck
```

Expected: TypeScript exits 0.

- [ ] **Step 7: Commit the sidebar change**

```bash
git add apps/web-v2/src/components/feed/signal-feed-utils.ts \
  apps/web-v2/src/components/feed/signal-feed.test.ts \
  apps/web-v2/src/components/feed/signal-feed.tsx
git commit -m "feat(web): link signal images in X sidebar"
```

### Task 3: Final Verification

**Files:**
- Verify: `apps/worker/src/services/discord-signal-parser.test.ts`
- Verify: `apps/web-v2/src/components/feed/signal-feed.test.ts`
- Verify: `apps/worker/src/services/discord-poller.ts`
- Verify: `apps/web-v2/src/components/feed/signal-feed.tsx`

- [ ] **Step 1: Run both focused test files together**

```bash
bun test \
  apps/worker/src/services/discord-signal-parser.test.ts \
  apps/web-v2/src/components/feed/signal-feed.test.ts
```

Expected: 9 tests pass with 0 failures.

- [ ] **Step 2: Run both affected package type checks**

```bash
bun --filter @trade-bot/worker typecheck
bun --filter @trade-bot/web typecheck
```

Expected: both commands exit 0.

- [ ] **Step 3: Check formatting and relevant diff scope**

```bash
git diff --check HEAD~2..HEAD
git status --short
```

Expected: no whitespace errors; only pre-existing unrelated chart changes remain
uncommitted.
