# didi — Decisions log

## 2026-09 — Project start

### Working name

**didi** is the working name. Do not spend v0.1 time on naming or a full brand system.

### Core idea

Build a direct-first file-transfer product rather than a visual clone of WeTransfer.

### v0.1 limit

Maximum transfer size is **2 GB**.

Reason: 1–2 GB is enough to make the first version genuinely useful while avoiding premature work on extreme browser filesystem/memory edge cases. The limit is a product decision; chunking/backpressure remain architectural requirements.

### v0.1 topology

One file, one sender, one recipient. Sender and recipient must be online simultaneously.

### Storage

No cloud copy in v0.1.

### Accounts

No accounts in v0.1.

### Technical direction

Use WebRTC DataChannels for file data and a minimal signalling service for connection negotiation. STUN/TURN requirements must be handled honestly.

### Product sequencing

First prove reliable direct transfer. Then design the experience around it. Cloud fallback belongs to a later version, not the first proof.

### Reference products

FilePizza is an important technical precedent. WeTransfer is an important product precedent. didi should learn from both without becoming a clone of either.

## 2026-09-22 — v0.1 implementation decisions

Agreed before implementation started.

### Web client: Vite + React, not Next.js

This supersedes the earlier "Next.js, React and strict TypeScript" direction. v0.1 is two browser-only screens and uses no server rendering. Next.js could only host the signalling WebSocket through a custom server. Vite + React + strict TypeScript does everything v0.1 needs with less machinery.

### Hosting: one Node service

One Node process serves the built web client and the signalling WebSocket (`/signal`). One deploy, one origin, one command for local development. Static hosts such as Netlify cannot hold WebSockets, so the target is an always-on Node host (Fly.io or Railway, chosen at deploy time). Signalling state is held in memory only.

### Supported browsers and receiving

Supported for v0.1: the latest desktop Chrome, Edge, Firefox and Safari. Every one of them can send.

- Chrome and Edge receive by streaming straight into a file the recipient chooses (File System Access API).
- Firefox and Safari have no such API. They assemble the file in memory and save it at the end.

All four are tested up to the 2 GB ceiling. A disk-backed fallback for Firefox and Safari (Origin Private File System) is added only if they fail near it.

### File metadata stays peer-to-peer

The file's name, size and type travel only over the DataChannel. The signalling server sees the session ID, presence, and connection negotiation (SDP and ICE candidates, which contain IP addresses). It never sees the file or its name.

### Session lifecycle

One link, one recipient at a time, one verified delivery.

- The link ends when a delivery is verified, or when the sender closes the page.
- A failed or interrupted transfer can be retried from the start while the sender's page stays open. This is a restart, not a resume; resume belongs to v0.2.
- A second visitor who arrives while a recipient is connected is told the link is in use.

### Session IDs

The sender's browser generates a 256-bit host key. The session ID is the first 128 bits of the key's SHA-256 hash, base64url-encoded (22 characters).

The server proves host ownership by re-hashing the key. It stores no secrets, and a sender can reclaim its session after a signalling reconnect or a server restart.

Share links take the form `/r#<id>`. The fragment keeps the ID out of HTTP logs and `Referer` headers.

### ICE configuration comes from the server

The signalling server gives each browser its ICE server list when it hosts or joins a session. v0.1 lists STUN servers only. TURN can be added later by issuing short-lived credentials on the server, without changing the client.

Without TURN, some network pairs cannot connect at all. They fail with a clear message, never a silently relayed transfer.

The interface labels each connection from its selected ICE candidate pair: direct, or relayed.

### The 2 GB limit is 2 GiB

2 GB means 2 GiB (2,147,483,648 bytes). Windows shows that size as "2 GB", so a file Windows shows as 1.9 GB is never refused as too large.

### Integrity

Files are split into 1 MiB blocks. Each block is hashed with SHA-256 (WebCrypto), and the recipient checks each block before committing it. At the end, both sides confirm a root hash computed over all the block hashes. No hashing dependency.

The root is not a whole-file `shasum -a 256` value. That would need an incremental SHA-256 library, and is deferred.

### Dependencies and tooling

- Runtime dependencies: `react`, `react-dom`, `ws`.
- Development dependencies: `typescript`, `vite`, type definitions, `@playwright/test`.
- Unit tests use Node's built-in `node:test`.
- Node 24 runs the server's TypeScript directly (type stripping), so the server has no build step.
- Package manager: npm.
