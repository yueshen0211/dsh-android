// Type into the composer and submit, so the run path can be observed.
//
// Usage: node tools/cdp-send.mjs <wsUrlFile> "<text>"

import { readFileSync } from 'node:fs';

const [urlFile, text] = process.argv.slice(2);
if (!urlFile || !text) {
  console.error('usage: cdp-send.mjs <wsUrlFile> "<text>"');
  process.exit(2);
}
const wsUrl = readFileSync(urlFile, 'utf8').trim();

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
const evaluate = async (expression, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
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
  try {
    await send('Runtime.enable');

    // Dismiss any blocking modal first: it leaves the page present but
    // unreachable, so a click would silently do nothing.
    const modal = await evaluate(`
      (() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const b = btns.find(x => ['继续','稍后配置'].includes((x.textContent||'').trim()));
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { text: b.textContent.trim(), x: r.x + r.width/2, y: r.y + r.height/2 };
      })()
    `);
    if (modal) {
      console.log('dismissing modal:', modal.text);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: modal.x, y: modal.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, pointerType: 'mouse' });
        await new Promise((r) => setTimeout(r, 60));
      }
      await new Promise((r) => setTimeout(r, 1500));
    }

    // React tracks its own value on the input, so setting .value directly is
    // ignored. Use the native setter, then dispatch a bubbling input event.
    const composer = await evaluate(`
      (() => {
        const el = document.querySelector('textarea') ||
                   document.querySelector('[contenteditable="true"]') ||
                   document.querySelector('input[type=text]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { tag: el.tagName, contentEditable: el.isContentEditable, x: r.x + r.width/2, y: r.y + r.height/2 };
      })()
    `);
    if (!composer) { console.log('no composer found'); ws.close(); return; }
    console.log('composer:', composer.tag, composer.contentEditable ? '(contenteditable)' : '');

    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: composer.x, y: composer.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, pointerType: 'mouse' });
      await new Promise((r) => setTimeout(r, 60));
    }
    await new Promise((r) => setTimeout(r, 400));

    // React tracks its own value on the input, so assigning .value/.textContent
    // is ignored by the component. Input.insertText goes through the same path a
    // real keyboard does, so the framework sees an ordinary edit.
    await evaluate(`
      (() => {
        const el = document.querySelector('textarea') ||
                   document.querySelector('[contenteditable="true"]') ||
                   document.querySelector('input[type=text]');
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return true;
      })()
    `);
    await send('Input.insertText', { text });
    await new Promise((r) => setTimeout(r, 800));

    const echo = await evaluate(`
      (() => {
        const el = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]');
        return el ? (el.value ?? el.textContent) : null;
      })()
    `);
    console.log('composer now contains:', JSON.stringify(echo).slice(0, 80));

    // Submit with Enter (the composer sends on Enter, newline on Shift+Enter).
    await send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
    console.log('submitted (Enter)');

    await new Promise((r) => setTimeout(r, 4000));
    console.log('body text after submit:', JSON.stringify(await evaluate('document.body.innerText.slice(0,600)')));
  } catch (error) {
    console.error('FAILED:', error.message);
    process.exitCode = 1;
  } finally {
    ws.close();
  }
});
ws.addEventListener('error', () => { console.error('websocket error'); process.exitCode = 1; });
