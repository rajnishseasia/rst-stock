import { describe, expect, it, test } from "bun:test";
import {
  extractFirstDiscordImageUrl,
  mergeDiscordSignalMetadata,
  normalizeDiscordSignalMetadata,
  stripLeadingTweeted,
} from "./discord-signal-parser";

describe("Discord signal parsing", () => {
  it("merges canonical identity metadata without losing historical aliases", () => {
    const result = mergeDiscordSignalMetadata(
      {
        authorName: "Old Name",
        authorHandle: "old_handle",
        authorAliases: ["old name", "old_handle"],
        messageId: "message-1",
      },
      {
        authorId: "42",
        authorName: "New Name",
        authorHandle: "new_handle",
        authorAvatar: null,
        messageId: "message-1",
        tweetUrl: null,
        imageUrl: null,
        authorSource: "x",
        sourceAuthorId: "42",
        canonicalAuthorKey: "source_author:x:42",
        authorAliases: ["old name", "old_handle", "new name", "new_handle"],
      },
    );

    expect(result.metadata.canonicalAuthorKey).toBe("source_author:x:42");
    expect(result.metadata.authorAliasHistory).toEqual(
      expect.arrayContaining(["old name", "old_handle", "new name", "new_handle"]),
    );
  });

  test("does not repair a relay row by falling back to authorId", () => {
    const result = mergeDiscordSignalMetadata(
      {
        authorId: "relay-webhook",
        authorName: "TweetShift",
        sourceAuthorId: "relay-webhook",
        canonicalAuthorKey: "source_author:discord:relay-webhook",
        authorIdentityKind: "relay",
      },
      {
        authorId: "relay-webhook",
        authorName: "TweetShift",
        authorAvatar: null,
        messageId: "message-1",
        tweetUrl: null,
        imageUrl: null,
        authorSource: "discord",
        sourceAuthorId: null,
        authorIdentityKind: "relay",
      },
    );

    expect(result.metadata.authorIdentityKind).toBe("relay");
    expect(result.metadata.sourceAuthorId).toBeUndefined();
    expect(result.metadata.canonicalAuthorKey).toBeUndefined();
  });

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

  test("treats a present non-image MIME type as authoritative", () => {
    expect(
      extractFirstDiscordImageUrl({
        attachments: [
          {
            filename: "payload.png",
            content_type: "application/pdf",
            url: "https://cdn.discordapp.com/payload.png",
          },
        ],
        embeds: [
          {
            image: { url: "https://pbs.twimg.com/media/chart.jpg" },
          },
        ],
      })
    ).toBe("https://pbs.twimg.com/media/chart.jpg");
  });

  test("recognizes image MIME with a misleading filename", () => {
    expect(
      extractFirstDiscordImageUrl({
        attachments: [
          {
            filename: "payload.bin",
            content_type: "image/png",
            url: "https://cdn.discordapp.com/payload.bin",
          },
        ],
      })
    ).toBe("https://cdn.discordapp.com/payload.bin");
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

  test("normalizes legacy string metadata", () => {
    expect(
      normalizeDiscordSignalMetadata(
        JSON.stringify({
          messageId: "original-message",
          imageUrl: "https://example.com/original.png",
          extra: "preserved",
        })
      )
    ).toEqual({
      messageId: "original-message",
      imageUrl: "https://example.com/original.png",
      extra: "preserved",
    });
  });

  test("preserves an existing image when the incoming relay has none", () => {
    const result = mergeDiscordSignalMetadata(
      {
        authorId: "author-1",
        authorName: "Original Author",
        authorAvatar: "https://example.com/avatar.png",
        messageId: "original-message",
        tweetUrl: "https://x.com/example/status/1",
        imageUrl: "https://example.com/original.png",
      },
      {
        authorId: "author-2",
        authorName: "Relay Author",
        authorAvatar: null,
        messageId: "second-relay",
        tweetUrl: "https://x.com/example/status/1",
        imageUrl: null,
      }
    );

    expect(result.metadata.imageUrl).toBe("https://example.com/original.png");
    expect(result.changed).toBeFalse();
  });

  test("fills a missing image and newly resolved tweet URL", () => {
    const result = mergeDiscordSignalMetadata(
      {
        authorId: "author-1",
        authorName: "Original Author",
        messageId: "original-message",
      },
      {
        authorId: "author-2",
        authorName: "Relay Author",
        authorAvatar: null,
        messageId: "second-relay",
        tweetUrl: "https://x.com/example/status/1",
        imageUrl: "https://example.com/new.png",
      }
    );

    expect(result.metadata).toEqual({
      authorId: "author-1",
      authorName: "Original Author",
      messageId: "original-message",
      tweetUrl: "https://x.com/example/status/1",
      imageUrl: "https://example.com/new.png",
    });
    expect(result.changed).toBeTrue();
  });

  test("preserves existing relay identity and extra metadata fields", () => {
    const result = mergeDiscordSignalMetadata(
      JSON.stringify({
        authorId: "author-1",
        authorName: "Original Author",
        authorAvatar: "https://example.com/original-avatar.png",
        messageId: "original-message",
        imageUrl: "https://example.com/original.png",
        extra: { source: "legacy" },
      }),
      {
        authorId: "author-2",
        authorName: "Relay Author",
        authorAvatar: "https://example.com/relay-avatar.png",
        messageId: "second-relay",
        tweetUrl: "https://x.com/example/status/1",
        imageUrl: "https://example.com/replacement.png",
      }
    );

    expect(result.metadata).toEqual({
      authorId: "author-1",
      authorName: "Original Author",
      authorAvatar: "https://example.com/original-avatar.png",
      messageId: "original-message",
      tweetUrl: "https://x.com/example/status/1",
      imageUrl: "https://example.com/original.png",
      extra: { source: "legacy" },
    });
    expect(result.changed).toBeTrue();
  });

  test("refreshes an existing image for the same Discord message", () => {
    const result = mergeDiscordSignalMetadata(
      {
        messageId: "original-message",
        imageUrl: "https://example.com/original.png",
      },
      {
        authorId: "author-1",
        authorName: "Original Author",
        authorAvatar: null,
        messageId: "original-message",
        tweetUrl: null,
        imageUrl: "https://example.com/refreshed.png",
      }
    );

    expect(result.metadata.imageUrl).toBe("https://example.com/refreshed.png");
    expect(result.changed).toBeTrue();
  });

  test("does not replace an existing image from a different relay", () => {
    const result = mergeDiscordSignalMetadata(
      {
        authorId: "author-1",
        authorName: "Original Author",
        authorAvatar: "https://example.com/avatar.png",
        messageId: "original-message",
        tweetUrl: "https://x.com/example/status/1",
        imageUrl: "https://example.com/original.png",
      },
      {
        authorId: "author-2",
        authorName: "Relay Author",
        authorAvatar: "https://example.com/relay-avatar.png",
        messageId: "second-relay",
        tweetUrl: "https://x.com/example/status/1",
        imageUrl: "https://example.com/relay.png",
      }
    );

    expect(result.metadata.imageUrl).toBe("https://example.com/original.png");
    expect(result.changed).toBeFalse();
  });

  test("reports a semantic no-op for equivalent legacy metadata", () => {
    const metadata = {
      authorId: "author-1",
      authorName: "Original Author",
      authorAvatar: null,
      messageId: "original-message",
      tweetUrl: "https://x.com/example/status/1",
      imageUrl: "https://example.com/original.png",
      extra: "preserved",
    };

    const result = mergeDiscordSignalMetadata(
      JSON.stringify(metadata),
      metadata
    );

    expect(result.metadata).toEqual(metadata);
    expect(result.changed).toBeFalse();
  });
});
