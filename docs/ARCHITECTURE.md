# didi — Architecture v0.1

## Goal

Transfer a single file of up to 2 GB directly between two browsers using WebRTC DataChannels. didi infrastructure coordinates the connection but does not store file contents.

## System shape

```text
Sender browser
     |
     | signalling metadata
     v
Signalling service
     ^
     | signalling metadata
     |
Recipient browser

Sender browser ===== WebRTC DataChannel ===== Recipient browser
```

## Web client

Initial implementation: Next.js, React and strict TypeScript.

Responsibilities:

- file selection and 2 GB product-limit validation
- session creation/joining
- WebRTC lifecycle
- chunking and backpressure
- transfer progress and speed
- integrity verification
- explicit connection/error states

## Signalling

A small signalling service exchanges session presence, SDP offers/answers and ICE candidates. Signalling must not accept file payloads.

## Connectivity

Use WebRTC ICE with STUN for direct connectivity. Some NAT/firewall combinations require TURN relay infrastructure. TURN must be treated as a real operational path, not ignored: relay bandwidth changes the economics and the product should not make false claims that every transfer is physically peer-to-peer when relay is required.

## Transfer protocol

The implementation must not read the entire file into memory.

Use bounded chunks and DataChannel backpressure. Track transferred byte counts and keep protocol state explicit. Within the 2 GB v0.1 limit, favour correctness and cross-browser reliability over premature optimisation.

## Receiving

Browser receiving is the harder side of very large transfers. The 2 GB v0.1 ceiling intentionally avoids making 100 GB browser transfers a launch requirement. The architecture should nevertheless avoid assumptions that make future streaming-to-disk support impossible.

## Security and privacy language

WebRTC transport is encrypted in transit. v0.1 must not overclaim anonymity, zero knowledge, or end-to-end privacy beyond what is actually implemented and tested.

Session identifiers must be high entropy. Signalling metadata should be ephemeral.

## Open technical questions

- supported browser matrix, especially Safari/iOS behaviour
- receive/save strategy near the 2 GB limit
- integrity-check strategy without excessive memory use
- TURN provider, relay detection and bandwidth cost
- reconnect/resume semantics after interruption
- behaviour when mobile browsers background a transfer
