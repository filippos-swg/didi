# didi

didi is an experiment in direct browser-to-browser file transfer.

> The shortest possible path between two machines.

## v0.1 — Direct

The first public version has one job: let one person send one file of up to **2 GB** directly to one other person.

- no account
- no cloud copy
- no transfer history
- sender stays online while the recipient receives
- file data travels browser-to-browser over WebRTC
- free

The 2 GB ceiling is a **product constraint for v0.1**, not an architectural assumption. The transfer engine should still use chunking and backpressure so larger transfers can be explored later.

## Definition of done

- [ ] Sender selects a real file (max 2 GB).
- [ ] didi creates a shareable session URL.
- [ ] Recipient opens the URL and connects to the sender.
- [ ] Recipient explicitly starts receiving.
- [ ] File bytes travel over a WebRTC DataChannel rather than through didi storage.
- [ ] Sender and recipient see connection state, progress and speed.
- [ ] Transfer uses bounded chunks/backpressure rather than loading the whole file into memory.
- [ ] Received file can be verified as intact.
- [ ] Sender-offline and interrupted-transfer states fail clearly.
- [ ] Core flow works in supported desktop browsers.

See `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, and `docs/ROADMAP.md`.

## Development

Requires Node 24 or later.

```bash
npm install
npm run dev          # http://localhost:8080 — web client and signalling in one process
npm run typecheck
npm test             # unit tests (node:test)
npx playwright install chromium
npm run test:e2e     # browser tests: builds, starts the server, drives two browsers
```

Production: `npm run build && npm start`. The server reads:

- `PORT` (default 8080)
- `DIDI_ICE_SERVERS`, a JSON array of `RTCIceServer` objects (default: public STUN)
- `DIDI_ALLOWED_ORIGINS`, comma-separated origins allowed to open the signalling socket besides the server's own
