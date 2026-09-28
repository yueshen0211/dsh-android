// Patch ELF DT_NEEDED strings in place.
//
// Why this is needed: Android's package manager only extracts native library
// entries whose names match `lib*.so` from the APK. Versioned sonames
// (`libz.so.1`, `libcrypto.so.3`, `libicuuc.so.78`, ...) are dropped, so the
// dynamic linker cannot resolve a DT_NEEDED entry that names them, and the
// process fails with:
//
//   CANNOT LINK EXECUTABLE: library "libz.so.1" not found: needed by main executable
//
// Shipping duplicate files under the versioned names does not help, because the
// filter is applied at install time. The alternative used here is to rewrite the
// DT_NEEDED strings to the unversioned names that do ship.
//
// Safety: the replacement must be strictly shorter than the original so the
// string table entry keeps its size and every ELF offset, section header and
// dynamic hash stays valid. The remainder is NUL-padded. A candidate occurrence
// is only accepted when it is followed by a NUL byte, which is what makes it a
// whole string-table entry rather than a substring of some longer name.
//
// Usage: node tools/elf-patch-needed.mjs <elf> [--json out.json]

import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const path = args[0];
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
if (!path) {
  console.error('usage: elf-patch-needed.mjs <elf> [--json out.json]');
  process.exit(2);
}

/** Versioned soname -> the unversioned name that actually ships in the APK. */
const REWRITES = [
  ['libz.so.1', 'libz.so'],
  ['libcrypto.so.3', 'libcrypto.so'],
  ['libssl.so.3', 'libssl.so'],
  ['libicui18n.so.78', 'libicui18n.so'],
  ['libicuuc.so.78', 'libicuuc.so'],
  ['libicudata.so.78', 'libicudata.so'],
];

const buf = readFileSync(path);
const report = { path, applied: [], skipped: [] };

for (const [from, to] of REWRITES) {
  if (Buffer.byteLength(to) >= Buffer.byteLength(from)) {
    throw new Error(`replacement "${to}" is not shorter than "${from}"; in-place patching would corrupt the ELF`);
  }
  const needle = Buffer.from(from + '\0', 'ascii');
  let offset = 0;
  let patched = 0;
  for (;;) {
    const at = buf.indexOf(needle, offset);
    if (at < 0) break;
    buf.write(to, at, 'ascii');
    // NUL-pad the remainder so the entry keeps its original length.
    buf.fill(0, at + Buffer.byteLength(to), at + Buffer.byteLength(from));
    patched++;
    offset = at + needle.length;
  }
  if (patched > 0) report.applied.push({ from, to, occurrences: patched });
  else report.skipped.push({ from, to });
}

writeFileSync(path, buf);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));
for (const r of report.applied) console.log(`  DT_NEEDED ${r.from} -> ${r.to} (${r.occurrences} occurrence(s))`);
for (const r of report.skipped) console.log(`  DT_NEEDED ${r.from} not present (already unversioned)`);
