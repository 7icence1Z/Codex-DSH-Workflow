#!/usr/bin/env node
/**
 * verify.mjs — the verification gate for the build produced by build.mjs.
 *
 * Every assertion below is mechanical: it re-derives the fact from bytes on
 * disk or from a live HTTP response instead of trusting the build report.
 * Exit code is 0 only when all checks pass.
 *
 *   node verify.mjs          # canonical build + full assertion suite
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import {
  ROOT,
  DEFAULT_OUT_DIR,
  DEFAULT_REPORT,
  MANIFEST_NAME,
  HTML_SOURCE,
  ENTRY_SOURCE,
  GAP_RULES,
  runBuild,
  parseHtmlRefs,
  classifyRef,
  sha256,
} from './build.mjs';
import { createStaticServer, listen } from './serve.mjs';

const DIST = DEFAULT_OUT_DIR;
const REPORT = DEFAULT_REPORT;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-'));

/** Byte sequences that must never reach the published artifact. */
const SECRET_MARKERS = ['dsh-auth-', 'v1.eyJ2ZXJzaW9uIjox', 'Netscape HTTP Cookie File'];

const results = [];

async function step(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: typeof detail === 'string' ? detail : '' });
  } catch (error) {
    results.push({ name, ok: false, detail: String(error.message ?? error).split('\n')[0] });
  }
}

function read(rel) {
  return fs.readFileSync(path.join(DIST, ...rel.split('/')));
}

function exists(rel) {
  return fs.existsSync(path.join(DIST, ...rel.split('/')));
}

/** Recursively list files as sorted POSIX-relative paths. */
function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs, base));
    else out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out.sort();
}

/** Parse-check an ES module without spawning a shell pipeline. */
function esmParseCheck(absFile) {
  const tag = crypto.randomUUID();
  const target = path.join(TMP, `parse-${tag}.mjs`);
  const logPath = path.join(TMP, `parse-${tag}.log`);
  fs.copyFileSync(absFile, target);
  const fd = fs.openSync(logPath, 'w');
  let proc;
  try {
    proc = spawnSync(process.execPath, ['--check', target], { stdio: ['ignore', fd, fd] });
  } finally {
    fs.closeSync(fd);
  }
  if (proc.error) throw new Error(`parse check could not run: ${proc.error.code ?? proc.error.message}`);
  if (proc.status !== 0) {
    const log = fs.readFileSync(logPath, 'utf8').trim().split('\n').slice(0, 2).join(' | ');
    throw new Error(`not valid ES module (exit ${proc.status}): ${log}`);
  }
}

async function get(base, target, init) {
  const res = await fetch(base + target, init);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buf };
}

/** Raw request that bypasses URL normalisation, for traversal testing. */
function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function rawRequest(port, rawPath, method) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------

