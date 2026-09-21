#!/usr/bin/env node
/**
 * build.mjs — minimal, dependency-free, deterministic build of the captured
 * DeepSeek Harness web-client snapshot.
 *
 *   input : work/index.html  (boot shell)
 *           work/index.js    (module entry chunk)
 *   output: outputs/dist/**  (servable static artifact)
 *           outputs/build-report.json (machine-checkable build record)
 *
 * The build is a gate, not a copy: every local reference found in the boot
 * shell and every local edge of the entry chunk's module graph is either
 * emitted into dist/ or explicitly declared as a known gap with a severity.
 * A reference that is neither emitted nor declared fails the build.
 *
 * Determinism: no timestamps, no absolute paths and no environment data enter
 * the report, so two builds of the same inputs produce byte-identical output
 * and an identical buildId.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const WORK_DIR = path.join(ROOT, 'work');
export const HTML_SOURCE = path.join(WORK_DIR, 'index.html');
export const ENTRY_SOURCE = path.join(WORK_DIR, 'index.js');
export const DEFAULT_OUT_DIR = path.join(ROOT, 'outputs', 'dist');
export const DEFAULT_REPORT = path.join(ROOT, 'outputs', 'build-report.json');
export const FALLBACK_ENTRY_TARGET = 'assets/index-BKQ_L1z6.js';
export const MANIFEST_NAME = 'build-manifest.json';
export const SCHEMA_VERSION = 1;

/**
 * Declared gaps: local references this snapshot knowingly cannot satisfy
 * because the corresponding source file was never captured into work/.
 * Anything missing that matches no rule is an undeclared gap and is fatal.
 */
export const GAP_RULES = [
  {
    test: /^assets\/vendor-[^/]+\.js$/,
    severity: 'blocks-boot',
    reason: 'vendor chunk was not captured in work/',
  },
  {
    test: /^assets\/[^/]+\.css$/,
    severity: 'degrades-ui',
    reason: 'stylesheet was not captured in work/',
  },
  {
    test: /^assets\/langs\//,
    severity: 'lazy-only',
    reason: 'lazy syntax-highlight chunk was not captured in work/',
  },
  {
    test: /^plugins\//,
    severity: 'blocks-plugins',
    reason: 'plugin client modules were not captured in work/',
  },
];

const EXTERNAL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function unique(list) {
  return [...new Set(list)];
}

/** Parse a start tag's attribute list. Only quoted values are read. */
function parseAttrs(source) {
  const attrs = Object.create(null);
  for (const m of source.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?/g)) {
    attrs[m[1].toLowerCase()] = m[2] ?? '';
  }
  return attrs;
}

/** Every <script src> and <link href> in the boot shell, in document order. */
export function parseHtmlRefs(html) {
  const refs = [];
  for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
    const attrs = parseAttrs(m[1]);
    if (attrs.src) {
      refs.push({
        tag: 'script',
        kind: attrs.type === 'module' ? 'module-script' : 'script',
        attrs,
        raw: attrs.src,
      });
    }
  }
  for (const m of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = parseAttrs(m[1]);
    if (attrs.href) {
      refs.push({
        tag: 'link',
        kind: `link:${attrs.rel || 'unknown'}`,
        attrs,
        raw: attrs.href,
      });
    }
  }
  return refs;
}

