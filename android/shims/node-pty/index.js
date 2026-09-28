/**
 * Android stand-in for `node-pty`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `@deepseek-ai/dsh-subprocess-local` imports node-pty statically:
 *
 *     import * as nodePty from "node-pty";
 *
 * node-pty is a native addon and ships no `prebuilds/android-arm64`, so on
 * Android the import fails while the plugin tree is still being constructed and
 * the whole engine refuses to boot:
 *
 *     Failed to load native module: pty.node, checked: build/Release,
 *     build/Debug, prebuilds/android-arm64
 *
 * This module keeps the engine loadable by providing the surface node-pty
 * exposes (`spawn`, `fork`, `createTerminal`, `open`, `native`) on top of
 * `child_process.spawn` with pipes.
 *
 * WHAT IT IS NOT
 * --------------
 * This is NOT a pty. A real pty gives a process a controlling terminal, which is
 * what line editing, job control, SIGWINCH and `isatty()` depend on. Pipes
 * provide none of that, so:
 *
 *   * `resize` cannot work and is a no-op that reports failure;
 *   * interactive terminal sessions behave like a non-interactive pipeline;
 *   * programs that check `isatty()` take their non-interactive path.
 *
 * In the shipped `web` profile this costs nothing observable: the `terminal` row
 * is not mounted and both shell tools (`tool-bash`, `tool-pwsh`) are disabled, so
 * `spawn` is never reached. It matters only if a mobile profile later mounts
 * terminal or shell rows, and then the honest fix is an arm64 node-pty build
 * rather than this file.
 *
 * The shim also exports `UNAVAILABLE_REASON` so callers can surface a precise
 * explanation instead of a generic failure.
 */
'use strict';

const { spawn: childSpawn } = require('node:child_process');

const UNAVAILABLE_REASON =
  'node-pty has no android-arm64 build; this is a child_process-backed shim ' +
  'without pty semantics (no controlling terminal, no resize)';

/** node-pty's IPty is an EventEmitter with a handful of methods. */
function makeHandle(child) {
  const listeners = { data: [], exit: [] };
  let exitEmitted = false;

  const emitExit = (exitCode, signal) => {
    if (exitEmitted) return;
    exitEmitted = true;
    const event = { exitCode: exitCode === null ? 0 : exitCode, signal: signal === undefined ? 0 : signal };
    for (const listener of listeners.exit) {
      try { listener(event); } catch { /* a listener must not break the handle */ }
    }
  };

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    for (const listener of listeners.data) {
      try { listener(text); } catch { /* ignore */ }
    }
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    for (const listener of listeners.data) {
      try { listener(text); } catch { /* ignore */ }
    }
  });
  child.on('exit', (code, signal) => emitExit(code, signal));
  child.on('error', () => emitExit(1, 0));

  return {
    pid: child.pid,
    process: child.spawnfile,
    handle: child,
    onData(listener) {
      listeners.data.push(listener);
      return {
        dispose() {
          const at = listeners.data.indexOf(listener);
          if (at >= 0) listeners.data.splice(at, 1);
        },
      };
    },
    onExit(listener) {
      listeners.exit.push(listener);
      return {
        dispose() {
          const at = listeners.exit.indexOf(listener);
          if (at >= 0) listeners.exit.splice(at, 1);
        },
      };
    },
    write(data) {
      if (child.stdin && !child.stdin.destroyed) child.stdin.write(data);
    },
    resize() {
      // No controlling terminal, so there is no winsize to update.
      return false;
    },
    kill(signal) {
      return child.kill(signal || 'SIGTERM');
    },
    pause() {
      child.stdout.pause();
      child.stderr.pause();
    },
    resume() {
      child.stdout.resume();
      child.stderr.resume();
    },
    clear() {
      // Nothing to clear: there is no terminal screen buffer.
    },
  };
}

function spawn(file, args, options) {
  const opts = options || {};
  if (typeof file !== 'string' || file.length === 0) {
    throw new Error('node-pty shim: spawn requires a command');
  }
  const child = childSpawn(file, Array.isArray(args) ? args : [], {
    cwd: opts.cwd,
    env: opts.env,
    // `pty` semantics are unavailable; pipes are the closest equivalent.
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return makeHandle(child);
}

function fork(file, args, options) {
  return spawn(file, args, options);
}

function createTerminal() {
  throw new Error(`createTerminal is unavailable: ${UNAVAILABLE_REASON}`);
}

function open() {
  throw new Error(`open is unavailable: ${UNAVAILABLE_REASON}`);
}

exports.spawn = spawn;
exports.fork = fork;
exports.createTerminal = createTerminal;
exports.open = open;
// node-pty sets this to the loaded native module on non-Windows platforms.
// There is no native module here, so it stays null.
exports.native = null;
exports.UNAVAILABLE_REASON = UNAVAILABLE_REASON;
