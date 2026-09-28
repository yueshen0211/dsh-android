// Drive the on-device WebView over the Chrome DevTools Protocol.
//
// Tapping by coordinate through `adb input tap` is unreliable: the emulator and
// the phone have different scales, and a mis-scaled tap lands on nothing without
// any error to show for it. CDP addresses elements directly, reads back what the
// page actually contains, and surfaces console errors -- which makes UI
// questions answerable instead of guessable.
//
// Usage:
//   node tools/cdp-probe.mjs <wsUrlFile> [--click "<selector text>"] [--eval "<js>"]

import { readFileSync } from 'node:fs';

const [urlFile, ...rest] = process.argv.slice(2);
if (!urlFile) {
  console.error('usage: cdp-probe.mjs <file-with-webSocketDebuggerUrl> [--eval <js>]');
  process.exit(2);
}
const wsUrl = readFileSync(urlFile, 'utf8').trim();

const customEvalIndex = rest.indexOf('--eval');
const customEval = customEvalIndex >= 0 ? rest[customEvalIndex + 1] : null;

const ws = new WebSocket(wsUrl);
let nextId = 1;
const pending = new Map();
const consoleLines = [];

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
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
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
    const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
    consoleLines.push(`[${msg.params.type}] ${text}`);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleLines.push(`[exception] ${msg.params.exceptionDetails?.exception?.description ?? ''}`);
  }
});

ws.addEventListener('open', async () => {
  try {
    await send('Runtime.enable');

    console.log('=== page ===');
    console.log('  url   :', await evaluate('location.href'));
    console.log('  title :', await evaluate('document.title'));
    console.log('  viewport:', await evaluate('innerWidth + "x" + innerHeight + " dpr=" + devicePixelRatio'));
    console.log('  ready  :', await evaluate('document.readyState'));

    console.log('=== api availability ===');
    console.log('  AbortSignal.any        :', await evaluate('typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function"'));
    console.log('  Promise.withResolvers  :', await evaluate('typeof Promise.withResolvers === "function"'));
    console.log('  globalThis.Iterator    :', await evaluate('typeof globalThis.Iterator'));
    console.log('  Iterator.prototype.join:', await evaluate('typeof globalThis.Iterator !== "undefined" && Iterator.prototype && typeof Iterator.prototype.join === "function"'));

    console.log('=== workspace ui ===');
    const buttons = await evaluate(`
      (() => {
        const out = [];
        const walk = (el, depth) => {
          if (depth > 30 || !el) return;
          const text = (el.textContent || '').trim();
          if (el.children.length === 0 && text && text.length < 60) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              out.push({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 40), text, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
            }
          }
          for (const c of el.children) walk(c, depth + 1);
        };
        walk(document.body, 0);
        return out.slice(0, 40);
      })()
    `);
    for (const b of buttons) {
      console.log(`  <${b.tag}> "${b.text}"  @${b.x},${b.y} ${b.w}x${b.h}  .${b.cls}`);
    }

    if (customEval) {
      console.log('=== custom eval ===');
      console.log(' ', JSON.stringify(await evaluate(customEval)));
    }

    console.log('=== console output (last 20) ===');
    if (consoleLines.length === 0) console.log('  (none)');
    for (const line of consoleLines.slice(-20)) console.log('  ' + line.slice(0, 220));
  } catch (error) {
    console.error('PROBE FAILED:', error.message);
    process.exitCode = 1;
  } finally {
    ws.close();
  }
});

ws.addEventListener('error', (event) => {
  console.error('websocket error:', event.message ?? event.type);
  process.exitCode = 1;
});
