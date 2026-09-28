// Focus the on-device composer with a real tap, then capture and measure the
// settled keyboard state.
//
// Tapping matters here: `element.focus()` from the console does NOT raise the
// Android system keyboard, so a focus-based probe misses the very thing under
// test. A dispatched mouse event goes through the same path a finger does.
//
// Usage: node tools/cdp-keyboard.mjs <wsUrlFile> <outPng> <adbPath> <serial>

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const [urlFile, outPng, adbPath, serial] = process.argv.slice(2);
if (!urlFile || !outPng) {
  console.error('usage: cdp-keyboard.mjs <wsUrlFile> <outPng> [adbPath] [serial]');
  process.exit(2);
}
const wsUrl = readFileSync(urlFile, 'utf8').trim();
const adb = adbPath ?? 'adb';
const adbArgs = (rest) => (serial ? ['-s', serial, ...rest] : rest);

const ws = new WebSocket(wsUrl);
let nextId = 1;
const pending = new Map();
const send = (method, params = {}) => {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' timed out')); } }, 30000);
  });
};
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'threw');
  return r.result?.value;
};
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
  }
});

// What we care about: is the composer still fully visible once the keyboard is up?
const MEASURE = `JSON.stringify((() => {
  const vv = window.visualViewport;
  const seat = document.querySelector('[class*=composerSeat]');
  const r = seat ? seat.getBoundingClientRect() : null;
  return {
    innerH: innerHeight,
    visualH: vv ? Math.round(vv.height) : null,
    visualOffsetTop: vv ? Math.round(vv.offsetTop) : null,
    keyboardHeight: vv ? Math.round(innerHeight - vv.height) : null,
    composerTop: r ? Math.round(r.top) : null,
    composerBottom: r ? Math.round(r.bottom) : null,
    composerHiddenBy: r && vv ? Math.max(0, Math.round(r.bottom - (vv.height + vv.offsetTop))) : null,
    scrollY: Math.round(scrollY),
  };
})())`;

ws.addEventListener('open', async () => {
  const remote = '/sdcard/dsh-kb.png';
  try {
    await send('Runtime.enable');
    console.log('closed  :', await evaluate(MEASURE));

    const target = await evaluate(`(() => {
      const el = document.querySelector('[contenteditable="true"]');
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    })()`);
    if (!target) throw new Error('no composer found');

    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {
        type, x: target.x, y: target.y, button: 'left',
        buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, pointerType: 'mouse',
      });
      await new Promise((r) => setTimeout(r, 80));
    }

    // The keyboard animates in; sample until it settles.
    let last = null;
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 500));
      last = JSON.parse(await evaluate(MEASURE));
      if (last.keyboardHeight > 100) break;
    }
    console.log('open    :', last);

    if (adbPath) {
      execFileSync(adb, adbArgs(['shell', 'screencap', '-p', remote]), { stdio: 'ignore' });
      execFileSync(adb, adbArgs(['pull', remote, outPng]), { stdio: 'ignore' });
      execFileSync(adb, adbArgs(['shell', 'rm', remote]), { stdio: 'ignore' });
      const bytes = readFileSync(outPng);
      const isPng = bytes[0] === 0x89 && bytes.toString('latin1', 1, 4) === 'PNG';
      console.log(`captured: ${outPng} (${bytes.length} bytes, png=${isPng})`);
    }
  } catch (error) {
    console.error('FAILED:', error.message);
    process.exitCode = 1;
  } finally {
    ws.close();
  }
});
ws.addEventListener('error', (e) => { console.error('websocket error:', e.message ?? e.type); process.exitCode = 1; });
