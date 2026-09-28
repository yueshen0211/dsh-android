// Check the mobile shell's CSS for the mistakes that fail silently in a browser.
//
//   node tools/check-plugin-css.mjs android/plugins/ui/lib/client.js
//
// Why this exists: a missing `}` in a concatenated stylesheet string does not
// throw. The browser discards everything up to the next brace it can parse, so a
// whole feature quietly becomes unstyled. That is how the drawer handle shipped
// with `position: static` and a dead click target -- the composer rule above it
// had swallowed it, and nothing anywhere reported a problem.
//
// The plugin also asserts this at runtime against the CSSOM. This is the build-time
// half, so the mistake is caught before an APK exists.

import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'android/plugins/ui/lib/client.js';
const source = readFileSync(file, 'utf8');

// Pull out the joined CSS array and evaluate it with the identifier references
// stubbed, so the exact string the plugin builds is what gets checked.
const arrayMatch = source.match(/const CSS = \[([\s\S]*?)\]\.join\(""\);/);
if (!arrayMatch) {
  console.error(`could not find the CSS array in ${file}`);
  process.exit(1);
}
// Stub each identifier with its OWN declared value so the rebuilt string contains
// the real selectors. Numbers are included because the media-query bound is one;
// stubbing with a placeholder made every interpolated selector unfindable, which
// silently turned this check into a no-op.
const literals = new Map();
for (const m of source.matchAll(/^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*("([^"]*)"|'([^']*)'|(\d+(?:\.\d+)?))\s*;/gm)) {
  literals.set(m[1], m[3] ?? m[4] ?? m[5]);
}
const declared = [...source.matchAll(/^\s*const\s+([A-Za-z_$][\w$]*)\s*=/gm)].map((m) => m[1]);
const referenced = [...arrayMatch[1].matchAll(/\+\s*([A-Za-z_$][\w$]*)\s*(?=\+)/g)].map((m) => m[1]);
const unknown = [...new Set(referenced)].filter((id) => !declared.includes(id));
if (unknown.length) {
  console.error(`CSS array references identifiers that are not declared: ${unknown.join(', ')}`);
  process.exit(1);
}
const identifiers = [...new Set(referenced)];
const nonLiteral = identifiers.filter((id) => !literals.has(id));
if (nonLiteral.length) {
  console.error(`CSS array interpolates constants with non-literal values, so it cannot be rebuilt faithfully: ${nonLiteral.join(', ')}`);
  process.exit(1);
}
const stub = identifiers.map((id) => `const ${id} = ${JSON.stringify(literals.get(id))};`).join('\n');
// eslint-disable-next-line no-eval -- evaluating the plugin's own literal is the point
const parts = eval(`${stub}\n[${arrayMatch[1]}]`);
const css = parts.join('');

/** @type {Array<{name: string, ok: boolean, detail: string}>} */
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

const opens = (css.match(/\{/g) ?? []).length;
const closes = (css.match(/\}/g) ?? []).length;
check('braces balanced', opens === closes, `${opens} open, ${closes} close`);

const parenOpens = (css.match(/\(/g) ?? []).length;
const parenCloses = (css.match(/\)/g) ?? []).length;
check('parentheses balanced', parenOpens === parenCloses, `${parenOpens} open, ${parenCloses} close`);

// Every rule the plugin declares must be reachable; compare declared selectors
// against the braces that were actually closed.
check('has a rule for the root frame', /\[class\*='_frame'\]\{/.test(css), '');
check('has a rule for the composer', /\[class\*='_composerSeat'\]\{/.test(css), '');

// The handle must be positioned by its own rule, not left to inherit static.
const handleRule = /#dsh-mobile-ui-handle\{[^}]*\}/.exec(css);
check('handle has its own rule', !!handleRule, handleRule ? handleRule[0].slice(0, 60) + '...' : 'missing');
if (handleRule) {
  check('handle is not static', /position:fixed/.test(handleRule[0]), '');
  check('handle meets the 44px touch floor', /height:44px/.test(handleRule[0]) && /width:44px/.test(handleRule[0]), '');
}

// Nothing may use `transform` for the drawer: it is inert on that element.
check('drawer does not rely on transform', !/sidebarCol'\]\{[^}]*transform/.test(css), '');

const failed = checks.filter((c) => !c.ok);
for (const c of checks) {
  const mark = c.ok ? 'ok  ' : 'FAIL';
  console.log(`  ${mark} ${c.name}${c.detail ? '  (' + c.detail + ')' : ''}`);
}
if (failed.length) {
  console.error(`\n${failed.length} CSS check(s) failed in ${file}`);
  process.exit(1);
}
console.log(`\nCSS checks passed (${css.length} chars, ${closes} rules)`);
