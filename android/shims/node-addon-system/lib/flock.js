// Android implementation of `@deepseek-ai/node-addon-system/flock`.
//
// WHY THIS EXISTS
//
// `dsh-session-persistence-jsonl` takes a non-blocking exclusive `flock(2)` on
// each session directory's `session.lock` to claim write ownership, and calls it
// immediately before a created session's first materializing write. On Android
// the upstream entry refuses before it ever reaches the kernel:
//
//   if (platform !== 'linux' && platform !== 'darwin') {
//     throw Object.assign(new Error(`flock is not supported on ${platform}-${arch}`),
//       { code: 'ERR_FLOCK_UNSUPPORTED_PLATFORM', syscall: 'flock' });
//   }
//
// Node reports `process.platform === 'android'` for this runtime (verified on
// device: platform='android', arch='arm64'), so the guard rejects, `acquire`
// rethrows, and every run fails with "flock is not supported on android-arm64".
// The lock is not optional: `acquireWriteLease` is a required step of creating a
// session, so this is not a degraded feature -- it is every run.
//
// Two things make a real implementation possible rather than a stub:
//
//   1. Android's bionic libc *does* provide flock(2), and the kernel semantics
//      are correct there. Verified on device: a second descriptor on the same
//      inode returns -1/EAGAIN (errno 11), and closing the first descriptor
//      releases the lock so the next acquisition succeeds.
//   2. The engine tree already ships Koffi, a working Android arm64 FFI, so
//      reaching libc needs no native build step and no extra artifact.
//
// The alternative -- stubbing the lock to immediate success, which is what the
// upstream browser worker does because it is single-process -- was rejected: a
// real lock costs nothing here and stays correct if the engine is ever run as
// more than one process against the same sessions directory.
//
// INTERFACE
//
// Matches upstream exactly, so it is a drop-in for the shipped import:
//   tryLockExclusive(fd): Promise<void>
// resolves on acquisition; rejects with { code, errno, syscall: 'flock' } on
// contention (EAGAIN/EWOULDBLOCK) or any other syscall failure.
//
// The caller owns `fd`; this module never opens, duplicates, closes or explicitly
// unlocks it, exactly as documented upstream. Closing the descriptor releases the
// lock.
//
// `LOCK_EX | LOCK_NB` is non-blocking by definition, so the call cannot stall the
// event loop. The upstream native binding runs the same syscall on a thread pool
// for the same reason it passes `LOCK_NB`; calling it synchronously here is
// observationally equivalent and keeps this file dependency-free.

import { createRequire } from 'node:module';
import { getSystemErrorName } from 'node:util';

const LOCK_EX = 2; // <sys/file.h>
const LOCK_NB = 4;

let binding = null;

function load() {
  if (binding) return binding;
  // `require`, not `import`: Koffi is CommonJS and this module is ESM. Koffi is
  // already a hard dependency of this package in the engine tree.
  const koffi = createRequire(import.meta.url)('koffi');
  // Bare soname resolution: bionic on Android, and the right libc name on any
  // other platform this shim is ever staged for.
  const libc = koffi.load('libc.so');
  binding = { flock: libc.func('int flock(int fd, int operation)'), koffi };
  return binding;
}

/**
 * Attempt an exclusive, non-blocking POSIX flock on the caller's descriptor.
 * @param {number} fd - Open file descriptor to lock; ownership remains with the caller.
 * @returns {Promise<void>} Resolves on acquisition.
 */
export async function tryLockExclusive(fd) {
  const { flock, koffi } = load();
  if (flock(fd, LOCK_EX | LOCK_NB) === 0) return;
  // Read errno on the very next statement: it belongs to the call above, and any
  // intervening libc call of our own could overwrite it.
  const errno = koffi.errno();
  const code = getSystemErrorName(-errno);
  throw Object.assign(new Error(`${code}: flock failed`), {
    code,
    errno,
    syscall: 'flock',
  });
}
