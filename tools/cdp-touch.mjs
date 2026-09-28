// Tap an element with a real touch sequence, then report what changed.
//
// A phone is a touch device: the UI binds pointer events, and on Android WebView
// those come from touch, not from a mouse. Dispatching mouse events at a control
// that expects touch can silently do nothing, which looks exactly like a broken
// handler. This sends touchStart/touchEnd through the input protocol -- the same
// path a finger takes -- and then reports aria-expanded plus any DOM additions.
//
// Usage: node tools/cdp-touch.mjs <wsUrlFile> "<visible text>" [--settle ms]

import { readFileSync } from 'node:fs';

const [urlFile, targetText, ...rest] = process.argv.slice(2);
if (!urlFile || !targetText) {
  console.error('usage: cdp-touch.mjs <wsUrlFile> "<visible text>" [--settle ms]');
  process.exit(2);
}
const settleIndex = rest.indexOf('--settle');
const settleMs = settleIndex >= 0 ? Number(rest[settleIndex + 1]) : 2500;
const wsUrl = readFileSync(urlFile, 'utf8').trim();

const ws = new WebSocket(wsUrl);
let nextId = 1;
const pending = new Map();
const events = [];

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' timed out')); } }, 20000);
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'threw');
  return r.result?.value;
}
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    events.push('[console] ' + (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    events.push('[exception] ' + (m.params.exceptionDetails?.exception?.description ?? ''));
  }
});

ws.addEventListener('open', async () => {
  try {
    await send('Runtime.enable');

    await evaluate(`
      (() => {
        window.__dshAdded = [];
        if (window.__dshObs) window.__dshObs.disconnect();
        window.__dshObs = new MutationObserver((rs) => {
          for (const r of rs) for (const n of r.addedNodes) {
            if (n.nodeType === 1) {
              const b = n.getBoundingClientRect();
              window.__dshAdded.push(n.tagName + ' rect=' + [Math.round(b.x),Math.round(b.y),Math.round(b.width),Math.round(b.height)].join(',') + ' "' + (n.textContent||'').trim().slice(0,80) + '"');
            }
          }
        });
        window.__dshObs.observe(document.body, { childList: true, subtree: true });
        // Record what the element actually receives.
        window.__dshSeen = [];
        return true;
      })()
    `);

    const target = await evaluate(`
      (() => {
        const want = ${JSON.stringify(targetText)};
        const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes(want));
        if (!btn) return null;
        window.__dshSeen = [];
        for (const type of ['pointerdown','pointerup','mousedown','mouseup','click','touchstart','touchend']) {
          btn.addEventListener(type, () => window.__dshSeen.push(type), { once: true });
        }
        const r = btn.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, before: btn.getAttribute('aria-expanded') };
      })()
    `);
    if (!target) { console.log('button not found'); ws.close(); return; }
    console.log(`touch tap at (${target.x.toFixed(0)}, ${target.y.toFixed(0)}), aria-expanded before = ${target.before}`);

    await send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: target.x, y: target.y, radiusX: 6, radiusY: 6, force: 1, id: 1 }],
    });
    await new Promise((r) => setTimeout(r, 90));
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await new Promise((r) => setTimeout(r, settleMs));

    const result = await evaluate(`
      (() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes(${JSON.stringify(targetText)}));
        return {
          after: btn ? btn.getAttribute('aria-expanded') : null,
          receivedEvents: window.__dshSeen,
          added: window.__dshAdded.slice(0, 15)
        };
      })()
    `);
    console.log('aria-expanded after  =', result.after);
    console.log('events the element received:', result.receivedEvents.join(', ') || '(none)');
    console.log('DOM additions:', result.added.length);
    for (const a of result.added) console.log('  + ' + a);
    if (events.length) { console.log('console:'); for (const e of events.slice(-8)) console.log('  ' + e.slice(0, 180)); }
  } catch (error) {
    console.error('FAILED:', error.message);
    process.exitCode = 1;
  } finally {
    ws.close();
  }
});
ws.addEventListener('error', () => { console.error('websocket error'); process.exitCode = 1; });
