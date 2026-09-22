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
