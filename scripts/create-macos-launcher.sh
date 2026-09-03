#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

APP_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
LAUNCHER_DIR="$HOME/Applications/BoardClip.app"
MACOS_DIR="$LAUNCHER_DIR/Contents/MacOS"
RESOURCES_DIR="$LAUNCHER_DIR/Contents/Resources"

xml_escape() {
  printf '%s' "$1" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g'
}

shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

APP_DIR_SH="$(shell_quote "$APP_DIR")"
cat > "$MACOS_DIR/BoardClip" <<EOF
#!/bin/sh
cd $APP_DIR_SH
./start.sh >/dev/null 2>&1 &
exit 0
EOF
chmod +x "$MACOS_DIR/BoardClip"

if [ -f "$APP_DIR/icon.png" ]; then
  cp "$APP_DIR/icon.png" "$RESOURCES_DIR/icon.png" 2>/dev/null || true
fi

# Finder only shows a bundle icon from an .icns named by CFBundleIconFile; a
# bare PNG in Resources is ignored (the launcher used to show a blank icon).
# Build the icns from the 512px source with the stock sips + iconutil.
ICON_SRC="$APP_DIR/icon@2x.png"
[ -f "$ICON_SRC" ] || ICON_SRC="$APP_DIR/icon.png"
HAS_ICNS=0
if [ -f "$ICON_SRC" ] && command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
  ICONSET_PARENT="$(mktemp -d 2>/dev/null || echo "/tmp/boardclip-iconset-$$")"
  ICONSET="$ICONSET_PARENT/BoardClip.iconset"
  mkdir -p "$ICONSET"
  for px in 16 32 64 128 256 512; do
    sips -z "$px" "$px" "$ICON_SRC" --out "$ICONSET/icon_${px}x${px}.png" >/dev/null 2>&1 || true
  done
  cp "$ICONSET/icon_32x32.png" "$ICONSET/icon_16x16@2x.png" 2>/dev/null || true
  cp "$ICONSET/icon_64x64.png" "$ICONSET/icon_32x32@2x.png" 2>/dev/null || true
  rm -f "$ICONSET/icon_64x64.png"
  cp "$ICONSET/icon_256x256.png" "$ICONSET/icon_128x128@2x.png" 2>/dev/null || true
  cp "$ICONSET/icon_512x512.png" "$ICONSET/icon_256x256@2x.png" 2>/dev/null || true
  if iconutil -c icns "$ICONSET" -o "$RESOURCES_DIR/icon.icns" >/dev/null 2>&1; then
    HAS_ICNS=1
  fi
  rm -rf "$ICONSET_PARENT" 2>/dev/null || true
fi
ICON_KEY=""
if [ "$HAS_ICNS" = "1" ]; then
  ICON_KEY="  <key>CFBundleIconFile</key>
  <string>icon</string>
"
fi

APP_DIR_XML="$(xml_escape "$APP_DIR")"
cat > "$LAUNCHER_DIR/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>BoardClip</string>
  <key>CFBundleExecutable</key>
  <string>BoardClip</string>
  <key>CFBundleIdentifier</key>
  <string>app.boardclip.source-launcher</string>
  <key>CFBundleName</key>
  <string>BoardClip</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
${ICON_KEY}  <key>BoardClipSourceDirectory</key>
  <string>$APP_DIR_XML</string>
</dict>
</plist>
EOF

# Nudge Finder / LaunchServices to drop the cached (blank) icon for this bundle.
touch "$LAUNCHER_DIR/Contents/Info.plist" "$LAUNCHER_DIR" 2>/dev/null || true
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
if [ -x "$LSREGISTER" ]; then "$LSREGISTER" -f "$LAUNCHER_DIR" >/dev/null 2>&1 || true; fi

echo "Created Applications launcher: $LAUNCHER_DIR"
