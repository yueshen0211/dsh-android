// Click an element and report every DOM mutation the page makes in response,
// including nodes added inside portals (which live outside the element's own
// subtree and are therefore invisible to naive "did a child appear" checks).
//
// Usage: node tools/cdp-mutate.mjs <wsUrlFile> "<visible text>" [--settle ms]

import { readFileSync } from 'node:fs';

const [urlFile, targetText, ...rest] = process.argv.slice(2);
if (!urlFile || !targetText) {
  console.error('usage: cdp-mutate.mjs <wsUrlFile> "<visible text>" [--settle ms]');
  process.exit(2);
}
const settleIndex = rest.indexOf('--settle');
const settleMs = settleIndex >= 0 ? Number(rest[settleIndex + 1]) : 2500;
const wsUrl = readFileSync(urlFile, 'utf8').trim();

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
async function evaluate(expression, awaitPromise = false) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
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
  try {
    await send('Runtime.enable');

    // Record mutations for the whole document (portals included).
    await evaluate(`
      (() => {
        window.__dshMutations = [];
        if (window.__dshObserver) window.__dshObserver.disconnect();
        window.__dshObserver = new MutationObserver((records) => {
          for (const r of records) {
            for (const n of r.addedNodes) {
              if (n.nodeType === 1) {
                const rect = n.getBoundingClientRect();
                window.__dshMutations.push({
                  tag: n.tagName,
                  cls: (n.className || '').toString().slice(0, 60),
                  text: (n.textContent || '').trim().slice(0, 120),
                  rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
                  parent: (n.parentElement?.className || '').toString().slice(0, 50)
                });
              }
            }
          }
        });
        window.__dshObserver.observe(document.body, { childList: true, subtree: true });
        return true;
      })()
    `);

    // A real tap at the control's centre.
    const target = await evaluate(`
      (() => {
        const want = ${JSON.stringify(targetText)};
        const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes(want));
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, ariaExpanded: btn.getAttribute('aria-expanded') };
      })()
    `);
    if (!target) { console.log('button not found'); ws.close(); return; }
    console.log(`tapped (${target.x.toFixed(0)}, ${target.y.toFixed(0)}), aria-expanded before = ${target.ariaExpanded}`);

    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {
        type, x: target.x, y: target.y, button: 'left',
        buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, pointerType: 'mouse',
      });
      await new Promise((r) => setTimeout(r, 60));
    }
    await new Promise((r) => setTimeout(r, settleMs));

    const result = await evaluate(`
      (() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes(${JSON.stringify(targetText)}));
        return {
          ariaExpandedAfter: btn ? btn.getAttribute('aria-expanded') : null,
          mutationCount: window.__dshMutations.length,
          mutations: window.__dshMutations.slice(0, 25),
          viewport: innerWidth + 'x' + innerHeight
        };
      })()
    `);
    console.log('aria-expanded after  =', result.ariaExpandedAfter, '| viewport', result.viewport);
    console.log('mutations:', result.mutationCount);
    for (const m of result.mutations) {
      console.log(`  + <${m.tag}> rect=${m.rect.join(',')} parent=.${m.parent}  "${m.text}"`);
    }
  } catch (error) {
    console.error('FAILED:', error.message);
    process.exitCode = 1;
  } finally {
    ws.close();
  }
});
ws.addEventListener('error', () => { console.error('websocket error'); process.exitCode = 1; });
