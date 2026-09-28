// Add native libraries to an APK under `lib/<abi>/<name>`, stored uncompressed.
//
// aapt2 does not package jniLibs (that is an AGP feature), and `jar` cannot
// place entries into a subdirectory, so the archive is assembled here.
//
// Entries are written with method 0 (stored) because Android can then mmap the
// .so straight out of the APK instead of extracting it, and because the
// dynamic linker must be able to map it: a compressed entry would force
// extraction into a directory that is not guaranteed executable.
// `zipalign` afterwards fixes the alignment those stored entries need.
//
// Usage: node zip-add-nativelibs.mjs <apk> <jniLibsRoot> [<extraAbiDir>...]

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const [apkPath, jniRoot, ...extraDirs] = process.argv.slice(2);
if (!apkPath) {
  console.error('usage: zip-add-nativelibs.mjs <apk> <jniLibsRoot> [abiDir...]');
  process.exit(2);
}

// ---- collect abi -> [{ name, data }] ---------------------------------------
const abis = new Map();
const addAbiDir = (dir, abiName) => {
  const abi = abiName ?? basename(dir);
  let entries = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (!name.endsWith('.so')) continue;
    const full = join(dir, name);
    try { if (!statSync(full).isFile()) continue; } catch { continue; }
    if (!abis.has(abi)) abis.set(abi, []);
    abis.get(abi).push({ name, data: readFileSync(full) });
  }
};

if (jniRoot) {
  let abiDirs = [];
  try { abiDirs = readdirSync(jniRoot); } catch { /* no jniLibs */ }
  for (const d of abiDirs) {
    const full = join(jniRoot, d);
    try { if (statSync(full).isDirectory()) addAbiDir(full, d); } catch { /* skip */ }
  }
}
for (const d of extraDirs) addAbiDir(d);

const libEntries = [];
for (const [abi, files] of abis) {
  for (const f of files) libEntries.push({ path: `lib/${abi}/${f.name}`, data: f.data });
}
if (libEntries.length === 0) {
  console.log('   no native libraries to add');
  process.exit(0);
}

// ---- parse the existing zip -------------------------------------------------
const buf = readFileSync(apkPath);
const existing = new Map(); // name -> {method, crc, compSize, uncompSize, flags, data}
let eocd = -1;
for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) throw new Error('not a zip: End Of Central Directory not found');

const cdCount = buf.readUInt16LE(eocd + 10);
let cdOffset = buf.readUInt32LE(eocd + 16);
let cdSize = buf.readUInt32LE(eocd + 12);

