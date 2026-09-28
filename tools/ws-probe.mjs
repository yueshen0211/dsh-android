// M0 transport + persistence probe.
//
// Exercises the two things the Android WebView will depend on that the HTTP
// flow alone does not cover:
//   1. the /api browser-trust fence + WebSocket upgrade on /api/remote.mux
//      (this is the RPC carrier the GUI uses for every remote call)
//   2. session creation -> JSONL persistence, which is where the
//      node-addon-system flock dependency is expected to matter on Android
//
// Usage: node tools/ws-probe.mjs <engineUrlWithToken>

const url = process.argv[2];
if (!url) { console.error('usage: node ws-probe.mjs <urlWithToken>'); process.exit(2); }

const base = new URL(url);
const origin = base.origin;
const token = base.searchParams.get('token');
const out = { origin };

// 1. token -> cookie
const r1 = await fetch(url, { redirect: 'manual' });
const cookies = (r1.headers.getSetCookie ? r1.headers.getSetCookie() : []).map(c => c.split(';')[0]).join('; ');
out.index = { status: r1.status, location: r1.headers.get('location'), gotCookie: cookies.length > 0 };

// 2. trust fence: a forged Host header must be refused (403), not 401
const forged = await fetch(origin + '/', { headers: { host: 'evil.example.com' }, redirect: 'manual' });
out.forgedHostStatus = forged.status;

// 3. WebSocket upgrade on the RPC carrier
const wsUrl = origin.replace(/^http/, 'ws') + '/api/remote.mux';
out.wsUrl = wsUrl;
const wsResult = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ outcome: 'timeout' }), 15000);
  let ws;
  try { ws = new WebSocket(wsUrl, { headers: { cookie: cookies, origin } }); }
  catch (e) { clearTimeout(timer); return resolve({ outcome: 'construct-error', error: String(e.message) }); }
  ws.addEventListener('open', () => { clearTimeout(timer); resolve({ outcome: 'open' }); try { ws.close(); } catch {} });
  ws.addEventListener('error', (e) => { clearTimeout(timer); resolve({ outcome: 'error', error: String(e?.message ?? e?.type ?? 'error') }); });
  ws.addEventListener('close', (e) => { clearTimeout(timer); resolve({ outcome: 'closed', code: e.code, reason: e.reason }); });
});
out.websocket = wsResult;

console.log(JSON.stringify(out, null, 2));
