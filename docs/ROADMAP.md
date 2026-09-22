# didi — Roadmap

## v0.1 — Direct

A real, public, deliberately constrained product.

**Scope:** one sender → one recipient → one file → maximum 2 GB.

Build order:

1. Project scaffold.
2. Session creation and join flow.
3. Signalling.
4. WebRTC DataChannel connection.
5. Chunked file transfer with backpressure.
6. Receive/save flow.
7. Integrity verification.
8. Progress, speed and connection state.
9. Clear sender-offline/interruption handling.
10. Cross-browser testing.
11. Progressive transfer tests: small files first, then hundreds of MB, then near the 2 GB ceiling.
12. Minimal polished public interface.

## v0.2 — Resilient handoff

Only after v0.1 proves useful.

Explore:

- encrypted temporary cloud fallback
- resumable transfers
- multiple recipients
- automatic routing between direct / TURN relay / cloud
- QR handoff
- persistence windows such as 24 hours or 7 days

This is the point where didi could combine FilePizza's direct architecture with the asynchronous convenience that made WeTransfer successful.

## Later

Potential areas, not commitments:

- LAN-aware routing
- much larger transfers
- native desktop integration
- professional large-asset workflows
- transfer history
- paid persistence
- team workflows
