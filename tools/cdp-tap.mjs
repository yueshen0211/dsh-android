// Click via the DevTools input protocol, which behaves like a real tap.
//
// Synthetic events dispatched from page JavaScript do not reach React's
// delegated pointer listeners, so "clicking did nothing" from an evaluate() can
// be a false negative. Input.dispatchMouseEvent goes through the same path as a
// user tap, so the result means what it appears to mean.
//
// Usage: node tools/cdp-tap.mjs <wsUrlFile> "<visible text>" [--settle ms]

import { readFileSync } from 'node:fs';

const [urlFile, targetText, ...rest] = process.argv.slice(2);
if (!urlFile || !targetText) {
  console.error('usage: cdp-tap.mjs <wsUrlFile> "<visible text>" [--settle ms]');
  process.exit(2);
}
const settleIndex = rest.indexOf('--settle');
const settleMs = settleIndex >= 0 ? Number(rest[settleIndex + 1]) : 2000;
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
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' timed out')); } }, 15000);
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

const snapshot = `(() => { const o=[]; const w=(e,d)=>{ if(d>30||!e)return; const t=(e.textContent||'').trim(); if(e.children.length===0&&t&&t.length<60){const r=e.getBoundingClientRect(); if(r.width>0)o.push(t);} for(const c of e.children)w(c,d+1);}; w(document.body,0); return o; })()`;

ws.addEventListener('open', async () => {
  try {
    await send('Runtime.enable');

    // Locate the clickable button that owns this label, and report its centre in
    // CSS pixels -- the coordinate space Input.dispatchMouseEvent expects.
    const target = await evaluate(`
      (() => {
        const want = ${JSON.stringify(targetText)};
        let hit = null;
        const walk = (el, d) => {
          if (hit || d > 30 || !el) return;
          const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
          if (own && own.includes(want) && el.getBoundingClientRect().width > 0) { hit = el; return; }
          for (const c of el.children) walk(c, d + 1);
        };
        walk(document.body, 0);
        if (!hit) return null;
        let el = hit;
        while (el && el !== document.body && el.tagName !== 'BUTTON') el = el.parentElement;
        const node = el && el.tagName === 'BUTTON' ? el : hit;
        const r = node.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, tag: node.tagName, w: r.width, h: r.height };
      })()
    `);
    if (!target) { console.log('element not found:', targetText); ws.close(); return; }
    console.log(`target <${target.tag}> centre = (${target.x.toFixed(1)}, ${target.y.toFixed(1)})  size ${target.w}x${target.h}`);

    const before = await evaluate(snapshot);

    // A tap is press + release, with the button state set correctly.
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {
        type, x: target.x, y: target.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0,
        clickCount: 1, pointerType: 'mouse',
      });
      await new Promise((r) => setTimeout(r, 60));
    }

    await new Promise((r) => setTimeout(r, settleMs));
    const after = await evaluate(snapshot);
    const added = after.filter((x) => !before.includes(x));
    console.log('newly appeared:', added.length);
    for (const a of added.slice(0, 30)) console.log('  + ' + a);

    console.log('events:');
    if (events.length === 0) console.log('  (none)');
    for (const line of events.slice(-12)) console.log('  ' + line.slice(0, 200));
  } catch (error) {
    console.error('TAP FAILED:', error.message);
    process.exitCode = 1;
  } finally {
    ws.close();
  }
});
ws.addEventListener('error', () => { console.error('websocket error'); process.exitCode = 1; });
