// Open a dropdown and capture the device screen while it is still open.
//
// The panel closes as soon as the CDP client disconnects, so "click, then
// screenshot" never works across two separate commands. This script keeps the
// connection alive, clicks, runs `adb shell screencap` while the panel is up,
// then closes.
//
// Usage: node tools/cdp-shot.mjs <wsUrlFile> "<button text>" <deviceSerial> <outPng>

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const [urlFile, targetText, serial, outPng] = process.argv.slice(2);
if (!urlFile || !targetText || !serial || !outPng) {
  console.error('usage: cdp-shot.mjs <wsUrlFile> "<button text>" <serial> <outPng>');
  process.exit(2);
}
const wsUrl = readFileSync(urlFile, 'utf8').trim();
const adb = process.env.DSH_ADB || 'adb';
const adbArgs = (rest) => ['-s', serial, ...rest];

const ws = new WebSocket(wsUrl);
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' timed out')); } }, 20000);
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'threw');
  return r.result?.value;
}
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
  }
});

ws.addEventListener('open', async () => {
  const remote = '/sdcard/dsh-cdp-shot.png';
  try {
    await send('Runtime.enable');

    const target = await evaluate(`
      (() => {
        const want = ${JSON.stringify(targetText)};
        const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes(want));
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()
    `);
    if (!target) { console.log('button not found'); ws.close(); return; }

    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {
        type, x: target.x, y: target.y, button: 'left',
        buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, pointerType: 'mouse',
      });
      await new Promise((r) => setTimeout(r, 60));
    }
    await new Promise((r) => setTimeout(r, 1200));

    const state = await evaluate(`
      (() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes(${JSON.stringify(targetText)}));
        return { ariaExpanded: btn ? btn.getAttribute('aria-expanded') : null };
      })()
    `);
    console.log('aria-expanded after tap =', state.ariaExpanded);

    // screencap to a file on the device, then pull it: `adb exec-out` through a
    // shell pipe corrupts binary data under PowerShell redirection.
    execFileSync(adb, adbArgs(['shell', 'screencap', '-p', remote]), { stdio: 'inherit' });
    execFileSync(adb, adbArgs(['pull', remote, outPng]), { stdio: 'inherit' });
    execFileSync(adb, adbArgs(['shell', 'rm', remote]), { stdio: 'inherit' });

    const bytes = readFileSync(outPng);
    const isPng = bytes[0] === 0x89 && bytes.toString('latin1', 1, 4) === 'PNG';
    console.log(`captured ${outPng} (${bytes.length} bytes, png=${isPng})`);
  } catch (error) {
    console.error('FAILED:', error.message);
    process.exitCode = 1;
  } finally {
    ws.close();
  }
});
ws.addEventListener('error', () => { console.error('websocket error'); process.exitCode = 1; });
