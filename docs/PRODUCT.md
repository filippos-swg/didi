# didi — Product definition

## Working proposition

**The shortest possible path between two machines.**

The user chooses a file and gets a shareable address immediately. Unlike an upload-first service, didi's primary path is a live direct transfer from sender to recipient.

A useful early description:

> Send up to 2 GB directly to anyone. No upload. No account. No cloud copy.

This is working copy, not final branding.

## Why this exists

FilePizza demonstrates that direct browser-to-browser transfer is technically viable. WeTransfer demonstrates that the winning consumer experience is effortless handoff.

didi v0.1 deliberately tests the direct-transfer side first. It should not pretend to solve asynchronous handoff yet.

## v0.1 user flow

### Sender

1. Drop or choose one file, maximum 2 GB.
2. Receive a share URL immediately.
3. Copy the URL or show a QR code later if useful.
4. Keep the page open.
5. See when the recipient connects.
6. See transfer progress, speed and completion.

### Recipient

1. Open the share URL.
2. See filename and size.
3. Explicitly choose to receive.
4. See that the connection is direct.
5. See transfer progress.
6. Save the completed file.

## Product principles

- Direct first.
- The mechanism should feel immediate.
- Explain the live nature of the transfer instead of hiding it.
- No accounts for v0.1.
- No server-side file storage for v0.1.
- No artificial pricing/file-size tiers inside the v0.1 limit.
- Make connection state understandable.
- Build the transport before polishing the brand.
- Do not add features merely because incumbent file-transfer products have them.

## Explicitly out of scope for v0.1

Cloud persistence, asynchronous delivery, accounts, history, multiple recipients, folders, previews, comments, monetisation, native apps, collaboration features and a full identity system.

## Important constraint

If the sender closes the page, goes offline or loses the connection, a direct-only transfer can stop. That is intrinsic to v0.1 and should be communicated clearly rather than disguised.
