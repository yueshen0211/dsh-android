#!/system/bin/sh
# Boot the DSH engine on the device, in the foreground, so its startup output is
# readable.
#
# The app launches the same command line, but there stdout is a pipe back into
# Java and everything ends up in logcat. Running it here makes the failure text
# directly legible -- which is how the loader's --expose-internals requirement
# and the profile-tree module resolution problem were both identified.
#
# Usage:
#   adb push tools/device/boot-engine.sh /data/local/tmp/
#   adb shell chmod 755 /data/local/tmp/boot-engine.sh
#   adb shell run-as dev.dsh.mobile sh /data/local/tmp/boot-engine.sh <nativeLibDir>
#
# The command exits when the engine does; it prints the URL line and then either
# keeps running (success) or prints the stack trace (failure).

LIBDIR="$1"
PKG_HOME=/data/user/0/dev.dsh.mobile/files
ENTRY="$PKG_HOME/engine/node_modules/@deepseek-ai/dsh/lib/bin.js"

if [ -z "$LIBDIR" ]; then
  echo "usage: boot-engine.sh <nativeLibDir>"
  exit 2
fi
if [ ! -f "$ENTRY" ]; then
  echo "engine entry missing: $ENTRY"
  exit 2
fi

cd "$PKG_HOME/workspace" || exit 3
export DSH_HOME="$PKG_HOME/dsh-home"
export LD_LIBRARY_PATH="$LIBDIR"
export HOME="$PKG_HOME"
export TMPDIR="$PKG_HOME/../cache/tmp"
# --expose-internals must be a Node argument, not a NODE_OPTIONS entry: Node
# rejects it from the environment and exits 9 before running anything.
export NODE_OPTIONS=--max-old-space-size=2048
export SSL_CERT_DIR=/system/etc/security/cacerts
export PATH="$LIBDIR:/system/bin:/system/xbin"

exec "$LIBDIR/libnode.so" --expose-internals "$ENTRY" --profile web \
  --patch "$PKG_HOME/android.patch.yml" \
  --no-open --port 0
