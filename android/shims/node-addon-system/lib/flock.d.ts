/**
 * Attempt an exclusive, nonblocking POSIX flock on the caller's descriptor.
 * Keep fd open until the promise settles; this module never opens, duplicates,
 * or closes it. Closing the locked descriptor releases the lock.
 *
 * Android port note: implemented over Koffi calling bionic libc's flock(2),
 * because upstream's entry refuses `process.platform === 'android'` before
 * reaching the kernel and ships no android prebuild. See lib/flock.js.
 * @param fd - Open file descriptor to lock; ownership remains with the caller.
 * @returns A promise resolving to void on acquisition. Contention rejects with
 *   EAGAIN/EWOULDBLOCK; other syscall failures also reject. Syscall errors carry
 *   code, positive errno, and syscall='flock'.
 */
export declare function tryLockExclusive(fd: number): Promise<void>;