let p = cdOffset;
for (let i = 0; i < cdCount; i++) {
  if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central directory entry at ${p}`);
  const flags = buf.readUInt16LE(p + 8);
  const method = buf.readUInt16LE(p + 10);
  const crc = buf.readUInt32LE(p + 16);
  const compSize = buf.readUInt32LE(p + 20);
  const uncompSize = buf.readUInt32LE(p + 24);
  const nameLen = buf.readUInt16LE(p + 28);
  const extraLen = buf.readUInt16LE(p + 30);
  const commentLen = buf.readUInt16LE(p + 32);
  const localOffset = buf.readUInt32LE(p + 42);
  const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
  // Normalize separators. aapt2 on Windows writes asset entry names with the
  // host separator ("assets/engine\@scope\pkg\file"), which is legal in a zip
  // but unusable on Android: AssetManager walks the archive by splitting names
  // on '/', so a backslash-separated tree is invisible to open()/list() and the
  // app would find no assets at all.
  const normalized = name.indexOf('\\') === -1 ? name : name.replace(/\\/g, '/');

  // Local header: 30 bytes + name + extra, then the data.
  const lnLen = buf.readUInt16LE(localOffset + 26);
  const leLen = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + lnLen + leLen;
  existing.set(normalized, { flags, method, crc, compSize, uncompSize, data: buf.subarray(dataStart, dataStart + compSize) });
  p += 46 + nameLen + extraLen + commentLen;
}
// Locate the start of the local-header region from the first entry, so any
// prefix the toolchain left in place is preserved verbatim.
let prefixEnd = null;
for (const [name, e] of existing) {
  if (name === libEntries[0]?.path) continue;
  // recompute this entry's local header offset is unnecessary; use min offset
}
let minLocal = Infinity;
{
  let q = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    const localOffset = buf.readUInt32LE(q + 42);
    if (localOffset < minLocal) minLocal = localOffset;
    const nameLen = buf.readUInt16LE(q + 28);
    const extraLen = buf.readUInt16LE(q + 30);
    const commentLen = buf.readUInt16LE(q + 32);
    q += 46 + nameLen + extraLen + commentLen;
  }
}
prefixEnd = minLocal;

// ---- rebuild the archive ----------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(data) {
  let c = 0 ^ -1;
  for (let i = 0; i < data.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ data[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

const chunks = [buf.subarray(0, prefixEnd)];
const records = []; // for the new central directory
const allEntries = [];

// Keep existing entries, dropping any stale lib/ copies of what we add.
const addPaths = new Set(libEntries.map((e) => e.path));
for (const [name, e] of existing) {
  if (addPaths.has(name)) continue;
  allEntries.push({ path: name, keep: e });
}
for (const e of libEntries) allEntries.push({ path: e.path, fresh: e });

let offset = prefixEnd;
for (const entry of allEntries) {
  const nameBytes = Buffer.from(entry.path, 'utf8');
  const data = entry.keep ? entry.keep.data : entry.fresh.data;
  const crc = entry.keep ? entry.keep.crc : crc32(data);
  const method = entry.keep ? entry.keep.method : 0;
  const compSize = data.length;
  const uncompSize = entry.keep ? entry.keep.uncompSize : data.length;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);          // flags: no UTF-8 marker needed for these names
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(0, 10);         // time
  local.writeUInt16LE(0x21, 12);      // date (1980-01-01), deterministic
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compSize, 18);
  local.writeUInt32LE(uncompSize, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28);

  chunks.push(local, nameBytes, data);
  records.push({ nameBytes, method, crc, compSize, uncompSize, offset });
  offset += local.length + nameBytes.length + data.length;
}

const cdStart = offset;
const cdChunks = [];
for (const r of records) {
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);            // version made by
  cd.writeUInt16LE(20, 6);            // version needed
  cd.writeUInt16LE(0, 8);
  cd.writeUInt16LE(r.method, 10);
  cd.writeUInt16LE(0, 12);
  cd.writeUInt16LE(0x21, 14);
  cd.writeUInt32LE(r.crc, 16);
  cd.writeUInt32LE(r.compSize, 20);
  cd.writeUInt32LE(r.uncompSize, 24);
  cd.writeUInt16LE(r.nameBytes.length, 28);
  cd.writeUInt16LE(0, 30);
  cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34);
  cd.writeUInt16LE(0, 36);
  cd.writeUInt32LE(0, 38);
  cd.writeUInt32LE(r.offset, 42);
  cdChunks.push(cd, r.nameBytes);
  offset += cd.length + r.nameBytes.length;
}
const cdBytes = Buffer.concat(cdChunks);

const eocdBuf = Buffer.alloc(22);
eocdBuf.writeUInt32LE(0x06054b50, 0);
eocdBuf.writeUInt16LE(0, 4);
eocdBuf.writeUInt16LE(0, 6);
eocdBuf.writeUInt16LE(records.length, 8);
eocdBuf.writeUInt16LE(records.length, 10);
eocdBuf.writeUInt32LE(cdBytes.length, 12);
eocdBuf.writeUInt32LE(cdStart, 16);
eocdBuf.writeUInt16LE(0, 20);

writeFileSync(apkPath, Buffer.concat([...chunks, cdBytes, eocdBuf]));

const normalizedCount = [...existing.keys()].filter((k) => k.includes('/')).length;
const totalMb = (libEntries.reduce((a, e) => a + e.data.length, 0) / 1048576).toFixed(1);
console.log(`   repacked ${existing.size} entries (separators normalized) + ${libEntries.length} native lib(s) across ${abis.size} abi(s), ${totalMb} MB stored`);