async function main() {
  let report;
  let server;
  let port;

  // --- build --------------------------------------------------------------
  await step('build.canonical', () => {
    report = runBuild({ outDir: DIST, reportPath: REPORT, log: () => {} });
    return `buildId=${report.buildId.slice(0, 12)} outputs=${report.summary.outputs} gaps=${report.summary.gaps}`;
  });

  if (!report) {
    finish();
    return;
  }

  await step('build.sources-unmodified', () => {
    for (const source of report.sources) {
      const abs = path.join(ROOT, ...source.path.split('/'));
      const buf = fs.readFileSync(abs);
      assert.equal(sha256(buf), source.sha256, `${source.path} changed since build`);
      assert.equal(buf.length, source.bytes, `${source.path} length changed since build`);
    }
    return `${report.sources.length} source files match the report`;
  });

  await step('dist.html.byte-identical', () => {
    const built = read('index.html');
    const source = fs.readFileSync(HTML_SOURCE);
    assert.deepEqual(built, source, 'dist/index.html differs from work/index.html');
    return `${built.length} bytes, unmodified`;
  });

  await step('dist.entry.byte-identical', () => {
    const target = report.entry.target;
    assert.ok(exists(target), `entry chunk missing from dist: ${target}`);
    const built = read(target);
    const source = fs.readFileSync(ENTRY_SOURCE);
    assert.deepEqual(built, source, `${target} differs from work/index.js`);
    return `${target} = ${built.length} bytes, unmodified`;
  });

  await step('dist.outputs.hash-verified', () => {
    for (const output of report.outputs) {
      assert.ok(exists(output.path), `declared output missing: ${output.path}`);
      const buf = read(output.path);
      assert.equal(buf.length, output.bytes, `size mismatch for ${output.path}`);
      assert.equal(sha256(buf), output.sha256, `sha256 mismatch for ${output.path}`);
      assert.ok(['copied', 'generated'].includes(output.origin), `bad origin for ${output.path}`);
    }
    const allowed = new Set([...report.outputs.map((o) => o.path), MANIFEST_NAME]);
    const extra = walk(DIST).filter((rel) => !allowed.has(rel));
    assert.deepEqual(extra, [], `unexpected files in dist: ${extra.join(', ')}`);
    return `${report.outputs.length} outputs re-hashed, 0 strays`;
  });

  await step('dist.esm.parse', () => {
    const scripts = walk(DIST).filter((rel) => rel.endsWith('.js') || rel.endsWith('.mjs'));
    assert.ok(scripts.length > 0, 'no JavaScript in dist to parse-check');
    for (const rel of scripts) esmParseCheck(path.join(DIST, ...rel.split('/')));
    return `${scripts.length} module(s) parsed as ESM by the runtime`;
  });

  await step('dist.refs.all-accounted', () => {
    const html = read('index.html').toString('utf8');
    const refs = parseHtmlRefs(html).map(classifyRef);
    const declared = new Set(report.gaps.map((g) => g.path));
    let built = 0;
    let gaps = 0;
    let external = 0;
    for (const ref of refs) {
      if (ref.status === 'external') {
        external += 1;
        continue;
      }
      assert.notEqual(ref.status, 'unsafe', `unsafe reference in built html: ${ref.raw}`);
      if (exists(ref.path)) {
        built += 1;
        continue;
      }
      assert.ok(declared.has(ref.path), `undeclared missing reference: ${ref.path}`);
      gaps += 1;
    }
    for (const ref of report.references) {
      if (ref.status === 'built') assert.ok(exists(ref.path), `report claims built but absent: ${ref.path}`);
      if (ref.status === 'gap') {
        assert.ok(
          GAP_RULES.some((rule) => rule.test.test(ref.path)) ||
            report.gaps.some((g) => g.path === ref.path),
          `gap without a matching rule: ${ref.path}`,
        );
      }
    }
    return `${built} built / ${gaps} declared gaps / ${external} external`;
  });

  await step('dist.boot-contract', () => {
    const html = read('index.html').toString('utf8');
    for (const marker of ['id="root"', '__ModuleLoader__', '__DSH_BOOT_READY__', '<base href="/">']) {
      assert.ok(html.includes(marker), `boot contract marker missing: ${marker}`);
    }
    const entry = parseHtmlRefs(html)
      .map(classifyRef)
      .find((ref) => ref.kind === 'module-script' && ref.status === 'pending');
    assert.ok(entry, 'no module entry script in the built shell');
    assert.equal(entry.path, report.entry.target, 'entry target disagrees with the build report');
    assert.ok(exists(entry.path), `entry script not servable: ${entry.path}`);
    return `#root + module loader + entry ${entry.path}`;
  });

  await step('dist.manifest.fetchable', () => {
    const manifest = JSON.parse(read(MANIFEST_NAME).toString('utf8'));
    assert.equal(manifest.buildId, report.buildId, 'manifest buildId mismatch');
    assert.equal(manifest.entry, report.entry.target, 'manifest entry mismatch');
    const expected = report.outputs.map((o) => ({ path: o.path, bytes: o.bytes, sha256: o.sha256 }));
    assert.deepEqual(manifest.files, expected, 'manifest file list mismatch');
    return `${manifest.files.length} entries, buildId ${manifest.buildId.slice(0, 12)}`;
  });

  await step('dist.no-secret-material', () => {
    const offenders = [];
    for (const rel of walk(DIST)) {
      if (rel.endsWith('cookies.txt')) offenders.push(rel);
      const text = read(rel).toString('latin1');
      for (const marker of SECRET_MARKERS) {
        if (text.includes(marker)) offenders.push(`${rel}:${marker}`);
      }
    }
    assert.deepEqual(offenders, [], `credential material leaked into dist: ${offenders.join(', ')}`);
    return `${walk(DIST).length} files scanned for ${SECRET_MARKERS.length} markers`;
  });

  await step('build.reproducible', () => {
    const second = runBuild({
      outDir: path.join(TMP, 'dist'),
      reportPath: path.join(TMP, 'build-report.json'),
      log: () => {},
    });
    assert.equal(second.buildId, report.buildId, 'rebuild produced a different buildId');
    assert.deepEqual(second, report, 'rebuild produced a different report');
    const first = new Map(walk(DIST).map((rel) => [rel, sha256(read(rel))]));
    const again = new Map(
      walk(path.join(TMP, 'dist')).map((rel) => [
        rel,
        sha256(fs.readFileSync(path.join(TMP, 'dist', ...rel.split('/')))),
      ]),
    );
    for (const [rel, hash] of first) {
      assert.equal(again.get(rel), hash, `rebuild differs at ${rel}`);
    }
    assert.equal(again.size, first.size, 'rebuild produced a different file set');
    return `${first.size} files byte-identical across two independent builds`;
  });

  await step('build.boot-readiness-consistent', () => {
    const blockers = report.gaps.filter((g) => g.severity === 'blocks-boot').map((g) => g.path);
    assert.equal(report.bootReadiness.ready, blockers.length === 0, 'ready flag disagrees with blockers');
    assert.deepEqual(report.bootReadiness.blockers, blockers, 'blocker list disagrees with gaps');
    for (const edge of report.moduleGraph.static) {
      if (edge.status === 'gap') {
        assert.ok(
          blockers.includes(edge.target),
          `static edge ${edge.target} is a gap but not a boot blocker`,
        );
      }
    }
    return report.bootReadiness.ready
      ? 'boot ready, no blocking gaps'
      : `${blockers.length} boot blocker(s): ${blockers.join(', ')}`;
  });

  // --- HTTP surface -------------------------------------------------------
  const repo = report;
  server = createStaticServer({ root: DIST });
  port = await listen(server, { port: 0 });
  const base = `http://127.0.0.1:${port}`;

  await step('http.index', async () => {
    const res = await get(base, '/');
    assert.equal(res.status, 200, `GET / returned ${res.status}`);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html/, 'wrong content-type for /');
    assert.deepEqual(res.buf, read('index.html'), 'served bytes differ from dist/index.html');
    assert.ok(res.headers.get('etag'), 'no ETag on /');
    return `200 text/html, ${res.buf.length} bytes, ETag present`;
  });

  const entryPath = `/${repo.entry.target}`;
  await step('http.entry', async () => {
    const res = await get(base, entryPath);
    assert.equal(res.status, 200, `GET ${entryPath} returned ${res.status}`);
    assert.match(res.headers.get('content-type') ?? '', /^text\/javascript/, 'wrong content-type for entry');
    const expected = repo.outputs.find((o) => o.path === repo.entry.target);
    assert.equal(sha256(res.buf), expected.sha256, 'served entry hash differs from build output');
    return `200 ${res.headers.get('content-type')}, sha256 verified`;
  });

  await step('http.manifest', async () => {
    const res = await get(base, '/manifest.webmanifest');
    assert.equal(res.status, 200, `GET /manifest.webmanifest returned ${res.status}`);
    assert.match(res.headers.get('content-type') ?? '', /^application\/manifest\+json/, 'wrong content-type');
    const parsed = JSON.parse(res.buf.toString('utf8'));
    assert.equal(typeof parsed.name, 'string', 'manifest has no name');
    assert.equal(parsed.start_url, '/', 'manifest start_url is not /');
    return `200 application/manifest+json ("${parsed.name}")`;
  });

  await step('http.favicon', async () => {
    const res = await get(base, '/favicon.svg');
    assert.equal(res.status, 200, `GET /favicon.svg returned ${res.status}`);
    assert.equal(res.headers.get('content-type'), 'image/svg+xml', 'wrong content-type for favicon');
    assert.ok(res.buf.toString('utf8').startsWith('<svg'), 'favicon is not an SVG document');
    return '200 image/svg+xml, well-formed root element';
  });

  await step('http.healthz', async () => {
    const res = await get(base, '/healthz');
    assert.equal(res.status, 200, `GET /healthz returned ${res.status}`);
    const parsed = JSON.parse(res.buf.toString('utf8'));
    assert.equal(parsed.ok, true, 'healthz ok flag is not true');
    return '200 application/json {ok:true}';
  });

  await step('http.conditional-request', async () => {
    const first = await get(base, '/');
    const etag = first.headers.get('etag');
    const second = await get(base, '/', { headers: { 'if-none-match': etag } });
    assert.equal(second.status, 304, `conditional GET returned ${second.status}, expected 304`);
    assert.equal(second.buf.length, 0, '304 response carried a body');
    return 'ETag round-trip returns 304 with empty body';
  });

  await step('http.declared-gaps-404', async () => {
    const targets = ['/assets/vendor-CCJJTK99.js', '/assets/index-DPX2bQLO.css', '/assets/vendor-BNsW4eBh.css'];
    for (const target of targets) {
      const res = await get(base, target);
      assert.equal(res.status, 404, `${target} returned ${res.status}, expected 404`);
      const rel = target.slice(1);
      assert.ok(
        repo.gaps.some((g) => g.path === rel),
        `${target} 404s but is not declared as a gap in the report`,
      );
    }
    return `${targets.length} declared gaps answered 404 (not silently 200)`;
  });

  await step('http.plugin-concat-404', async () => {
    const res = await rawGet(port, '/plugins/??@deepseek-ai/dsh-api-gateway/client.js');
    assert.equal(res.status, 404, `plugin concat request returned ${res.status}, expected 404`);
    assert.ok(
      repo.gaps.some((g) => g.path.startsWith('plugins/')),
      'plugin concat request 404s but plugins/* is not declared as a gap',
    );
    return 'unsupported plugin concat request answered 404 and declared';
  });

  await step('http.method-guard', async () => {
    const res = await rawRequest(port, '/', 'POST');
    assert.equal(res.status, 405, `POST / returned ${res.status}, expected 405`);
    assert.match(res.headers.allow ?? '', /GET/, 'no Allow header on 405');
    return '405 with Allow: GET, HEAD';
  });

  await step('http.traversal-blocked', async () => {
    const probes = [
      '/../work/cookies.txt',
      '/..%2fwork%2fcookies.txt',
      '/%2e%2e/work/cookies.txt',
      '/assets/..%2f..%2fwork%2fcookies.txt',
      '/%2e%2e%2f%2e%2e%2fwork%2findex.js',
    ];
    for (const probe of probes) {
      const res = await rawGet(port, probe);
      assert.ok([400, 403, 404].includes(res.status), `${probe} returned ${res.status}, expected 4xx`);
      const body = res.body.toString('latin1');
      for (const marker of SECRET_MARKERS) {
        assert.ok(!body.includes(marker), `${probe} leaked ${marker}`);
      }
    }
    return `${probes.length} raw traversal probes rejected, no credential bytes served`;
  });

  await step('http.no-directory-listing', async () => {
    for (const target of ['/assets/', '/assets']) {
      const res = await get(base, target);
      assert.equal(res.status, 404, `${target} returned ${res.status}, expected 404`);
      const body = res.buf.toString('utf8');
      assert.ok(!body.includes('index-BKQ'), `${target} disclosed directory contents`);
    }
    return 'directory paths return 404 with no listing';
  });

  // --- teardown -----------------------------------------------------------
  await new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
  server = undefined;

  finish();
}

function finish() {
  const width = Math.max(...results.map((r) => r.name.length), 10);
  console.log('DSH minimal build — verification report');
  console.log('-'.repeat(width + 40));
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log('-'.repeat(width + 40));
  console.log(`RESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${results.length - failed.length}/${results.length})`);
  if (failed.length) {
    console.log('failed checks:');
    for (const r of failed) console.log(`  - ${r.name}: ${r.detail}`);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(`verification crashed: ${error.stack ?? error.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
