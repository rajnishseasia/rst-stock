import { buildCanonicalAuthorMetadata } from "@trade-bot/utils";
import type { CanonicalAuthorIdentityKind } from "@trade-bot/utils";

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

export interface DiscordSignalMetadataInput {
  authorId: string;
  authorName: string;
  authorHandle?: string | null;
  authorAvatar: string | null;
  messageId: string;
  tweetUrl: string | null;
  imageUrl: string | null;
  authorSource?: string | null;
  sourceAuthorId?: string | null;
  authorIdentityKind?: CanonicalAuthorIdentityKind;
  canonicalAuthorKey?: string | null;
  authorAliases?: string[];
  authorAliasHistory?: string[];
}

export interface DiscordSignalMetadataMergeResult {
  metadata: Record<string, unknown>;
  changed: boolean;
}

const IMAGE_FILENAME_PATTERN = /\.(?:avif|gif|jpe?g|png|webp)$/i;

export function stripLeadingTweeted(content: string): string {
  return content.replace(/^tweeted\b[\s:]*/i, "").trim();
}

function isImageAttachment(attachment: DiscordAttachment): boolean {
  const contentType = attachment.content_type?.trim();
  if (contentType) return contentType.toLowerCase().startsWith("image/");
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

export function normalizeDiscordSignalMetadata(
  value: unknown
): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return normalizeDiscordSignalMetadata(JSON.parse(value));
    } catch {
      return {};
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }

  return {};
}

function hasMetadataValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

export function mergeDiscordSignalMetadata(
  existingValue: unknown,
  incoming: DiscordSignalMetadataInput
): DiscordSignalMetadataMergeResult {
  const metadata = normalizeDiscordSignalMetadata(existingValue);
  const isSameMessage =
    hasMetadataValue(metadata.messageId) &&
    metadata.messageId === incoming.messageId;
  let changed = false;

  const fillMissing = (
    key: "authorId" | "authorName" | "authorAvatar" | "messageId",
    value: string | null
  ) => {
    if (!hasMetadataValue(metadata[key]) && hasMetadataValue(value)) {
      metadata[key] = value;
      changed = true;
    }
  };

  fillMissing("authorId", incoming.authorId);
  fillMissing("authorName", incoming.authorName);
  fillMissing("authorAvatar", incoming.authorAvatar);
  fillMissing("messageId", incoming.messageId);

  if (incoming.tweetUrl !== null && metadata.tweetUrl !== incoming.tweetUrl) {
    metadata.tweetUrl = incoming.tweetUrl;
    changed = true;
  }
  if (
    incoming.imageUrl !== null &&
    metadata.imageUrl !== incoming.imageUrl &&
    (!hasMetadataValue(metadata.imageUrl) || isSameMessage)
  ) {
    metadata.imageUrl = incoming.imageUrl;
    changed = true;
  }

  if (
    incoming.authorSource ||
    incoming.sourceAuthorId ||
    incoming.canonicalAuthorKey ||
    incoming.authorIdentityKind
  ) {
    const canonical = buildCanonicalAuthorMetadata(metadata, {
      source: incoming.authorSource ?? "discord",
      sourceAuthorId: incoming.sourceAuthorId,
      identityKind: incoming.authorIdentityKind,
      currentHandle: incoming.authorHandle ?? incoming.authorName,
      displayName: incoming.authorName,
      avatar: incoming.authorAvatar,
      safeAliases: incoming.authorAliases,
    });
    for (const key of [
      "authorSource",
      "authorIdentityKind",
      "sourceAuthorId",
      "canonicalAuthorKey",
      "authorHandle",
      "authorAliases",
      "authorAliasHistory",
    ] as const) {
      if (canonical[key] !== undefined && JSON.stringify(metadata[key]) !== JSON.stringify(canonical[key])) {
        metadata[key] = canonical[key];
        changed = true;
      }
    }
    if (incoming.authorIdentityKind === "relay") {
      for (const key of ["sourceAuthorId", "canonicalAuthorKey", "authorAliases"] as const) {
        if (metadata[key] !== undefined) {
          delete metadata[key];
          changed = true;
        }
      }
    }
  }

  return { metadata, changed };
}
