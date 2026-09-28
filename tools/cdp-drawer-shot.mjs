// Open the mobile shell's drawer with the same pointer sequence a finger
// produces, then capture the screen while it is open.
//
// cdp-shot.mjs clicks a button by text; the drawer opens from an edge swipe, so
// it needs its own script. The connection is held across the capture because the
// drawer state lives in the page.
//
// Usage: node tools/cdp-drawer-shot.mjs <wsUrlFile> <outPng> <adbPath> <serial>

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const [urlFile, outPng, adbPath, serial] = process.argv.slice(2);
if (!urlFile || !outPng) {
  console.error('usage: cdp-drawer-shot.mjs <wsUrlFile> <outPng> [adbPath] [serial]');
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
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' timed out')); } }, 20000);
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

ws.addEventListener('open', async () => {
  const remote = '/sdcard/dsh-drawer.png';
  try {
    await send('Runtime.enable');

    // Swipe in from the left edge: press inside the 24px zone, move right past
    // the 36px threshold, release. The gesture requires horizontal dominance.
    await evaluate(`(() => {
      const fire = (type, x, y) => document.dispatchEvent(new PointerEvent(type, {
        clientX: x, clientY: y, bubbles: true, pointerType: 'touch', isPrimary: true,
      }));
      fire('pointerdown', 8, 520);
      fire('pointermove', 34, 522);
      fire('pointermove', 78, 524);
      fire('pointerup', 78, 524);
      return true;
    })()`);

    // Let the drawer settle, then confirm before capturing.
    await new Promise((r) => setTimeout(r, 700));
    const state = await evaluate(`(() => {
      const s = document.querySelector("[class*='_sidebarCol']").getBoundingClientRect();
      return { x: Math.round(s.x), onScreen: s.right > 1, open: document.querySelector("[class*='_frame']").hasAttribute('data-dsh-mobile-open') };
    })()`);
    console.log('drawer state:', JSON.stringify(state));
    if (!state.open || !state.onScreen) throw new Error('drawer did not open; not capturing');

    execFileSync(adb, adbArgs(['shell', 'screencap', '-p', remote]), { stdio: 'ignore' });
    execFileSync(adb, adbArgs(['pull', remote, outPng]), { stdio: 'ignore' });
    execFileSync(adb, adbArgs(['shell', 'rm', remote]), { stdio: 'ignore' });

    const bytes = readFileSync(outPng);
    const isPng = bytes[0] === 0x89 && bytes.toString('latin1', 1, 4) === 'PNG';
    console.log(`captured: ${outPng} (${bytes.length} bytes, png=${isPng})`);
  } catch (error) {
    console.error('FAILED:', error.message);
    process.exitCode = 1;
  } finally {
    ws.close();
  }
});
ws.addEventListener('error', (e) => { console.error('websocket error:', e.message ?? e.type); process.exitCode = 1; });
