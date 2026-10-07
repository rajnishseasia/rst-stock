# X Signal Image Link Design

## Goal

Improve the X Signals sidebar by removing TweetShift's leading `Tweeted`
label and exposing the first image attached to each relayed Discord post.

## Scope

Update the Discord signal ingestion path and the X Signals sidebar only.
No database schema change is required because image URLs can be stored in the
existing signal `metadata` JSON.

## Ingestion

The Discord message model will include:

- File attachments and their URLs.
- Embed `image` and `thumbnail` URLs.

For each message, the worker will select one image URL in this order:

1. The first image file attachment.
2. The first embed image.
3. The first embed thumbnail.

Attachments that are clearly not images will be skipped. The selected URL will
be stored as `imageUrl` in signal metadata.

The worker will also remove one leading, case-insensitive `Tweeted` label from
the normalized signal text. It will not remove occurrences elsewhere in the
post.

When the worker encounters an existing signal during its normal backfill, it
will refresh the content and metadata so recently available posts can gain the
cleaned text and first image without creating duplicate signals.

## Sidebar

The sidebar will defensively remove a leading `Tweeted` label when displaying
existing rows that have not yet been refreshed by the worker.

When metadata contains an `imageUrl`, the signal actions will include:

- `👀 View more` or `🙈 View less` for overflowing text.
- `🔗 View Original` when an X URL exists.
- `🖼️ View image` when an image URL exists.

The image link opens the first image in a new tab and stops card click
propagation. The image itself will not be rendered inline in the sidebar.

## Error Handling

Malformed metadata will continue to fall back safely to an unknown author and
no image link. Messages without an image remain unchanged. Invalid or
non-image attachments will not produce a link.

## Testing

Worker tests will cover:

- Removing only the leading `Tweeted` label.
- Selecting the first valid image attachment.
- Falling back to embed image and thumbnail URLs.
- Ignoring non-image attachments.

Sidebar tests will cover:

- Defensive cleanup of existing `Tweeted` content.
- Extraction of `imageUrl` from object and string metadata.
- Emoji labels for all three view actions.

Type checking and the focused Bun tests will verify the completed change.
