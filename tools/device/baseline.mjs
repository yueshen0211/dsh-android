// M1 device capability baseline.
//
// The design document makes this a gate on M1: "M1 must first re-run the M0
// capability baseline on real hardware, because M0's conclusions came from
// desktop Node 22, not arm64 libnode". Nothing had actually verified that on the
// phone, so this closes it.
//
// It is deliberately NOT a copy of tools/verify-engine.mjs. That suite runs on a
// desktop host and judges config trees; this one runs on the device through the
// app's own libnode.so and probes what the SHIPPING runtime can do. The two
// overlap only on the raw capability list.
//
// Each check reports ok/failed plus the concrete evidence, because "the module
// imported" is not the same as "the facility works" -- node:sqlite, worker
// threads and zstd all have failure modes that only appear on first use.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const req = createRequire(import.meta.url);
const out = {
  runtime: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
    modules: process.versions.modules,
    napi: process.versions.napi,
    pid: process.pid,
  },
  checks: {},
};

const record = (name, fn) => {
  try {
    const value = fn();
    out.checks[name] = value && typeof value.then === 'function'
      ? { status: 'pending' }
      : { status: 'ok', evidence: value };
  } catch (error) {
    out.checks[name] = { status: 'FAILED', error: `${error.code ?? ''} ${error.message}`.trim() };
  }
  return out.checks[name];
};
const arecord = async (name, fn) => {
  try {
    out.checks[name] = { status: 'ok', evidence: await fn() };
  } catch (error) {
    out.checks[name] = { status: 'FAILED', error: `${error.code ?? ''} ${error.message}`.trim() };
  }
};

// ── plain capabilities ───────────────────────────────────────────────────────
record('node:sqlite import', () => Object.keys(req('node:sqlite')).sort().join(','));
record('worker_threads', () => typeof req('node:worker_threads').Worker);
record('child_process', () => typeof req('node:child_process').spawn);
record('webcrypto', () => typeof globalThis.crypto?.subtle);
record('fetch', () => typeof globalThis.fetch);
record('AbortSignal.timeout', () => typeof AbortSignal.timeout);

// ── node:sqlite must actually open a database, not just import ────────────────
// The web bundle sets `openAt: never`, so this is deferred in normal use; it is
// exercised only by full-text search. Verifying it now avoids discovering a
// broken facility later.
await arecord('node:sqlite open+query', async () => {
  const { DatabaseSync } = req('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO t (name) VALUES (?)').run('dsh');
  const row = db.prepare('SELECT name FROM t WHERE id = 1').get();
  db.close();
  return `round-trip ok: ${JSON.stringify(row)}`;
});

// ── zstd, which the session store uses for every log ─────────────────────────
// session-persistence-jsonl imports createZstdCompress / createZstdDecompress /
// zstdCompress / zstdDecompressSync from node:zlib. If zstd were missing, session
// persistence would fail the same way flock and link did.
await arecord('zlib zstd round-trip', async () => {
  const zlib = await import('node:zlib');
  const names = ['zstdCompressSync', 'zstdDecompressSync', 'createZstdCompress', 'createZstdDecompress']
    .filter((n) => typeof zlib[n] === 'function');
  const payload = Buffer.from('session-log-payload '.repeat(64));
  const packed = zlib.zstdCompressSync(payload);
  const back = zlib.zstdDecompressSync(packed);
  const knownMagic = packed.readUInt32LE(0) === 0xfd2fb528;
  if (!back.equals(payload)) throw new Error('round-trip mismatch');
  return `${packed.length}B from ${payload.length}B, magic=${knownMagic}, exports=[${names.join(',')}]`;
});

// ── worker_threads must actually run one ─────────────────────────────────────
// The engine is started with `--import <preload>`, and this project relies on
// in-process loader hooks. That combination is exactly the kind of thing that can
// break worker startup, so it is worth proving a worker can run and talk back.
await arecord('worker_threads round-trip', async () => {
  const { Worker } = await import('node:worker_threads');
  const source = `
    const { parentPort } = require('node:worker_threads');
    parentPort.postMessage({ platform: process.platform, argv: process.execArgv.length });
  `;
  const worker = new Worker(source, { eval: true });
  const message = await new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
    setTimeout(() => reject(new Error('worker did not respond in 20s')), 20000);
  });
  await worker.terminate();
  return `worker replied: ${JSON.stringify(message)}`;
});

// ── child_process with pipes: the node-pty shim's whole premise ──────────────
await arecord('child_process spawn + piped stdio', async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn('/system/bin/sh', ['-c', 'echo dsh-child-ok; exit 7'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; });
    child.once('error', reject);
    child.once('close', () => resolve(buf));
  });
  return `captured ${JSON.stringify(stdout.trim())} (expected exit 7)`;
});

// ── spawnSync, used by the landlock probe in the sandbox provider ────────────
await arecord('child_process spawnSync', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('/system/bin/sh', ['-c', 'echo sync-ok'], { encoding: 'utf8', timeout: 5000 });
  return `status=${r.status} stdout=${JSON.stringify((r.stdout ?? '').trim())}`;
});

// ── the engine tree resolves, which is what the preload depends on ───────────
record('resolve engine entry', () => req.resolve('@deepseek-ai/dsh-session-persistence-jsonl').split('/node_modules/').pop());
record('resolve koffi', () => req.resolve('koffi').split('/node_modules/').pop());
record('process.execArgv', () => JSON.stringify(process.execArgv));

// ── landlock verdict, which the sandbox provider reports on Android ──────────
await arecord('landlock probe verdict', async () => {
  const { probe } = await import('@deepseek-ai/node-addon-system/landlock-run');
  return probe();
});

// Delimited so the runner can extract the report even when adb's own stderr
// notice ("1 file pushed") is interleaved into the captured stream. The runner
// matches these markers rather than trusting the whole stream to be JSON.
console.log('---DSH-BASELINE-JSON-BEGIN---');
console.log(JSON.stringify(out, null, 2));
console.log('---DSH-BASELINE-JSON-END---');
