# didi — Architecture v0.1

## Goal

Transfer a single file of up to 2 GB directly between two browsers using WebRTC DataChannels. didi infrastructure coordinates the connection but does not store file contents.

## System shape

```text
Sender browser
     |
     | signalling metadata (WebSocket /signal)
     v
didi Node service  — serves the web client, relays signalling, holds nothing on disk
     ^
     | signalling metadata (WebSocket /signal)
     |
Recipient browser

Sender browser ===== WebRTC DataChannel (file name, size, bytes) ===== Recipient browser
```

## Web client

Vite, React and strict TypeScript. Two screens: send (`/`) and receive (`/r#<session id>`).

Responsibilities:

- file selection and 2 GB product-limit validation
- session creation/joining
- WebRTC lifecycle
- chunking and backpressure
- transfer progress and speed
- integrity verification
- explicit connection/error states

The transfer engine (`src/transfer/`) and connection code (`src/net/`) are plain TypeScript with no React. They are driven by explicit state machines. React only renders the current state.

## Signalling

A small WebSocket service at `/signal`, in the same Node process that serves the web client. It exchanges session presence, SDP offers/answers and ICE candidates. It keeps all state in memory and writes nothing to disk.

Signalling must not accept file payloads. It enforces this in several ways:

- It accepts only a fixed set of message types.
- It caps every message at 16 KB.
- It rate-limits each socket.
- It forwards only connection-negotiation messages, and only between the two sockets paired in one session.

A session has one host (the sender) and at most one guest (the recipient) at a time.

## Connectivity

Use WebRTC ICE with STUN for direct connectivity. Some NAT/firewall combinations require TURN relay infrastructure. TURN must be treated as a real operational path, not ignored: relay bandwidth changes the economics and the product should not make false claims that every transfer is physically peer-to-peer when relay is required.

The ICE server list is delivered by the signalling server when a browser hosts or joins a session, never baked into the client. v0.1 lists STUN only. Adding TURN later means issuing short-lived credentials on the server. The client does not change.

Once connected, each side reads the selected ICE candidate pair from `RTCPeerConnection.getStats()` and labels the connection:

- **relayed** if either candidate is a TURN relay
- **direct** otherwise

A connection that cannot be established within the timeout fails with a clear "couldn't connect directly" error. v0.1 has no relay to fall back on.

## Transfer protocol

The implementation must not read the entire file into memory.

Use bounded chunks and DataChannel backpressure. Track transferred byte counts and keep protocol state explicit. Within the 2 GB v0.1 limit, favour correctness and cross-browser reliability over premature optimisation.

Concretely:

- **Channel:** one reliable, ordered DataChannel. Control messages are JSON strings; file data is binary.
- **Reading:** the sender reads the file one 1 MiB block at a time (`Blob.slice`) and sends it in chunks of at most 64 KiB, capped by the negotiated SCTP maximum message size.
- **Local backpressure:** the sender pauses while the channel's `bufferedAmount` is above a high-water mark, and resumes on `bufferedamountlow`. It is event-driven, so background-tab timer throttling does not stall it.
- **End-to-end backpressure:** the recipient acknowledges bytes it has committed to its sink, and the sender keeps at most a fixed window unacknowledged. A DataChannel receiver cannot pause delivery, so without this a slow disk on the recipient's side would grow memory without bound. The acknowledgements also give the sender true delivered progress.
- **Integrity:** SHA-256 of each block is sent after the block and checked by the recipient before committing it. The root hash (SHA-256 over all block hashes) is confirmed by the recipient at the end.

## Receiving

Browser receiving is the harder side of very large transfers. The 2 GB v0.1 ceiling intentionally avoids making 100 GB browser transfers a launch requirement. The architecture should nevertheless avoid assumptions that make future streaming-to-disk support impossible.

The receiver writes verified blocks to a sink:

- **Disk sink:** Chrome and Edge, via the File System Access API. The recipient picks the save location when they click Receive, and blocks stream straight to disk.
- **Memory sink:** Firefox and Safari. Blocks are assembled in memory, and the recipient saves the file at the end.

A disk-backed sink using the Origin Private File System is the planned fallback if the memory sink fails near 2 GB.

## Security and privacy language

WebRTC transport is encrypted in transit. v0.1 must not overclaim anonymity, zero knowledge, or end-to-end privacy beyond what is actually implemented and tested.

Session identifiers must be high entropy. Signalling metadata should be ephemeral.

What didi's server sees:

- the session ID
- whether a sender and a recipient are present
- SDP and ICE candidates, which contain IP addresses
- the connecting IP addresses

It never sees the file, its name or its size.

v0.1 does not defend against a malicious signalling server substituting itself into the connection. Verifying the DTLS fingerprints against a secret in the URL fragment is a possible later hardening, and must not be claimed until it exists.

## Repository layout

```text
server/   Node service: HTTP (web client), WebSocket signalling
shared/   code used by both server and browser (signalling protocol, session IDs)
src/      web client: send/receive screens, net/ (signalling, WebRTC), transfer/ (protocol, engine)
tests/    unit/ (node:test), e2e/ (Playwright, two browser contexts)
```

## Open technical questions

- Safari/iOS behaviour in practice (desktop Safari is in the v0.1 matrix; mobile is not)
- whether the memory sink holds up near 2 GB in Firefox and Safari
- TURN provider and bandwidth cost
- behaviour when mobile browsers background a transfer
