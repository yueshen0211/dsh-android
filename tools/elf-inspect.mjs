// Minimal ELF64 reader: reports the PT_INTERP, the DT_NEEDED list, and
// DT_RPATH/DT_RUNPATH of a shared object or PIE executable.
//
// Used to decide how a prebuilt Android `node` / `libnode.so` can be loaded:
// an executable's interpreter decides whether the Android dynamic linker will
// run it, and the NEEDED list decides which supporting .so files must ship
// alongside it.
//
// Usage: node tools/elf-inspect.mjs <path-to-elf> [--dump-needed-only]

import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) { console.error('usage: node elf-inspect.mjs <elf>'); process.exit(2); }

const buf = readFileSync(path);
const out = { path, sizeMB: +(buf.length / 1048576).toFixed(1) };

if (buf.readUInt32BE(0) !== 0x7f454c46) { console.error('not an ELF file'); process.exit(1); }
const is64 = buf[4] === 2;
const little = buf[5] === 1;
if (!is64 || !little) { console.error(`unsupported ELF: class=${buf[4]} data=${buf[5]}`); process.exit(1); }

out.type = buf.readUInt16LE(16);      // 2=EXEC, 3=DYN
out.typeName = { 2: 'EXEC', 3: 'DYN(PIE/shared)' }[out.type] ?? `other(${out.type})`;
out.machine = buf.readUInt16LE(18);   // 183 = AArch64
out.machineName = { 183: 'AArch64', 62: 'x86-64', 40: 'ARM' }[out.machine] ?? `other(${out.machine})`;

const ePhoff = Number(buf.readBigUInt64LE(32));
const ePhentsize = buf.readUInt16LE(54);
const ePhnum = buf.readUInt16LE(56);

let dynamicOffset = null, dynamicSize = 0;
const segments = [];
for (let i = 0; i < ePhnum; i++) {
  const off = ePhoff + i * ePhentsize;
  const pType = buf.readUInt32LE(off);
  const pOffset = Number(buf.readBigUInt64LE(off + 8));
  const pVaddr = Number(buf.readBigUInt64LE(off + 16));
  const pFilesz = Number(buf.readBigUInt64LE(off + 32));
  segments.push({ pType, pOffset, pVaddr, pFilesz });
  if (pType === 2 && pFilesz > 0) { // PT_DYNAMIC
    dynamicOffset = pOffset; dynamicSize = pFilesz;
  }
}

// PT_INTERP = 3 -> the program interpreter the kernel hands the binary to.
const interp = segments.find((s) => s.pType === 3);
if (interp) {
  out.interpreter = buf.toString('utf8', interp.pOffset, interp.pOffset + interp.pFilesz).replace(/\0+$/, '');
} else {
  out.interpreter = null; // statically linked, or a plain shared library
}

// Walk .dynamic: read the string table address first, then resolve names.
const entries = [];
if (dynamicOffset !== null) {
  for (let o = dynamicOffset; o < dynamicOffset + dynamicSize; o += 16) {
    const tag = Number(buf.readBigUInt64LE(o));
    const val = Number(buf.readBigUInt64LE(o + 8));
    entries.push({ tag, val });
    if (tag === 0) break;
  }
}
const strtabVaddr = entries.find((e) => e.tag === 5)?.val;   // DT_STRTAB
const strtabSeg = segments.find((s) => s.pType === 1 && strtabVaddr >= s.pVaddr && strtabVaddr < s.pVaddr + s.pFilesz);
const readStr = (off) => {
  if (strtabSeg === undefined) return '';
  // DT_STRTAB holds a VIRTUAL address; convert to a file offset through the
  // containing PT_LOAD segment: fileOff = segOff + (vaddr - segVaddr).
  const at = strtabSeg.pOffset + (strtabVaddr + off - strtabSeg.pVaddr);
  if (at < 0 || at >= buf.length) return '';
  let end = at;
  while (end < buf.length && buf[end] !== 0) end++;
  return buf.toString('utf8', at, end);
};

out.needed = entries.filter((e) => e.tag === 1).map((e) => readStr(e.val));       // DT_NEEDED
const rpath = entries.find((e) => e.tag === 15)?.val;                              // DT_RPATH
const runpath = entries.find((e) => e.tag === 29)?.val;                            // DT_RUNPATH
out.rpath = rpath !== undefined ? readStr(rpath) : null;
out.runpath = runpath !== undefined ? readStr(runpath) : null;
out.soname = (() => { const s = entries.find((e) => e.tag === 14); return s ? readStr(s.val) : null; })();

if (process.argv.includes('--dump-needed-only')) {
  console.log(out.needed.join('\n'));
} else {
  console.log(JSON.stringify(out, null, 2));
}
