#!/usr/bin/env node
/**
 * serve.mjs — zero-dependency static server for the built artifact in
 * outputs/dist. Used both as a CLI and (via createStaticServer) as the HTTP
 * surface that verify.mjs asserts against.
 *
 * Behaviour that verification depends on:
 *   - GET/HEAD only; anything else is 405 with an Allow header
 *   - correct Content-Type per extension
 *   - strong ETag + 304 on If-None-Match
 *   - no directory listing, no directory escape (raw or percent-encoded)
 *   - /healthz returns JSON {ok:true,...}
 *   - 404 (never 200/500) for anything absent
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'outputs', 'dist');

export const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

export function contentTypeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  if (res.req?.method === 'HEAD' || body === undefined) res.end();
  else res.end(body);
}

function sendText(res, status, text, extra = {}) {
  const body = Buffer.from(text, 'utf8');
  send(res, status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length, ...extra }, body);
}

export function createStaticServer({ root = DEFAULT_ROOT } = {}) {
  const rootDir = path.resolve(root);

  return http.createServer((req, res) => {
    try {
      handle(req, res, rootDir);
    } catch {
      sendText(res, 500, 'internal error\n');
    }
  });
}

function handle(req, res, rootDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'method not allowed\n', { allow: 'GET, HEAD' });
    return;
  }

  let pathname;
  try {
    pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    sendText(res, 400, 'bad request\n');
    return;
  }

  if (pathname === '/healthz') {
    const body = Buffer.from(JSON.stringify({ ok: true, root: path.basename(rootDir) }) + '\n', 'utf8');
    send(res, 200, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length }, body);
    return;
  }

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendText(res, 400, 'bad request\n');
    return;
  }

  if (decoded.includes('\0')) {
    sendText(res, 400, 'bad request\n');
    return;
  }

  let rel = decoded.replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  if (rel.endsWith('/')) rel += 'index.html';

  // Reject any traversal segment before touching the filesystem.
  if (rel.split('/').includes('..')) {
    sendText(res, 404, 'not found\n');
    return;
  }

  const abs = path.resolve(rootDir, ...rel.split('/'));
  if (abs !== rootDir && !abs.startsWith(rootDir + path.sep)) {
    sendText(res, 404, 'not found\n');
    return;
  }

  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    sendText(res, 404, 'not found\n');
    return;
  }

  if (stat.isDirectory()) {
    sendText(res, 404, 'not found\n');
    return;
  }

  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    sendText(res, 404, 'not found\n');
    return;
  }

  const etag = `"${crypto.createHash('sha1').update(buf).digest('hex')}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': 'no-cache' });
    res.end();
    return;
  }

  send(
    res,
    200,
    {
      'content-type': contentTypeFor(abs),
      'content-length': buf.length,
      etag,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    },
    buf,
  );
}

/** Resolve once the server is listening; returns the bound port. */
export function listen(server, { port = 0, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
}

function parseArgs(argv) {
  const out = { root: DEFAULT_ROOT, port: 0, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') out.root = path.resolve(argv[++i]);
    else if (arg === '--port') out.port = Number(argv[++i]);
    else if (arg === '--host') out.host = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.root)) {
    console.error(`serve failed: root does not exist: ${args.root} (run "node build.mjs" first)`);
    process.exit(1);
  }
  const server = createStaticServer({ root: args.root });
  const port = await listen(server, args);
  console.log(`serving ${args.root} on http://${args.host}:${port}`);
  console.log('press Ctrl+C to stop');
}
