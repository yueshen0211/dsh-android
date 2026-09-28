// Describe the clickable ancestry of an element, and try dispatching a click on
// each ancestor until the page reacts.
//
// "The button does nothing" needs a different answer depending on whether the
// handler sits on an ancestor, is bound through pointer events, or the element is
// simply disabled. This walks up from the labelled node, prints what it finds
// (role, tag, handlers, aria state), then clicks each ancestor in turn and
// reports which one -- if any -- changes the page.
//
// Usage: node tools/cdp-ancestors.mjs <wsUrlFile> "<visible text>"

import { readFileSync } from 'node:fs';

const [urlFile, targetText] = process.argv.slice(2);
if (!urlFile || !targetText) {
  console.error('usage: cdp-ancestors.mjs <wsUrlFile> "<visible text>"');
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

    // React attaches handlers to the container and stores them on a property
    // whose name starts with "__reactProps". Reporting which ancestors carry one
    // shows where the click has to land.
    const ancestry = await evaluate(`
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
        const out = [];
        let el = hit;
        for (let i = 0; i < 8 && el && el !== document.body; i++) {
          const r = el.getBoundingClientRect();
          const reactKeys = Object.keys(el).filter(k => k.startsWith('__react'));
          const props = el.__reactProps$ ? el.__reactProps$ : null;
          out.push({
            i, tag: el.tagName,
            cls: (el.className || '').toString().slice(0, 50),
            role: el.getAttribute('role'),
            disabled: el.disabled === true || el.getAttribute('aria-disabled'),
            react: reactKeys.length > 0,
            rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
          });
          el = el.parentElement;
        }
        return { found: true, chain: out };
      })()
    `);
    console.log('=== ancestry of "' + targetText + '" ===');
    if (!ancestry.found) { console.log('  element not found'); ws.close(); return; }
    for (const n of ancestry.chain) {
      console.log(`  [${n.i}] <${n.tag}> role=${n.role} disabled=${n.disabled} reactHandlers=${n.react} rect=${n.rect.join(',')} .${n.cls}`);
    }

    // Try each ancestor: click, wait, and see whether the page's element set grows.
    const snapshot = `(() => { const o=[]; const w=(e,d)=>{ if(d>30||!e)return; const t=(e.textContent||'').trim(); if(e.children.length===0&&t&&t.length<60){const r=e.getBoundingClientRect(); if(r.width>0)o.push(t+' @'+Math.round(r.x)+','+Math.round(r.y));} for(const c of e.children)w(c,d+1);}; w(document.body,0); return o; })()`;

    for (const n of ancestry.chain) {
      const before = await evaluate(snapshot);
      await evaluate(`
        (() => {
          const want = ${JSON.stringify(targetText)};
          let hit = null;
          const walk = (el, d) => {
            if (hit || d > 30 || !el) return;
            const own = Array.from(el.childNodes).filter(x => x.nodeType === 3).map(x => x.textContent.trim()).join('');
            if (own && own.includes(want) && el.getBoundingClientRect().width > 0) { hit = el; return; }
            for (const c of el.children) walk(c, d + 1);
          };
          walk(document.body, 0);
          let el = hit;
          for (let i = 0; i < ${n.i} && el; i++) el = el.parentElement;
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const o = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, view: window };
          el.dispatchEvent(new PointerEvent('pointerdown', o));
          el.dispatchEvent(new MouseEvent('mousedown', o));
          el.dispatchEvent(new PointerEvent('pointerup', o));
          el.dispatchEvent(new MouseEvent('mouseup', o));
          el.dispatchEvent(new MouseEvent('click', o));
          return true;
        })()
      `);
      await new Promise((r) => setTimeout(r, 1200));
      const after = await evaluate(snapshot);
      const added = after.filter((x) => !before.includes(x));
      console.log(`  clicking ancestor [${n.i}] <${n.tag}> -> +${added.length} element(s)` + (added.length ? ': ' + added.slice(0, 5).join(' | ') : ''));
      if (added.length > 0) { console.log('  ^ this ancestor is the handler'); break; }
    }
  } catch (error) {
    console.error('FAILED:', error.message);
    process.exitCode = 1;
  } finally {
    ws.close();
  }
});
ws.addEventListener('error', () => { console.error('websocket error'); process.exitCode = 1; });
