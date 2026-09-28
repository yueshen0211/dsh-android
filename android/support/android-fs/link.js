// Android stand-in for the one POSIX call the session store cannot use as-is.
//
// WHY
//
// `dsh-session-persistence-jsonl` publishes a new session log with
// `link(tmp, final)`, chosen deliberately over `rename`: link refuses to clobber
// an existing file (EEXIST), which is the no-overwrite guarantee for "create a
// session, never overwrite one". `rejectExistingLog` is only a cheaper pre-check.
//
// Android refuses the hardlink outright, for ANY destination in app storage --
// including one that does not exist:
//
//   EACCES: permission denied, link '.../session.v3.jsonl.zstd.<rand>.tmp'
//                                 -> '.../session.v3.jsonl.zstd'
//
// Verified on the device: link() to a fresh path returns EACCES, and so does
// link() to an existing path, so this is not a collision or a TOCTOU race. rename()
// on the same directory succeeds but CLOBBERS, which is exactly the hazard link
// was chosen to avoid. The mount is ordinary f2fs (`nosuid,nodev`, no noexec), so
// the refusal comes from the platform, not from a filesystem limitation.
//
// WHAT
//
// renameat2(2) with RENAME_NOREPLACE is the same operation without a hardlink:
// it publishes atomically and fails with EEXIST when the destination exists.
// Node's fs API does not expose it (`constants.RENAME_NOREPLACE` is undefined),
// and Koffi -- already in this tree for the flock binding -- reaches libc directly.
//
// Verified on the device, matching link()'s contract on every point that matters:
//   fresh destination      -> rc 0, content intact, tmp consumed
//   existing destination   -> rc -1, errno 17 EEXIST, destination preserved,
//                             tmp left in place (so the caller's cleanup runs)
//
// Koffi is resolved lazily so importing this module never loads a native binding.

import { createRequire } from 'node:module';

// <fcntl.h>: AT_FDCWD is the "relative to the working directory" dirfd.
const AT_FDCWD = -100;
// <linux/fs.h>
const RENAME_NOREPLACE = 1;

let renameat2 = null;

function binding() {
  if (renameat2) return renameat2;
  const koffi = createRequire(import.meta.url)('koffi');
  const libc = koffi.load('libc.so');
  renameat2 = libc.func(
    'int renameat2(int olddirfd, const char *oldpath, int newdirfd, const char *newpath, unsigned int flags)',
  );
  return renameat2;
}

/**
 * Publish `from` at `to` atomically, failing when `to` already exists.
 *
 * A drop-in for `fsPromises.link` as the session store uses it: it never
 * overwrites, and on success the source name is consumed (rename, not link, so
 * no second name survives for the caller to clean up).
 *
 * @param {string} from - Source path (the synced temporary file).
 * @param {string} to - Destination path that must not already exist.
 * @returns {Promise<void>} Resolves on publish; rejects with EEXIST on collision.
 */
export async function link(from, to) {
  const rc = binding()(AT_FDCWD, from, AT_FDCWD, to, RENAME_NOREPLACE);
  if (rc === 0) return;
  const koffi = createRequire(import.meta.url)('koffi');
  const errno = koffi.errno();
  const { getSystemErrorName } = await import('node:util');
  const code = getSystemErrorName(-errno);
  // Shape the error like Node's own: callers branch on `code`, and the session
  // store's rejectExistingLog / collision handling only ever looks at that.
  throw Object.assign(new Error(`${code}: ${code.toLowerCase()}, link '${from}' -> '${to}'`), {
    errno,
    code,
    syscall: 'link',
    path: from,
    dest: to,
  });
}
