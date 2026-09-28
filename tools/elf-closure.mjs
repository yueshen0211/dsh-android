// Resolve the DT_NEEDED closure of an ELF binary against a pool of candidate
// shared objects, and report which dependencies are still unsatisfied.
//
// Used to decide exactly which .so files must ship inside the APK: everything
// reachable from the node binary, minus the libraries Android itself provides
// (libc, libm, libdl, liblog, libz is NOT system-provided on all versions and
// is bundled by Termux, so it is treated as required).
//
// Usage:
//   node tools/elf-closure.mjs --root <binary> --pool <dir> [--pool <dir>...] [--json out.json]

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const roots = [];
const pools = [];
let jsonOut = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root') roots.push(args[++i]);
  else if (args[i] === '--pool') pools.push(args[++i]);
  else if (args[i] === '--json') jsonOut = args[++i];
}
if (!roots.length || !pools.length) {
  console.error('usage: elf-closure.mjs --root <elf> --pool <dir> [--pool <dir>] [--json out]');
  process.exit(2);
}

// Libraries the Android platform always provides to an app process.
const SYSTEM = new Set([
  'libc.so', 'libm.so', 'libdl.so', 'liblog.so', 'libandroid.so',
  'libstdc++.so', 'libz.so', 'libGLESv2.so', 'libEGL.so', 'libjnigraphics.so',
  'libOpenSLES.so', 'libcamera2ndk.so', 'libnativewindow.so', 'libsync.so',
  'libvulkan.so', 'libneuralnetworks.so', 'libnativehelper.so',
]);

function parseElf(path) {
  let buf;
  try { buf = readFileSync(path); } catch { return null; }
  // Skip anything too small to hold an ELF64 header (marker files, text, etc.).
  if (buf.length < 64) return null;
  if (buf.readUInt32BE(0) !== 0x7f454c46 || buf[4] !== 2 || buf[5] !== 1) return null;
  const ePhoff = Number(buf.readBigUInt64LE(32));
  const ePhentsize = buf.readUInt16LE(54);
  const ePhnum = buf.readUInt16LE(56);
  if (ePhoff + ePhentsize * ePhnum > buf.length) return null;

  let dynOff = null, dynSize = 0;
  const loads = [];
  const segments = [];
  for (let i = 0; i < ePhnum; i++) {
    const off = ePhoff + i * ePhentsize;
    const pType = buf.readUInt32LE(off);
    const pOffset = Number(buf.readBigUInt64LE(off + 8));
    const pVaddr = Number(buf.readBigUInt64LE(off + 16));
    const pFilesz = Number(buf.readBigUInt64LE(off + 32));
    segments.push({ pType, pOffset, pVaddr, pFilesz });
    if (pType === 1) loads.push({ pOffset, pVaddr, pFilesz });
    if (pType === 2) { dynOff = pOffset; dynSize = pFilesz; }
  }
  if (dynOff === null) return { needed: [], soname: null, runpath: null };

  const entries = [];
  for (let o = dynOff; o < dynOff + dynSize; o += 16) {
    const tag = Number(buf.readBigUInt64LE(o));
    const val = Number(buf.readBigUInt64LE(o + 8));
    entries.push({ tag, val });
    if (tag === 0) break;
  }
  const strtabVaddr = entries.find((e) => e.tag === 5)?.val;
  const strtabLoad = loads.find((l) => strtabVaddr >= l.pVaddr && strtabVaddr < l.pVaddr + l.pFilesz);
  const readStr = (off) => {
    if (!strtabLoad) return '';
    const at = strtabLoad.pOffset + (strtabVaddr + off - strtabLoad.pVaddr);
    if (at < 0 || at >= buf.length) return '';
    let end = at;
    while (end < buf.length && buf[end] !== 0) end++;
    return buf.toString('utf8', at, end);
  };

  return {
    needed: entries.filter((e) => e.tag === 1).map((e) => readStr(e.val)).filter(Boolean),
    soname: (() => { const s = entries.find((e) => e.tag === 14); return s ? readStr(s.val) : null; })(),
    runpath: (() => { const s = entries.find((e) => e.tag === 29) ?? entries.find((e) => e.tag === 15); return s ? readStr(s.val) : null; })(),
  };
}

// Build the pool index: SONAME (or basename) -> file path.
const poolIndex = new Map();
for (const dir of pools) {
  let entries = [];
  try { entries = readdirSync(dir); } catch { continue; }
  for (const name of entries) {
    const full = join(dir, name);
    try { if (!statSync(full).isFile()) continue; } catch { continue; }
    const info = parseElf(full);
    const key = info?.soname || name;
    if (!poolIndex.has(key)) poolIndex.set(key, full);
    if (!poolIndex.has(name)) poolIndex.set(name, full);
  }
}

const result = { roots, ships: [], missing: [], system: [], edges: {} };
const seen = new Set();
const queue = [...roots];

while (queue.length) {
  const lib = queue.shift();
  if (seen.has(lib)) continue;
  seen.add(lib);
  const info = parseElf(lib);
  if (!info) continue;
  const base = lib.split(/[\\/]/).pop();
  const edges = [];
  for (const need of info.needed) {
    if (SYSTEM.has(need)) { if (!result.system.includes(need)) result.system.push(need); continue; }
    edges.push(need);
    const found = poolIndex.get(need);
    if (found) queue.push(found);
    else if (!result.missing.includes(need)) result.missing.push(need);
  }
  result.edges[base] = { needed: info.needed, soname: info.soname, runpath: info.runpath, resolved: edges };
  if (!roots.includes(lib)) result.ships.push(found0(base, lib));
}

function found0(base, lib) { return { name: base, path: lib }; }

result.ships.sort((a, b) => a.name.localeCompare(b.name));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(result, null, 2));

console.log(`roots: ${roots.map((r) => r.split(/[\\/]/).pop()).join(', ')}`);
console.log(`pool entries: ${poolIndex.size}`);
console.log(`\nShips (${result.ships.length}):`);
for (const s of result.ships) console.log(`  ${s.name}`);
console.log(`\nProvided by Android (${result.system.length}): ${result.system.join(', ') || '(none)'}`);
console.log(`\nMISSING (${result.missing.length}): ${result.missing.join(', ') || '(none)'}`);
if (result.missing.length) process.exitCode = 1;
