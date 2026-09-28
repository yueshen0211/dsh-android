// Evaluate an expression inside the on-device WebView and print the result.
//
// Why this exists separately from cdp-probe.mjs: that tool renders its own
// fixed report (DOM summary, API availability, console) and treats --eval as a
// footnote, and its value marshalling has proven unreliable for a plain
// expression. This one does exactly one thing -- evaluate, return the value as
// JSON -- which is what design and layout questions need.
//
// Usage:
//   node tools/cdp-eval.mjs <wsUrlFile> <jsFile>
//   node tools/cdp-eval.mjs <wsUrlFile> --inline "<expression>"

import { readFileSync } from 'node:fs';

const [urlFile, source, inlineValue] = process.argv.slice(2);
if (!urlFile || !source) {
  console.error('usage: cdp-eval.mjs <wsUrlFile> (<jsFile> | --inline "<expr>")');
  process.exit(2);
}
const expression = source === '--inline' ? inlineValue : readFileSync(source, 'utf8');
if (!expression) { console.error('no expression given'); process.exit(2); }

const wsUrl = readFileSync(urlFile, 'utf8').trim();
const ws = new WebSocket(wsUrl);
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} timed out`)); } }, 30000);
  });
}

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
  }
});

ws.addEventListener('open', async () => {
  try {
    await send('Runtime.enable');
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description ?? d.text ?? 'evaluation threw');
    }
    const v = r.result?.value;
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  } catch (error) {
    console.error('EVAL FAILED:', error.message);
    process.exitCode = 1;
  } finally {
    ws.close();
  }
});

ws.addEventListener('error', (e) => {
  console.error('websocket error:', e.message ?? e.type);
  process.exitCode = 1;
});
