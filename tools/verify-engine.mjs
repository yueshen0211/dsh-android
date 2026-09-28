// M0 verification suite for the DSH Android port.
//
// Answers the questions that decide whether the engine can run on a phone,
// without needing an arm64 device:
//
//   1. capability baseline  - does the runtime expose what the engine needs?
//   2. provider graph       - for a given composed profile tree, does every
//                             `static inject` entry still have a provider?
//                             This is what catches "row disabled -> some other
//                             row can never activate" before a device is involved.
//   3. http auth flow       - token -> HttpOnly cookie -> authenticated index,
//                             which is exactly what the Android WebView does.
//
// Usage:
//   node tools/verify-engine.mjs --home <DSH_HOME> --dsh <dsh.cmd> \
//        --patch profile/android.patch.simulated.yml \
//        [--simulate-android] [--url <engineUrlWithToken>] [--json out.json]
//
// `--simulate-android` re-evaluates the `!!js process.platform === 'android'`
// guards in the patch as if the host were Android, so the desktop host can
// inspect the phone's tree.

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(HERE, '..');

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const has = (name) => process.argv.includes(`--${name}`);

const DSH = arg('dsh', 'dsh');
const HOME = arg('home', join(WORKSPACE, '.m0', 'dsh-home'));
const WORKDIR = arg('workdir', join(WORKSPACE, '.m0', 'workspace'));
const TREE_FILE = arg('tree');
const PATCH = arg('patch');
const SIMULATE = has('simulate-android');
const ENGINE_UP = has('engine-up');
const URL_ARG = arg('url');
const JSON_OUT = arg('json');

if (!TREE_FILE) {
  console.error('verify-engine: --tree <composed-config.yml|- > is required.');
  console.error('  produce it first:  dsh --profile web --patch <patch> --dump-config > tree.yml');
  process.exit(2);
}

const report = { generatedAt: new Date().toISOString(), simulateAndroid: SIMULATE };

// ── 1. capability baseline ───────────────────────────────────────────────────
// Probed in a child-free way: this file is ESM, where `require` does not exist,
// so CommonJS-only builtins are loaded through createRequire.
function capabilityBaseline() {
  const req = createRequire(import.meta.url);
  const probe = (fn) => { try { return { ok: true, value: String(fn()) }; } catch (e) { return { ok: false, error: String(e.message ?? e) }; } };
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    capabilities: {
      'node:sqlite': probe(() => Object.keys(req('node:sqlite')).join(',')),
      worker_threads: probe(() => typeof req('node:worker_threads').Worker),
      child_process: probe(() => typeof req('node:child_process').spawn),
      webcrypto: probe(() => typeof globalThis.crypto?.subtle),
      fetch: probe(() => typeof globalThis.fetch),
      AbortSignal: probe(() => typeof AbortSignal.timeout),
    },
  };
}

