// Click a page element by its visible text, then report what changed.
//
// Coordinate taps are the wrong tool for this: the device pixel ratio converts
// CSS pixels to physical ones by a factor that has to be guessed, and a
// mis-scaled tap silently hits nothing. Addressing the element removes the guess.
//
// Usage:
//   node tools/cdp-click.mjs <wsUrlFile> "<visible text>" [--settle ms]

import { readFileSync } from 'node:fs';

const [urlFile, targetText, ...rest] = process.argv.slice(2);
if (!urlFile || !targetText) {
  console.error('usage: cdp-click.mjs <wsUrlFile> "<visible text>" [--settle ms]');
  process.exit(2);
}
const settleIndex = rest.indexOf('--settle');
const settleMs = settleIndex >= 0 ? Number(rest[settleIndex + 1]) : 1500;
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
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} timed out`)); }
    }, 15000);
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation threw');
  }
  return result.result?.value;
}

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    events.push('[console] ' + (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '));
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    events.push('[exception] ' + (msg.params.exceptionDetails?.exception?.description ?? ''));
  }
});

const snapshot = `
  (() => {
    const out = [];
    const walk = (el, d) => {
      if (d > 30 || !el) return;
      const t = (el.textContent || '').trim();
      if (el.children.length === 0 && t && t.length < 60) {
        const r = el.getBoundingClientRect();
        if (r.width > 0) out.push(t + ' @' + Math.round(r.x) + ',' + Math.round(r.y));
      }
      for (const c of el.children) walk(c, d + 1);
    };
    walk(document.body, 0);
    return out;
  })()
`;

ws.addEventListener('open', async () => {
  try {
    await send('Runtime.enable');
    console.log('target text:', JSON.stringify(targetText));

    const before = await evaluate(snapshot);
    console.log('elements before:', before.length);

    // Click the deepest element whose own text matches, then bubble a real click
    // up so the framework's delegated handlers see it.
    const clicked = await evaluate(`
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
        if (!hit) return { found: false };
        const r = hit.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, view: window };
        hit.dispatchEvent(new PointerEvent('pointerdown', opts));
        hit.dispatchEvent(new MouseEvent('mousedown', opts));
        hit.dispatchEvent(new PointerEvent('pointerup', opts));
        hit.dispatchEvent(new MouseEvent('mouseup', opts));
        hit.dispatchEvent(new MouseEvent('click', opts));
        return { found: true, tag: hit.tagName, cls: (hit.className || '').toString().slice(0, 40), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] };
      })()
    `);
    console.log('click:', JSON.stringify(clicked));

    await new Promise((r) => setTimeout(r, settleMs));

    const after = await evaluate(snapshot);
    const added = after.filter((x) => !before.includes(x));
    console.log('elements after:', after.length, '| newly appeared:', added.length);
    for (const line of added.slice(0, 25)) console.log('  + ' + line);

    console.log('events:');
    if (events.length === 0) console.log('  (none)');
    for (const line of events.slice(-15)) console.log('  ' + line.slice(0, 200));
  } catch (error) {
    console.error('CLICK FAILED:', error.message);
    process.exitCode = 1;
  } finally {
    ws.close();
  }
});

ws.addEventListener('error', () => { console.error('websocket error'); process.exitCode = 1; });
