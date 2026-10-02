#!/bin/sh
# Mac で実行: HerdrScribe.app を ~/Applications に作る(アドホック署名)
set -e
# 署名用キーチェーンのパスワードは環境変数で渡す: HERDR_SIGN_PW=... ./build.sh
: "${HERDR_SIGN_PW:=}"
cd "$(dirname "$0")"
APP="$HOME/Applications/HerdrScribe.app"
mkdir -p "$APP/Contents/MacOS"
swiftc -swift-version 5 main.swift -o "$APP/Contents/MacOS/HerdrScribe" -framework AppKit -framework AVFoundation -framework Speech -framework Carbon -framework ScreenCaptureKit -framework Translation -framework CoreMedia
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.herdrscribe</string>
<key>CFBundleName</key><string>HerdrScribe</string>
<key>CFBundleExecutable</key><string>HerdrScribe</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
<key>NSMicrophoneUsageDescription</key><string>会議の音声をリアルタイムで文字起こしするためにマイクを使います。</string>
<key>NSAudioCaptureUsageDescription</key><string>会議の相手の音声(システム音声)を文字起こしするために使います。</string>
<key>NSSpeechRecognitionUsageDescription</key><string>会議の音声を文字に変換します(端末内で処理)。</string>
</dict></plist>
PLIST
# 毎回同じ署名にする(アドホック署名だと、ビルドし直すたびにマイク/画面収録の許可が消える)
KC="$HOME/Library/Keychains/herdr-sign.keychain-db"
if [ -f "$KC" ]; then
	security unlock-keychain -p "$HERDR_SIGN_PW" "$KC"
	# 署名用キーチェーンを検索リストに入れておく(入っていないと identity が見つからない)
	security list-keychains -d user | grep -q herdr-sign || security list-keychains -d user -s "$KC" $(security list-keychains -d user | tr -d '"')
	LEAF=$(security find-certificate -c "Herdr Local Signing" -Z "$KC" | awk '/SHA-1 hash:/{print $3}')
	# 要件を「このID + この証明書」に固定 → ソースを変えて作り直しても、許可が引き継がれる
	codesign --force --sign "Herdr Local Signing" --keychain "$KC" -r="designated => identifier \"local.herdrscribe\" and certificate leaf = H\"$LEAF\"" "$APP"
else
	codesign --force --sign - "$APP"
fi
echo "built: $APP"
