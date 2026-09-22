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
- **direct** otherwise, and **same network** when both addresses are local. A remote address first seen in a connectivity check (peer-reflexive) counts as local if it is a private address: on a local network it often arrives before its candidate message does.

A connection that cannot be established within 20 seconds fails with a clear "couldn't connect directly" error. v0.1 has no relay to fall back on.

Noticing that the other side has gone:

- **Page closed or navigated away:** each page closes its connection on `pagehide`. When the connection is idle, the other side sees the DataChannel close within milliseconds. Mid-transfer, the goodbye does not reliably get out, and the crash path below applies.
- **Crash or lost network:** nothing is sent. Once the signalling server reports the other page's socket closed *and* ICE reports `disconnected` (about 5 seconds in Chrome), the connection is treated as lost. Neither signal on its own is enough: signalling can drop while the direct connection lives, and `disconnected` can recover.
- **Fallback:** ICE `failed`, about 15 seconds in Chrome.

When a connection never opens, both sides show the likely cause and a collapsible connection report (`src/net/connection-report.ts`). The report holds counts only, never addresses:

- which kinds of address this browser found: on its own network, public, relay
- which kinds arrived from the other browser
- how many address pairs were tried, and how many worked
- how the attempt ended
- whether both browsers share a public address

The shared-address check tells "same network, but local discovery (mDNS) failed" apart from "a firewall blocks direct connections, only TURN would help". The addresses used for it are compared in memory and never recorded.

## Transfer protocol

The implementation must not read the entire file into memory.

Use bounded chunks and DataChannel backpressure. Track transferred byte counts and keep protocol state explicit. Within the 2 GB v0.1 limit, favour correctness and cross-browser reliability over premature optimisation.

Concretely:

- **Channel:** one reliable, ordered DataChannel. Control messages are JSON strings; file data is binary.
- **Reading:** the sender reads the file one 1 MiB block at a time (`Blob.slice`) and sends it in chunks of at most 64 KiB, capped by the negotiated SCTP maximum message size.
- **Local backpressure:** the sender pauses while the channel's `bufferedAmount` is above a high-water mark, and resumes on `bufferedamountlow`. It is event-driven, so background-tab timer throttling does not stall it.
- **End-to-end backpressure:** the recipient acknowledges bytes it has committed to its sink, and the sender keeps at most a fixed window unacknowledged. A DataChannel receiver cannot pause delivery, so without this a slow disk on the recipient's side would grow memory without bound. The acknowledgements also give the sender true delivered progress.
- **Integrity:** SHA-256 of each block is sent after the block and checked by the recipient before committing it. The root hash (SHA-256 over all block hashes) is confirmed by the recipient at the end.
- **Ending:** either side can abort with a reason (`cancelled`, `file-unreadable`, `integrity`, `write-failed`, `protocol`). After an abort, or after `verified`, the side that is finishing closes the DataChannel gracefully, and only then the connection. Closing the connection outright discards whatever is still queued, including the message explaining why.
- **One reporter:** while a transfer is running, the transfer engine alone reports how it ended. A lost connection is handled after the messages that already arrived, so "the sender stopped sharing" is not overwritten by "the connection dropped".

- **Stalls:** once a second, each side checks whether anything has moved. The sender checks acknowledgements and its outgoing queue; the recipient checks received bytes. After 10 seconds without movement, both sides say so, and the message clears when data moves again. Nothing counts as stalled once every byte has arrived and the file is being saved. A stall is only shown, never acted on: the transfer fails when the connection itself is lost.

The message sequence and limits live in `src/transfer/protocol.ts`:

| Constant | Value |
|---|---|
| block (hash, write, acknowledge) | 1 MiB |
| chunk | 64 KiB, or the negotiated SCTP maximum if smaller |
| pause sending above `bufferedAmount` | 8 MiB (Chrome fails `send()` past 16 MiB) |
| resume below | 2 MiB |
| unacknowledged window | 16 MiB |

Measured with two tabs of one Chrome on one machine (100 MB):

- 15 MB/s on average, about 27 MB/s once running, after a slow first two seconds.
- Instrumentation shows the time is spent waiting for the DataChannel to drain. Reading, hashing and the acknowledgement window never limit it.
- Changing the buffer thresholds (1–16 MiB) or the chunk size (64 or 256 KiB) made no difference.
- Throughput between two machines on real networks is still to be measured.

