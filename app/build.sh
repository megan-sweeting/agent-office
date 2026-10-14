#!/bin/bash
# Builds ~/Applications/Burrow & Co.app from main.swift and assets/app-icon.png.
# APP=/some/path/Test.app ./build.sh builds somewhere else (for testing).
set -e
cd "$(dirname "$0")"
APP="${APP:-$HOME/Applications/Burrow & Co.app}"
HERE="$(cd .. && pwd)"

# The app starts the office from the folder it was built in. Building from a second copy (say a
# staging copy) would quietly switch the app over to that copy's office, so ask first.
# FORCE=1 ./build.sh skips the question.
OLDFOLDER=""
[ -f "$APP/Contents/Info.plist" ] && OLDFOLDER=$(/usr/libexec/PlistBuddy -c "Print :AgentOfficeFolder" "$APP/Contents/Info.plist" 2>/dev/null || true)
if [ -n "$OLDFOLDER" ] && [ "$OLDFOLDER" != "$HERE" ] && [ "$FORCE" != 1 ]; then
  echo "$APP already opens the office in:"
  echo "  $OLDFOLDER"
  echo "Building here would make it open this one instead:"
  echo "  $HERE"
  read -r -p "Replace it? [y/N] " yes
  case "$yes" in [yY]*) ;; *) echo "Left the app as it was."; exit 1 ;; esac
fi
ICON="../assets/app-icon.png"
SET="$(mktemp -d)/AppIcon.iconset"

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$SET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$ICON" --out "$SET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$ICON" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o "$APP/Contents/Resources/AppIcon.icns"

swiftc -O main.swift -o "$APP/Contents/MacOS/Burrow & Co" -target arm64-apple-macos13.0 \
  -framework Cocoa -framework WebKit -framework UserNotifications
rm -f "$APP/Contents/MacOS/launch"

cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Burrow &amp; Co.</string>
  <key>CFBundleDisplayName</key><string>Burrow &amp; Co.</string>
  <key>CFBundleIdentifier</key><string>local.agent-office</string>
  <key>CFBundleVersion</key><string>2.0</string>
  <key>CFBundleShortVersionString</key><string>2.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Burrow &amp; Co</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
EOF

# Remember where the office lives (the folder above app/), and use your own bundle ID if you set one:
#   BUNDLE_ID=com.yourname.agent-office ./build.sh
PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :AgentOfficeFolder string $HERE" "$PLIST"
[ -n "$BUNDLE_ID" ] && /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$PLIST"

# Sign with your Apple Development certificate when there is one (a stable identity macOS
# remembers for notifications); otherwise fall back to an ad-hoc signature.
IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null | grep -m1 "Apple Development" | awk '{print $2}')
codesign --force --deep -s "${IDENTITY:--}" "$APP"
touch "$APP"
echo "Built $APP"
# Before the rename the app was called Agent Office. It has the same bundle ID, so keep just one.
OLD="$HOME/Applications/Agent Office.app"
[ -d "$OLD" ] && echo "You can now delete the old app: $OLD"
exit 0
