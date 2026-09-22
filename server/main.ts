// didi's only server process: serves the web client and the signalling WebSocket.
//   node server/main.ts         production, serves dist/ (run `npm run build` first)
//   node server/main.ts --dev   development, serves the client through Vite
//
// Environment:
//   PORT                   default 8080
//   DIDI_ICE_SERVERS       JSON array of RTCIceServer; default is public STUN
//   DIDI_ALLOWED_ORIGINS   comma-separated extra origins allowed to open /signal

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { parseIceServers, SIGNAL_PATH, type IceServer } from "../shared/signal-protocol.ts";
import { createSignalServer } from "./signal.ts";
import { createStaticHandler } from "./static.ts";

const DEFAULT_ICE_SERVERS: IceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

function readIceServers(value: string | undefined): IceServer[] {
  if (value === undefined || value.trim() === "") return DEFAULT_ICE_SERVERS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("DIDI_ICE_SERVERS is not valid JSON");
  }
  const servers = parseIceServers(parsed);
  if (servers === null) throw new Error("DIDI_ICE_SERVERS must be a JSON array of RTCIceServer objects");
  return servers;
}

function pathOf(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://localhost").pathname;
}

const dev = process.argv.includes("--dev");
const port = Number(process.env.PORT ?? 8080);
const allowedOrigins = (process.env.DIDI_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin !== "");

const server = createServer();
const signal = createSignalServer({ iceServers: readIceServers(process.env.DIDI_ICE_SERVERS), allowedOrigins });

server.on("upgrade", (request, socket, head) => {
  if (pathOf(request) === SIGNAL_PATH) signal.handleUpgrade(request, socket, head);
  else if (!dev) socket.destroy(); // in dev, Vite's HMR socket shares this server
});

let serveApp: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
if (dev) {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({ server: { middlewareMode: true, hmr: { server } }, appType: "spa" });
  serveApp = (request, response) => vite.middlewares(request, response);
} else {
  serveApp = createStaticHandler(fileURLToPath(new URL("../dist", import.meta.url)));
}

server.on("request", (request: IncomingMessage, response: ServerResponse) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
  if (pathOf(request) === "/healthz") {
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("ok");
    return;
  }
  Promise.resolve(serveApp(request, response)).catch((error: unknown) => {
    console.error("http: request failed", error);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});

server.listen(port, () => {
  console.log(`didi listening on http://localhost:${port}${dev ? " (dev)" : ""}`);
});

for (const name of ["SIGINT", "SIGTERM"] as const) {
  process.on(name, () => {
    void signal.close().finally(() => server.close(() => process.exit(0)));
  });
}
