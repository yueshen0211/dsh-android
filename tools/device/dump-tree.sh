#!/system/bin/sh
# Dump the composed DSH plugin tree from inside the app's own sandbox.
#
# The engine tree and its node runtime live in app-private storage, so this has
# to run through `run-as`, which in turn requires a debuggable build (the debug
# configuration in tools/build-apk-cli.ps1 injects android:debuggable).
#
# Why this is worth having: it answers "is my profile overlay actually applied?"
# in seconds, against the real device, without rebuilding the APK. It is what
# found the loader's silent refusal to accept a patched `name`.
#
# Usage:
#   adb push tools/device/dump-tree.sh /data/local/tmp/
#   adb shell chmod 755 /data/local/tmp/dump-tree.sh
#   adb shell run-as dev.dsh.mobile sh /data/local/tmp/dump-tree.sh <nativeLibDir>
#
# <nativeLibDir> is `<pm path dev.dsh.mobile minus /base.apk>/lib/<abi>`,
# e.g. /data/app/~~xxxx==/dev.dsh.mobile-yyyy==/lib/arm64

LIBDIR="$1"
PKG_HOME=/data/user/0/dev.dsh.mobile/files
ENTRY="$PKG_HOME/engine/node_modules/@deepseek-ai/dsh/lib/bin.js"

if [ -z "$LIBDIR" ]; then
  echo "usage: dump-tree.sh <nativeLibDir>"
  exit 2
fi
if [ ! -x "$LIBDIR/libnode.so" ]; then
  echo "libnode.so not executable at $LIBDIR"
  exit 2
fi

cd "$PKG_HOME/workspace" || exit 3
export DSH_HOME="$PKG_HOME/dsh-home"
export LD_LIBRARY_PATH="$LIBDIR"
export HOME="$PKG_HOME"

"$LIBDIR/libnode.so" "$ENTRY" --profile web \
  --patch "$PKG_HOME/android.patch.yml" \
  --dump-config
