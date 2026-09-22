// Serves the built web client from dist/. Any path without a file extension
// falls back to index.html, so /r#<id> reaches the single-page app.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

export function createStaticHandler(root: string): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const rootWithSep = root.endsWith(sep) ? root : root + sep;

  async function fileAt(pathname: string): Promise<string | null> {
    const candidate = normalize(join(root, pathname));
    if (!candidate.startsWith(rootWithSep)) return null;
    try {
      return (await stat(candidate)).isFile() ? candidate : null;
    } catch {
      return null;
    }
  }

  return async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }

    let file = await fileAt(pathname);
    if (file === null && extname(pathname) === "") file = await fileAt("/index.html");
    if (file === null) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
      return;
    }

    const hashedAsset = file.startsWith(join(root, "assets") + sep);
    response.writeHead(200, {
      "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
      "Cache-Control": hashedAsset ? "public, max-age=31536000, immutable" : "no-cache",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(file).pipe(response);
  };
}
