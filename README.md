# DSH minimal build — a verifiable static build of the captured client snapshot

A **zero-dependency, deterministic build + verification pipeline** for the DeepSeek Harness
web-client snapshot captured in `work/`. No `npm install` is required: everything runs on the
Node.js standard library.

```bash
node build.mjs     # work/ -> outputs/dist/ + outputs/build-report.json
node verify.mjs    # rebuild + 23 mechanical assertions, exit 0 only if all pass
node serve.mjs --port 8080   # serve outputs/dist on http://127.0.0.1:8080
npm test           # alias for node verify.mjs
```

## Inputs and outputs

| Role | Path |
| --- | --- |
| Boot shell (source of truth for the entry name) | `work/index.html` (27,660 B) |
| Module entry chunk | `work/index.js` (555,959 B, valid ESM) |
| Servable artifact | `outputs/dist/**` |
| Machine-checkable build record | `outputs/build-report.json` |
| Browser-fetchable manifest | `outputs/dist/build-manifest.json` |

`work/gateway.js` (0 B) is unreferenced and is intentionally not part of the build.
`work/` is never modified — verified by hashing the sources before and after the build.

## What the build actually does

1. Parses every `<script src>` and `<link href>` out of the boot shell.
2. Reads the module entry target from the shell's own `<script type="module">` tag
   (`./assets/index-BKQ_L1z6.js`) instead of hard-coding it, then places `work/index.js` there
   byte-for-byte.
3. Emits the two inert metadata assets it can derive (`manifest.webmanifest`, `favicon.svg`) and
   labels them `generated` in the report — distinct from `copied` sources.
4. Extracts the entry chunk's ESM graph: 1 static specifier (`./vendor-CCJJTK99.js`) and 23 lazy
   `./langs/*.js` specifiers, resolving each against the entry directory.
5. **Gates on completeness:** every reference is either emitted into `dist/` or matched against an
   explicit `GAP_RULES` entry with a severity. An unmatched missing reference aborts the build, so
   a silent 404 cannot ship.
6. Emits a `buildId` = sha256 over the sorted `path\0sha256` list of outputs. No timestamps, no
   absolute paths and no environment data enter the report.

## Verified properties (`node verify.mjs`, 23/23 PASS)

| Check | Result |
| --- | --- |
| `build.canonical` | `buildId=710f256f5b24`, 4 outputs, 28 declared gaps |
| `build.sources-unmodified` | 2 source files re-hashed and unchanged |
| `dist.html.byte-identical` | 27,660 B, identical to `work/index.html` |
| `dist.entry.byte-identical` | 555,959 B at the shell-declared path |
| `dist.outputs.hash-verified` | all outputs re-hashed, 0 stray files in `dist/` |
| `dist.esm.parse` | every built `.js` parse-checked as ESM by the Node runtime |
| `dist.refs.all-accounted` | 3 built / 5 declared gaps / 0 undeclared |
| `dist.boot-contract` | `#root`, `__ModuleLoader__`, `__DSH_BOOT_READY__`, `<base href="/">`, entry scripts |
| `dist.manifest.fetchable` | manifest entries re-derived from disk |
| `dist.no-secret-material` | `work/cookies.txt` credential bytes absent from the artifact |
| `build.reproducible` | two independent builds byte-identical (reports and all files) |
| `build.boot-readiness-consistent` | blocker list agrees with the static module graph |
| `http.*` (11 checks) | status, MIME, ETag/304, `405 + Allow`, declared gaps 404, no directory listing, `/healthz` |
| `http.traversal-blocked` | 5 raw `../` and percent-encoded probes rejected, no credential bytes served |

Determinism was additionally re-confirmed outside the suite: two CLI builds into separate
directories produced identical SHA-256 sets and byte-identical reports.

## Declared gaps — what this artifact is *not*

The captured snapshot is incomplete, so the build records what it cannot supply rather than
faking it. Gaps carry a severity, and `build-report.json → bootReadiness` states the consequence
machine-readably:

| Gap | Count | Severity | Consequence |
| --- | --- | --- | --- |
| `assets/vendor-CCJJTK99.js` | 1 | `blocks-boot` | static import of the entry chunk — **the page cannot execute** |
| `assets/*.css` | 2 | `degrades-ui` | unstyled rendering |
| `assets/langs/*.js` | 23 | `lazy-only` | syntax highlighting unavailable per language |
| `plugins/??…` concat requests | 2 | `blocks-plugins` | plugin client modules absent |

**Honest scope:** this build proves the artifact is structurally complete, byte-faithful,
reproducible, credential-free and correctly served over HTTP. It does **not** claim the DeepSeek
Harness UI boots — `assets/vendor-CCJJTK99.js` (and the ~40 plugin client chunks) were never
captured into `work/`, so the boot shell would throw on the entry chunk's first static import.
`bootReadiness.ready` is `false` and names that blocker, by design rather than by omission.
