// Device-side probe: load the Android attachment plugin the same way the engine
// does, and report the failure verbatim if it cannot be loaded.
//
// Run on device (the app must be debuggable so run-as works):
//   adb shell run-as dev.dsh.mobile sh -c \
//     'LD_LIBRARY_PATH=<nativeLibDir> <nativeLibDir>/libnode.so /data/local/tmp/probe.mjs'
//
// The plugin is imported by ABSOLUTE PATH, not by package name: this script runs
// from /data/local/tmp, which is outside the engine's node_modules tree, so bare
// specifier resolution would fail for reasons that have nothing to do with the
// plugin. The engine itself resolves the bare name from inside that tree.

const engine = process.env.HOME
  ? `${process.env.HOME}/files/engine/node_modules`
  : '/data/data/dev.dsh.mobile/files/engine/node_modules';
const pluginPath = `${engine}/@dsh-mobile/attachment-android/index.js`;
const cordisPath = `${engine}/@deepseek-ai/cordis/lib/index.js`;

console.log('probe: engine node_modules =', engine);
try {
  const mod = await import(pluginPath);
  console.log('LOADED');
  console.log('  exports:', Object.keys(mod).join(', '));
  const Store = mod.AndroidAttachmentStore ?? mod.default;
  console.log('  store class:', typeof Store);

  const { Context } = await import(cordisPath);
  const ctx = new Context();
  const store = new Store(ctx, {});
  console.log('  ctx.attachments registered:', ctx.attachments !== undefined);
  console.log('  imageLimits:', JSON.stringify(store.imageLimits));

  // Prove the base class also brings the inherited helpers consumers call.
  for (const method of ['admitPromptContent', 'admitEncodedFile', 'isAttachmentError', 'saveImages']) {
    console.log(`  inherited ${method}:`, typeof ctx.attachments?.[method]);
  }
} catch (error) {
  console.log('LOAD FAILED');
  console.log('  name:', error?.name);
  console.log('  message:', error?.message);
  console.log('  code:', error?.code);
  console.log('  stack:', String(error?.stack).split('\n').slice(0, 12).join('\n    '));
}
