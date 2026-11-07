#!/bin/sh
set -e
cd "$(dirname "$0")"
MUSIC_APP="$HOME/Applications/HerdrMusic.app"
mkdir -p "$MUSIC_APP/Contents/MacOS"
swiftc main.swift MusicRatings.swift -o "$MUSIC_APP/Contents/MacOS/HerdrMusic" -framework AppKit -framework WebKit -framework Network
mkdir -p "$MUSIC_APP/Contents/Resources"
cp ratings.html "$MUSIC_APP/Contents/Resources/ratings.html"
cat > "$MUSIC_APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>jp.kz003.herdrmusic</string>
<key>CFBundleName</key><string>HerdrMusic</string>
<key>CFBundleExecutable</key><string>HerdrMusic</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>
PLIST
codesign --force --sign - "$MUSIC_APP"
echo "built: $MUSIC_APP"
