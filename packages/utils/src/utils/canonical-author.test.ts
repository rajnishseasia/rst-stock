import { describe, expect, it } from "bun:test";
import {
  authorMatchKeys,
  buildCanonicalAuthorMetadata,
  canonicalAuthorKey,
  isSourceAuthorAliasKey,
  readCanonicalAuthorForSource,
  resolveCanonicalAuthorAlias,
  sourceAuthorAliasKey,
} from "./canonical-author";

describe("canonical author identity", () => {
  it("keeps the immutable source key across handle and display-name changes", () => {
    const first = buildCanonicalAuthorMetadata({}, {
      source: "x",
      sourceAuthorId: "12345",
      currentHandle: "old_handle",
      displayName: "Old Name",
    });
    const renamed = buildCanonicalAuthorMetadata(first, {
      source: "x",
      sourceAuthorId: "12345",
      currentHandle: "new_handle",
      displayName: "New Name",
    });

    expect(renamed.canonicalAuthorKey).toBe(canonicalAuthorKey("x", "12345"));
    expect(renamed.canonicalAuthorKey).toBe(first.canonicalAuthorKey);
    expect(renamed.authorAliasHistory).toEqual(
      expect.arrayContaining(["old_handle", "old name", "new_handle", "new name"]),
    );
  });

  it("source-qualifies IDs and refuses empty IDs", () => {
    expect(canonicalAuthorKey("x", "12345")).not.toBe(
      canonicalAuthorKey("discord", "12345"),
    );
    expect(canonicalAuthorKey("x", "12345")).not.toBe(
      canonicalAuthorKey("x", "12346"),
    );
    expect(canonicalAuthorKey("x", "   ")).toBeNull();
  });

  it("does not promote a legacy relay authorId into a Discord identity", () => {
    const view = readCanonicalAuthorForSource(
      { authorId: "relay-1", authorName: "TweetShift" },
      "discord",
    );
    expect(view.source).toBe("discord");
    expect(view.sourceAuthorId).toBeNull();
    expect(view.canonicalAuthorKey).toBeNull();
    expect(
      authorMatchKeys({
        authorId: "relay-1",
        authorName: "TweetShift",
        authorSource: "discord",
      }),
    ).toEqual([]);
  });

  it("keeps an explicitly-proven source author ID canonical", () => {
    const view = readCanonicalAuthorForSource(
      {
        authorId: "42",
        authorName: "Human Caller",
        authorIdentityKind: "source_author",
        sourceAuthorId: "42",
      },
      "discord",
    );
    expect(view.sourceAuthorId).toBe("42");
    expect(view.canonicalAuthorKey).toBe(canonicalAuthorKey("discord", "42"));
  });

  it("does not rebind a mismatched stored key to the row source", () => {
    const view = readCanonicalAuthorForSource(
      {
        authorSource: "x",
        canonicalAuthorKey: "source_author:x:42",
        authorName: "Caller",
      },
      "discord",
    );

    expect(view.source).toBe("discord");
    expect(view.sourceAuthorId).toBeNull();
    expect(view.canonicalAuthorKey).toBeNull();
  });

  it("only resolves a legacy alias within its source", () => {
    const observations = [
      { source: "x", canonicalKey: "source_author:x:1", aliases: ["old name", "shared"] },
      { source: "discord", canonicalKey: "source_author:discord:2", aliases: ["old name"] },
    ];

    expect(resolveCanonicalAuthorAlias("old name", "x", observations)).toBe(
      "source_author:x:1",
    );
    expect(resolveCanonicalAuthorAlias("old name", "discord", observations)).toBe(
      "source_author:discord:2",
    );
    expect(resolveCanonicalAuthorAlias("missing", "x", observations)).toBeNull();
    expect(resolveCanonicalAuthorAlias("source_alias:discord:old%20name", "x", observations)).toBeNull();
  });

  it("encodes aliases with their source", () => {
    const key = sourceAuthorAliasKey("x", "Shared Name");
    expect(key).toBe("source_alias:x:shared%20name");
    expect(isSourceAuthorAliasKey(key)).toBe(true);
    expect(isSourceAuthorAliasKey("shared name")).toBe(false);
  });
});