/** Classify one reference into external / concat / unsafe / pending. */
export function classifyRef(entry) {
  const value = String(entry.raw).trim();
  if (value === '') return { ...entry, status: 'external', path: null };
  if (EXTERNAL_RE.test(value)) return { ...entry, status: 'external', path: null };

  // `/plugins/??a,b,c` is a dev-server concatenation request, not a real path.
  if (value.includes('??')) {
    return {
      ...entry,
      status: 'pending',
      concat: true,
      path: value.replace(/^\.\//, '').replace(/^\/+/, ''),
    };
  }

  const withoutFragment = value.split('#')[0];
  const rawPath = withoutFragment.split('?')[0];
  const p = rawPath.replace(/^\.\//, '').replace(/^\/+/, '');
  if (p === '' || p.split('/').includes('..')) {
    return { ...entry, status: 'unsafe', path: p };
  }
  return { ...entry, status: 'pending', path: p };
}

/** Static and dynamic import specifiers of an ES module source text. */
export function extractModuleSpecifiers(code) {
  const staticSpecs = [];
  const dynamicSpecs = [];

  const fromRe = /\b(?:import|export)\b[^;'"`]*?\bfrom\s*["']([^"']+)["']/g;
  for (const m of code.matchAll(fromRe)) staticSpecs.push(m[1]);

  const bareImportRe = /\bimport\s*["']([^"']+)["']/g;
  for (const m of code.matchAll(bareImportRe)) staticSpecs.push(m[1]);

  const dynamicRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of code.matchAll(dynamicRe)) dynamicSpecs.push(m[1]);

  return { static: unique(staticSpecs), dynamic: unique(dynamicSpecs) };
}

/** Resolve a relative specifier against a POSIX-style directory. */
export function resolveSpecifier(baseDir, spec) {
  const clean = spec.split('#')[0].split('?')[0];
  const stack = baseDir === '' || baseDir === '.' ? [] : baseDir.split('/');
  for (const part of clean.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join('/');
}

function isRelative(spec) {
  return spec.startsWith('./') || spec.startsWith('../');
}

/** Inert metadata assets we can safely derive; flagged `generated` in the report. */
function generatedAssets(html) {
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() || 'DeepSeek Harness';
  const shortName = title.split(/\s+/)[0] || title;
  return {
    'manifest.webmanifest':
      JSON.stringify(
        {
          name: title,
          short_name: shortName,
          start_url: '/',
          scope: '/',
          display: 'standalone',
          background_color: '#ffffff',
          theme_color: '#4d6bfe',
          icons: [{ src: './favicon.svg', sizes: 'any', type: 'image/svg+xml' }],
        },
        null,
        2,
      ) + '\n',
    'favicon.svg':
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img">' +
      '<rect width="32" height="32" rx="7" fill="#4d6bfe"/>' +
      '<g fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M13 9 8 16l5 7M19 9l5 7-5 7"/></g></svg>\n',
  };
}

function gapFor(relPath) {
  const rule = GAP_RULES.find((r) => r.test.test(relPath));
  if (!rule) return null;
  return { path: relPath, severity: rule.severity, reason: rule.reason };
}

function stagePath(rel) {
  return path.join(...rel.split('/'));
}

function sortByPath(list) {
  return [...list].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Run the build.
 * @param {{outDir?: string, reportPath?: string, log?: (msg: string) => void}} options
 */
export function runBuild(options = {}) {
  const outDir = options.outDir ? path.resolve(options.outDir) : DEFAULT_OUT_DIR;
  const reportPath = options.reportPath ? path.resolve(options.reportPath) : DEFAULT_REPORT;
  const log = options.log ?? (() => {});

  if (!fs.existsSync(HTML_SOURCE)) throw new Error(`missing source file: ${HTML_SOURCE}`);
  if (!fs.existsSync(ENTRY_SOURCE)) throw new Error(`missing source file: ${ENTRY_SOURCE}`);

  // ---- read inputs -------------------------------------------------------
  const htmlBuf = fs.readFileSync(HTML_SOURCE);
  const entryBuf = fs.readFileSync(ENTRY_SOURCE);
  const html = htmlBuf.toString('utf8');

  const sources = [
    { path: 'work/index.html', bytes: htmlBuf.length, sha256: sha256(htmlBuf) },
    { path: 'work/index.js', bytes: entryBuf.length, sha256: sha256(entryBuf) },
  ];

  // ---- determine the module entry target from the shell itself -----------
  const refs = parseHtmlRefs(html).map(classifyRef);
  const unsafe = refs.filter((r) => r.status === 'unsafe');
  if (unsafe.length > 0) {
    throw new Error(`boot shell contains unsafe reference(s): ${unsafe.map((r) => r.raw).join(', ')}`);
  }
  const entryRef = refs.find((r) => r.kind === 'module-script' && r.status === 'pending');
  const entryTarget = entryRef?.path ?? FALLBACK_ENTRY_TARGET;
  const entryDir = path.posix.dirname(entryTarget) === '.' ? '' : path.posix.dirname(entryTarget);

  // ---- stage outputs -----------------------------------------------------
  /** @type {Map<string, {buf: Buffer, origin: string, source: string|null}>} */
  const staged = new Map();
  staged.set('index.html', { buf: htmlBuf, origin: 'copied', source: 'work/index.html' });
  staged.set(entryTarget, { buf: entryBuf, origin: 'copied', source: 'work/index.js' });
  for (const [rel, text] of Object.entries(generatedAssets(html))) {
    if (!staged.has(rel)) {
      staged.set(rel, { buf: Buffer.from(text, 'utf8'), origin: 'generated', source: null });
    }
  }

  // ---- account for every reference --------------------------------------
  const gaps = new Map();
  const references = refs.map((r) => {
    if (r.status === 'external') return { ref: r.raw, kind: r.kind, path: null, status: 'external' };
    if (staged.has(r.path)) {
      return { ref: r.raw, kind: r.kind, path: r.path, status: 'built', origin: staged.get(r.path).origin };
    }
    const gap = gapFor(r.path);
    if (!gap) throw new Error(`undeclared missing reference "${r.raw}" (resolved: ${r.path})`);
    gaps.set(gap.path, gap);
    return {
      ref: r.raw,
      kind: r.kind,
      path: r.path,
      status: 'gap',
      severity: gap.severity,
      reason: gap.reason,
    };
  });

  // ---- module graph of the entry chunk ----------------------------------
  const specifiers = extractModuleSpecifiers(entryBuf.toString('utf8'));
  const moduleGraph = { static: [], dynamic: [] };
  for (const [kind, specs] of [
    ['static', specifiers.static],
    ['dynamic', specifiers.dynamic],
  ]) {
    for (const spec of specs) {
      if (!isRelative(spec)) {
        moduleGraph[kind].push({ spec, target: null, status: 'bare' });
        continue;
      }
      const target = resolveSpecifier(entryDir, spec);
      if (staged.has(target)) {
        moduleGraph[kind].push({ spec, target, status: 'built' });
        continue;
      }
      const gap = gapFor(target);
      if (!gap) throw new Error(`undeclared missing module edge "${spec}" (resolved: ${target})`);
      gaps.set(gap.path, gap);
      moduleGraph[kind].push({
        spec,
        target,
        status: 'gap',
        severity: gap.severity,
        reason: gap.reason,
      });
    }
  }

  // ---- write dist --------------------------------------------------------
  fs.rmSync(outDir, { recursive: true, force: true });
  const outputs = [];
  for (const rel of [...staged.keys()].sort()) {
    const item = staged.get(rel);
    const abs = path.join(outDir, stagePath(rel));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, item.buf);
    outputs.push({
      path: rel,
      bytes: item.buf.length,
      sha256: sha256(item.buf),
      origin: item.origin,
      source: item.source,
    });
  }

  const buildId = sha256(outputs.map((o) => `${o.path}\0${o.sha256}`).join('\n'));

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    buildId,
    entry: entryTarget,
    files: outputs.map((o) => ({ path: o.path, bytes: o.bytes, sha256: o.sha256 })),
  };
  const manifestAbs = path.join(outDir, MANIFEST_NAME);
  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  fs.writeFileSync(manifestAbs, manifestBuf);

  // ---- report ------------------------------------------------------------
  const gapList = sortByPath([...gaps.values()]);
  const gapsBySeverity = {};
  for (const g of gapList) gapsBySeverity[g.severity] = (gapsBySeverity[g.severity] ?? 0) + 1;
  const blockers = gapList.filter((g) => g.severity === 'blocks-boot').map((g) => g.path);

  const report = {
    schemaVersion: SCHEMA_VERSION,
    buildId,
    sources: sortByPath(sources),
    entry: { source: 'work/index.js', target: entryTarget, declaredBy: entryRef?.raw ?? null },
    outputs: sortByPath(outputs),
    manifest: { path: MANIFEST_NAME, bytes: manifestBuf.length, sha256: sha256(manifestBuf) },
    references: sortByPath(references.map((r) => ({ ...r, path: r.path ?? '' }))).map((r) =>
      r.path === '' ? { ...r, path: null } : r,
    ),
    moduleGraph,
    gaps: gapList,
    bootReadiness: {
      ready: blockers.length === 0,
      blockers,
      note: blockers.length
        ? 'artifact is structurally complete but cannot boot: blocking chunks are absent from the snapshot'
        : 'no blocking gaps recorded',
    },
    summary: {
      outputs: outputs.length,
      copied: outputs.filter((o) => o.origin === 'copied').length,
      generated: outputs.filter((o) => o.origin === 'generated').length,
      references: references.length,
      externalReferences: references.filter((r) => r.status === 'external').length,
      gaps: gapList.length,
      gapsBySeverity,
      moduleEdges: moduleGraph.static.length + moduleGraph.dynamic.length,
    },
  };

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, Buffer.from(JSON.stringify(report, null, 2) + '\n', 'utf8'));

  log(`build ${buildId.slice(0, 12)} -> ${path.relative(ROOT, outDir) || outDir}`);
  log(
    `  outputs=${report.summary.outputs} copied=${report.summary.copied} generated=${report.summary.generated}` +
      ` references=${report.summary.references} gaps=${report.summary.gaps}`,
  );
  if (Object.keys(gapsBySeverity).length) {
    log(`  gaps: ${Object.entries(gapsBySeverity).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  }
  log(`  boot ready: ${report.bootReadiness.ready ? 'yes' : `no (${blockers.join(', ')})`}`);

  return report;
}

function parseArgs(argv) {
  const out = { outDir: DEFAULT_OUT_DIR, reportPath: DEFAULT_REPORT, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') out.outDir = path.resolve(argv[++i]);
    else if (arg === '--report') out.reportPath = path.resolve(argv[++i]);
    else if (arg === '--quiet') out.quiet = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    runBuild({ ...args, log: args.quiet ? () => {} : (m) => console.log(m) });
  } catch (error) {
    console.error(`build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
