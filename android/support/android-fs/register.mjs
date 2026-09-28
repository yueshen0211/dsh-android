// Preload that installs the Android filesystem corrections before the engine's
// module graph is evaluated. Registered from EngineRuntime with:
//
//   --import <engineDir>/android-support/android-fs/register.mjs
//
// A preload is the only place this can happen. Patching the builtin's exports
// does NOT work: an ESM named import from a builtin is a snapshot taken when the
// namespace is created, not a live binding onto the CJS exports. Verified on the
// device -- after `require('node:fs/promises').link = ours`, both a fresh
// `import('node:fs/promises')` and a destructured `const { link } = ...` still
// reported the original function, while the CJS object did report the patch. So
// the consumer has to be transformed as it loads, which is what this hook does.
//
// Corrections applied so far:
//   link()  -> renameat2(RENAME_NOREPLACE)   see android-fs/link.js

import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

// The one package that needs correcting, resolved the way the engine resolves
// it. Resolving instead of hardcoding keeps this correct if the tree is ever
// relocated. DSH_ANDROID_FS_TARGET overrides the target so the transform can be
// tested without the engine tree present.
const specifier = process.env.DSH_ANDROID_FS_TARGET ?? '@deepseek-ai/dsh-session-persistence-jsonl';

let target = null;
try {
  target = pathToFileURL(require.resolve(specifier)).href;
} catch {
  // Not installed: nothing to correct. Failing here would replace the engine's
  // own, more informative error with ours.
  target = null;
}

// Where link.js lives. A file URL, because the consumer is ESM and this is
// spliced into its import statements verbatim. DSH_ANDROID_FS_DIR overrides it
// for tests.
const bridge = process.env.DSH_ANDROID_FS_DIR
  ? pathToFileURL(process.env.DSH_ANDROID_FS_DIR + '/link.js').href
  : new URL('./link.js', import.meta.url).href;

// The consumer's import of node:fs/promises, whatever else it pulls from there.
// `link` is lifted out of it; every other binding is preserved verbatim.
const LINK_IMPORT = /import\s*\{([^}]*)\}\s*from\s*(['"])node:fs\/promises\2\s*;?/;

// A `link(` call that is not a property access (so `fs.link(` and `obj.link(`
// do not count -- only the destructured binding this rewrite replaces).
const LINK_CALL = /(?<![\w.])link\s*\(/;

// In-process, synchronous hooks. `module.register()` would also work but is
// deprecated as of Node 26 (the runtime this ships against), and an in-process
// hook is the right fit anyway: the only work here is a string rewrite.
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!target || url !== target) return result;

    const source = typeof result.source === 'string'
      ? result.source
      : new TextDecoder().decode(result.source);

    // If upstream stops calling link() there is nothing to correct. Return the
    // module untouched rather than throwing: the correction is simply not needed.
    if (!LINK_CALL.test(source)) return { ...result, source, shortCircuit: true };

    const match = source.match(LINK_IMPORT);
    if (!match) {
      throw new Error(
        'android-fs: ' + target + ' calls link() but has no node:fs/promises import to rewrite. ' +
        'Upstream changed shape; update android/support/android-fs/register.mjs.'
      );
    }

    const patched = source.replace(LINK_IMPORT, (whole, names) => {
      const kept = names.split(',').map((n) => n.trim()).filter((n) => n && n !== 'link');
      const rest = kept.length ? 'import { ' + kept.join(', ') + ' } from "node:fs/promises";\n' : '';
      return 'import { link } from ' + JSON.stringify(bridge) + ';\n' + rest;
    });

    if (patched === source) {
      throw new Error('android-fs: rewrite of ' + target + ' produced no change');
    }
    return { ...result, source: patched, shortCircuit: true };
  },
});
