#!/bin/sh
# Mac で実行: HerdrMic.app を ~/Applications に作る(アドホック署名)
set -e
# 署名用キーチェーンのパスワードは環境変数で渡す: HERDR_SIGN_PW=... ./build.sh
: "${HERDR_SIGN_PW:=}"
cd "$(dirname "$0")"
APP="$HOME/Applications/HerdrMic.app"
mkdir -p "$APP/Contents/MacOS"
swiftc main.swift -o "$APP/Contents/MacOS/HerdrMic" -framework AppKit -framework AVFoundation -framework Network
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.herdrmic</string>
<key>CFBundleName</key><string>HerdrMic</string>
<key>CFBundleExecutable</key><string>HerdrMic</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
<key>NSMicrophoneUsageDescription</key><string>Stream Deck の音声入力キーで、押している間だけ録音します。</string>
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
	codesign --force --sign "Herdr Local Signing" --keychain "$KC" -r="designated => identifier \"local.herdrmic\" and certificate leaf = H\"$LEAF\"" "$APP"
else
	codesign --force --sign - "$APP"
fi
echo "built: $APP"