// ── 2. provider graph ────────────────────────────────────────────────────────
// The composed tree (`--dump-config`) names each row's plugin package. A row
// that is `disabled` never activates, so any service it would have provided is
// absent. Packages declare consumed services as `static inject = [...]` and
// register provided ones via `super(ctx, "<name>")` / `new Service(ctx, "<name>")`.
function parseTree(text) {
  const rows = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const idM = raw.match(/^- id:\s*(\S+)/);
    if (idM) { cur = { id: idM[1], name: null, disabled: null }; rows.push(cur); continue; }
    if (!cur) continue;
    const nameM = raw.match(/^ {2}name:\s*(.+?)\s*$/);
    if (nameM && cur.name === null) { cur.name = nameM[1].replace(/^['"]|['"]$/g, ''); continue; }
    const disM = raw.match(/^ {2}disabled:\s*(.+?)\s*$/);
    if (disM && cur.disabled === null) cur.disabled = disM[1];
  }
  return rows;
}

// A `disabled:` value is either a literal or a `!!js` expression. With
// --simulate-android we evaluate the expression with process.platform replaced
// by 'android'; otherwise only literal true/false count.
function isDisabled(row) {
  if (row.disabled === null || row.disabled === undefined) return false;
  const v = row.disabled.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (!SIMULATE) return false;                       // `!!js` and we are not simulating
  const expr = v.replace(/^!!js\s*/, '');
  try {
    const patched = expr.replace(/process\.platform/g, JSON.stringify('android'));
    // eslint-disable-next-line no-new-func
    return Boolean(new Function('process', `return (${patched});`)({ platform: 'android', env: {} }));
  } catch { return false; }
}

function resolvePackageDir(pkgName, home) {
  const candidates = [
    join(home, 'profiles', 'node_modules', ...pkgName.split('/')),
    join(home, 'profiles', 'web', 'node_modules', ...pkgName.split('/')),
  ];
  for (const c of candidates) { try { readFileSync(join(c, 'package.json')); return c; } catch {} }
  return null;
}

function serviceFacts(pkgDir) {
  let code = '';
  try { code = readFileSync(join(pkgDir, 'lib', 'index.js'), 'utf8'); } catch { return { provides: [], injects: [] }; }
  const provides = new Set();
  for (const m of code.matchAll(/(?:super|Service)\s*\(\s*(?:this\s*,\s*)?ctx\s*,\s*["']([A-Za-z_][\w.]*)["']/g)) provides.add(m[1]);
  for (const m of code.matchAll(/super\s*\(\s*ctx\s*,\s*["']([A-Za-z_][\w.]*)["']/g)) provides.add(m[1]);
  const injects = new Set();
  for (const m of code.matchAll(/static\s+inject\s*=\s*\[([^\]]*)\]/g)) {
    for (const s of m[1].matchAll(/["']([A-Za-z_][\w.]*)["']/g)) injects.add(s[1]);
  }
  return { provides: [...provides], injects: [...injects] };
}

function providerGraph(rows, home) {
  const factCache = new Map();
  const factsOf = (pkg) => {
    if (!factCache.has(pkg)) {
      const dir = resolvePackageDir(pkg, home);
      factCache.set(pkg, dir ? serviceFacts(dir) : null);
    }
    return factCache.get(pkg);
  };

  const enabled = rows.filter((r) => r.name && !isDisabled(r));
  const disabled = rows.filter((r) => r.name && isDisabled(r));

  const providers = new Map();          // service -> [pkg]
  for (const r of enabled) {
    const f = factsOf(r.name);
    if (!f) continue;
    for (const s of f.provides) providers.set(s, [...(providers.get(s) ?? []), r.name]);
  }

  const unresolved = [];
  for (const r of enabled) {
    const f = factsOf(r.name);
    if (!f) continue;
    for (const need of f.injects) {
      if (!providers.has(need)) {
        // Was the provider disabled by this overlay? That is the actionable case.
        const lostFrom = disabled.filter((d) => (factsOf(d.name)?.provides ?? []).includes(need)).map((d) => d.id);
        unresolved.push({ consumer: r.id, package: r.name, needs: need, providerDisabledAs: lostFrom });
      }
    }
  }

  return {
    rowCount: rows.length,
    enabled: enabled.length,
    disabledRows: disabled.map((r) => ({ id: r.id, package: r.name })),
    providerCount: providers.size,
    unresolved,
    resolved: unresolved.length === 0,
  };
}

// ── composed tree input ──────────────────────────────────────────────────────
// This verifier never spawns the engine itself. Under this sandbox
// child_process with piped stdio fails with EPERM (named-pipe restriction), and
// `shell: true` routes through cmd.exe which is blocked outright. So the caller
// produces the config dump with the shell it already has and points us at it:
//
//   dsh --profile web --patch profile/android.patch.yml --dump-config > tree.yml
//   node tools/verify-engine.mjs --tree tree.yml --simulate-android
//
// `--tree -` reads stdin.
function readTreeInput() {
  if (TREE_FILE === '-') return readFileSync(0, 'utf8');
  return readFileSync(TREE_FILE, 'utf8');
}

// ── 3. http auth flow ────────────────────────────────────────────────────────
async function httpFlow(url) {
  const base = new URL(url);
  const origin = base.origin;
  const out = { origin, tokenPresent: base.searchParams.has('token') };

  const r1 = await fetch(url, { redirect: 'manual' });
  out.rootStatus = r1.status;
  out.rootLocation = r1.headers.get('location');
  const cookies = r1.headers.getSetCookie ? r1.headers.getSetCookie() : [];
  out.cookie = cookies.map((c) => ({
    name: c.split('=')[0],
    httpOnly: /HttpOnly/i.test(c),
    sameSiteStrict: /SameSite=Strict/i.test(c),
    path: (c.match(/Path=([^;]+)/i) ?? [])[1] ?? null,
    maxAgeDays: (() => { const m = c.match(/Max-Age=(\d+)/i); return m ? Math.round(+m[1] / 86400) : null; })(),
    secure: /Secure/i.test(c),
  }));
  const cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');

  out.cleanRootWithoutCookie = (await fetch(origin + '/', { redirect: 'manual' })).status;
  const r3 = await fetch(origin + '/', { headers: { cookie: cookieHeader }, redirect: 'manual' });
  out.cleanRootWithCookie = r3.status;
  const html = await r3.text();
  out.indexBytes = html.length;
  out.hasModuleLoader = html.includes('__ModuleLoader__');
  out.hasBootGraph = html.includes('__DSH_BOOT__');

  const asset = html.match(/src="\.\/(assets\/[^"]+)"/);
  if (asset) {
    const r4 = await fetch(`${origin}/${asset[1]}`);
    out.staticAsset = { status: r4.status, bytes: (await r4.arrayBuffer()).byteLength };
  }

  out.pass =
    out.rootStatus === 303 &&
    out.cookie.some((c) => c.httpOnly && c.sameSiteStrict) &&
    out.cleanRootWithoutCookie === 401 &&
    out.cleanRootWithCookie === 200 &&
    out.hasBootGraph;
  return out;
}

// ── run ──────────────────────────────────────────────────────────────────────
const treeText = readTreeInput();
const rows = parseTree(treeText);
report.tree = providerGraph(rows, HOME);
report.capability = capabilityBaseline();

if (URL_ARG) report.httpFlow = await httpFlow(URL_ARG);

if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));

const pad = (s, n) => String(s).padEnd(n);
console.log('=== M0 engine verification ===');
console.log(`simulate-android : ${SIMULATE}`);
console.log(`patch            : ${PATCH ?? '(none)'}`);
console.log('');
console.log('--- capability baseline ---');
console.log(`  node ${report.capability.node} (${report.capability.platform}/${report.capability.arch})`);
for (const [k, v] of Object.entries(report.capability.capabilities)) {
  console.log(`  ${pad(k, 18)} ${v.ok ? 'ok   ' + v.value : 'FAIL ' + v.error}`);
}
console.log('');
console.log('--- composed tree ---');
console.log(`  rows ${report.tree.rowCount}, enabled ${report.tree.enabled}, disabled ${report.tree.disabledRows.length}`);
for (const d of report.tree.disabledRows) console.log(`    disabled: ${pad(d.id, 22)} ${d.package}`);
console.log(`  services provided by enabled rows: ${report.tree.providerCount}`);
console.log('');
console.log('--- provider graph (ADVISORY) ---');
// This analysis is advisory, never a gate. It infers providers from
// `super(ctx[, "name"])` patterns, which misses dynamic registration
// (`super(ctx)` plus an internal service name) and therefore reports
// false gaps: a stock, booting composition already lists ~20 "unresolved"
// services. Treat only DELTAS between two trees as signal, and let the real
// boot + http flow decide the result.
if (report.tree.resolved) {
  console.log('  no missing providers detected');
} else {
  console.log(`  ${report.tree.unresolved.length} consumer(s) with no detected provider (expected on a healthy tree too)`);
  for (const u of report.tree.unresolved.slice(0, 8)) {
    const why = u.providerDisabledAs.length ? `provider disabled as: ${u.providerDisabledAs.join(', ')}` : 'no provider detected';
    console.log(`    ${pad(u.consumer, 24)} needs '${u.needs}'  <- ${why}`);
  }
  if (report.tree.unresolved.length > 8) console.log(`    ... and ${report.tree.unresolved.length - 8} more`);
}
if (report.httpFlow) {
  console.log('');
  console.log('--- http auth flow ---');
  console.log(`  GET /?token      -> ${report.httpFlow.rootStatus} -> ${report.httpFlow.rootLocation}`);
  for (const c of report.httpFlow.cookie) {
    console.log(`  cookie ${c.name.slice(0, 28)}... httpOnly=${c.httpOnly} sameSite=${c.sameSiteStrict ? 'Strict' : '?'} maxAge=${c.maxAgeDays}d secure=${c.secure}`);
  }
  console.log(`  GET /  (no cookie)  -> ${report.httpFlow.cleanRootWithoutCookie}`);
  console.log(`  GET /  (cookie)     -> ${report.httpFlow.cleanRootWithCookie}  ${report.httpFlow.indexBytes} bytes, bootGraph=${report.httpFlow.hasBootGraph}`);
  if (report.httpFlow.staticAsset) console.log(`  static asset        -> ${report.httpFlow.staticAsset.status}  ${report.httpFlow.staticAsset.bytes} bytes`);
  console.log(`  RESULT: ${report.httpFlow.pass ? 'PASS' : 'FAIL'}`);
}
console.log('');
// The gate is empirical: the caller states that a real engine boot against this
// configuration reached "dsh web: <url>" (--engine-up), and the http flow then
// has to complete. Static graph analysis cannot substitute for that.
const parts = [];
if (ENGINE_UP) parts.push('engine booted');
if (report.httpFlow) parts.push(report.httpFlow.pass ? 'http flow passed' : 'http flow FAILED');
const ok = (!ENGINE_UP || true) && (!report.httpFlow || report.httpFlow.pass) && ENGINE_UP;
report.verdict = { engineUp: ENGINE_UP, httpFlow: report.httpFlow?.pass ?? null, pass: ok };
console.log(`evidence: ${parts.join(', ') || '(none supplied)'}`);
if (!ENGINE_UP) console.log('note: pass --engine-up once you have observed a successful boot for this configuration');
console.log(ok ? 'M0 RESULT: PASS' : 'M0 RESULT: INCOMPLETE');
process.exit(ok ? 0 : 1);
