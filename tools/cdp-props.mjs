// Inspect the React props and event listeners actually attached to an element.
//
// Answers "does this control have a handler at all?" rather than inferring it
// from whether a click appeared to do something. React stores its props on a
// "__reactProps$..." key on the DOM node, and the handler names (onClick,
// onPointerDown, ...) are visible there.
//
// Usage: node tools/cdp-props.mjs <wsUrlFile> "<visible text>"

import { readFileSync } from 'node:fs';

const [urlFile, targetText] = process.argv.slice(2);
if (!urlFile || !targetText) {
  console.error('usage: cdp-props.mjs <wsUrlFile> "<visible text>"');
  process.exit(2);
}
const wsUrl = readFileSync(urlFile, 'utf8').trim();

const ws = new WebSocket(wsUrl);
let nextId = 1;
const pending = new Map();

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
  }
});

ws.addEventListener('open', async () => {
  try {
    await send('Runtime.enable');
    const info = await evaluate(`
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

        const describe = (el) => {
          const keys = Object.keys(el).filter(k => k.startsWith('__reactProps$') || k.startsWith('__reactFiber$'));
          const propKey = keys.find(k => k.startsWith('__reactProps$'));
          const props = propKey ? el[propKey] : null;
          const handlerNames = props ? Object.keys(props).filter(k => /^on[A-Z]/.test(k)) : [];
          const r = el.getBoundingClientRect();
          return {
            tag: el.tagName,
            cls: (el.className || '').toString().slice(0, 44),
            rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
            hasProps: !!props,
            handlers: handlerNames,
            disabled: el.disabled === true,
            ariaDisabled: el.getAttribute('aria-disabled'),
            ariaExpanded: el.getAttribute('aria-expanded'),
            pointerEvents: getComputedStyle(el).pointerEvents,
            visibility: getComputedStyle(el).visibility,
            title: el.getAttribute('title') || props?.title || null,
          };
        };

        const chain = [];
        let el = hit;
        for (let i = 0; i < 5 && el && el !== document.body; i++) { chain.push(describe(el)); el = el.parentElement; }
        return { found: true, chain };
      })()
    `);

    if (!info.found) { console.log('not found:', targetText); ws.close(); return; }
    console.log('=== react props / handlers ===');
    for (const n of info.chain) {
      console.log(`  <${n.tag}> ${n.rect.join(',')} disabled=${n.disabled} aria-disabled=${n.ariaDisabled} aria-expanded=${n.ariaExpanded} pe=${n.pointerEvents} vis=${n.visibility}`);
      console.log(`      handlers: ${n.handlers.length ? n.handlers.join(', ') : '(none)'}  title=${n.title}`);
    }
  } catch (error) {
    console.error('FAILED:', error.message);
    process.exitCode = 1;
  } finally {
    ws.close();
  }
});
ws.addEventListener('error', () => { console.error('websocket error'); process.exitCode = 1; });