## Failure handling

Every case below has an automated browser test (`tests/e2e/`), except where noted.

| Situation | Sender sees | Recipient sees |
|---|---|---|
| Link unknown, ended or incomplete | — | "This link isn't active" / "This link is incomplete" |
| Someone else is already receiving | — | "Someone else is receiving this file right now" |
| No direct path between the browsers | "Couldn't connect directly to the recipient", plus a connection report | "Couldn't connect directly to the sender", plus a connection report |
| didi's server unreachable while creating the link | "Can't reach the didi server. Retrying…" until it can | — |
| Sender loses the server while waiting | "Lost contact with the didi server. Reconnecting…"; the same link works again once reconnected | "The sender's page isn't connected right now" (Try again) |
| Sender loses the server mid-transfer | nothing: the transfer carries on | nothing |
| Recipient can't reach the server | — | "Couldn't reach the didi server" (Try again) |
| Sender stops sharing (before or during) | back to choosing a file | "The sender stopped sharing this file" |
| Recipient stops receiving | "The recipient stopped the transfer"; the link still works | "You stopped receiving. The partial file was discarded" |
| Sender page closed or crashed | — | "The connection to the sender dropped", within about 5 s |
| Recipient page closed or crashed | "The connection to the recipient dropped"; the link still works | — |
| Nothing moves for 10 s | "Nothing delivered for N s…" | "Nothing received for N s…" |
| Sender's file changed or moved after choosing | "The file couldn't be read… Choose it again" | "The sender's copy of the file couldn't be read" |
| Recipient's disk full or refuses the write | "The recipient's browser couldn't save the file"; the link still works | "Your browser couldn't save the file. Your disk may be full" |
| A block or the whole file doesn't match | "The recipient's copy didn't match yours" | "The received data didn't match the sender's copy" (unit-tested only) |
| Leaving the page mid-transfer | the browser asks first | the browser asks first |
| Network lost without the page closing | detected when ICE gives up (about 15 s in Chrome), shown as a stall before that (not automated: it needs a real network to drop) | same |

## Field tests

Real transfers between separate machines, as opposed to the automated tests.

| Date | Sender | Recipient | Network | File | Result |
|---|---|---|---|---|---|
| 2026-09-22 | Chrome, macOS | Firefox, another machine | same Wi-Fi | 8.53 MB video | Direct, same network; verified intact. An earlier attempt on the same network failed to connect, cause unknown (before connection reports existed). |
| 2026-09-22 | Chrome | a Chromium browser | not recorded | not recorded | The native save dialog opened on Receive and saving to disk worked (reported by hand; details not recorded). |

Still to test: two separate internet connections, Safari, Edge, and files near 2 GB.

## Receiving

Browser receiving is the harder side of very large transfers. The 2 GB v0.1 ceiling intentionally avoids making 100 GB browser transfers a launch requirement. The architecture should nevertheless avoid assumptions that make future streaming-to-disk support impossible.

The receiver writes verified blocks to a sink:

- **Disk sink:** Chrome and Edge, via the File System Access API. The recipient picks the save location when they click Receive, and blocks stream straight to disk.
- **Memory sink:** Firefox and Safari. Blocks are assembled in memory, and the recipient saves the file at the end.

A disk-backed sink using the Origin Private File System is the planned fallback if the memory sink fails near 2 GB.

Status: Chrome and Edge use the disk sink. A native save dialog opens when the recipient clicks Receive, so it has to be opened straight from that click. Other browsers use the memory sink.

Details:

- **Closing the dialog:** returns to the Receive button, and nothing is sent.
- **Dialog or file refused:** if the browser refuses the dialog or the file, the transfer falls back to the memory sink.
- **Nothing half-written:** Chrome writes to a temporary file and only puts it in place when the file is closed. An aborted transfer leaves nothing behind.
- **Testing:** the automated tests replace the native dialog with a stand-in that writes into the page's private storage (OPFS), then read the file back and compare its SHA-256 with the original.

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
- throughput between two machines on real networks, and whether the slow start seen on one machine appears there
- TURN provider and bandwidth cost
- behaviour when mobile browsers background a transfer
