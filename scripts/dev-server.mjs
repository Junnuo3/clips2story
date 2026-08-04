#!/usr/bin/env node
/**
 * Minimal static file server for local development -- no dependencies.
 * The site is plain static HTML/JS/JSON/media, so this is only here to
 * avoid the "file://" origin restrictions browsers apply to fetch() and ES
 * module imports (the original site's own load-error message already warns
 * about this: open index.html directly and data.json won't load).
 *
 * Run: npm run serve   (defaults to http://localhost:8080)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 8080);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".csv": "text/csv",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

const server = http.createServer((req, res) => {
  try {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    let filePath = path.normalize(path.join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(`Not found: ${urlPath}`);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-store",
    });
    const stream = fs.createReadStream(filePath);
    // Without this, a read hiccup on a large file (e.g. a git-LFS video over
    // a slow/network-mounted filesystem) throws an uncaught 'error' event and
    // kills the whole dev server process, not just this one request.
    stream.on("error", (err) => {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Stream error: ${err}`);
    });
    stream.pipe(res);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(String(err));
  }
});

server.listen(PORT, () => {
  console.log(`Serving ${ROOT} at http://localhost:${PORT}`);
  console.log("Note: most demo videos are Git LFS pointers until you run `git lfs pull` -- see README.");
});
