// HerdrMic: Stream Deck プラグインの代わりにマイクを使う小さな常駐アプリ。
// Stream Deck 本体はマイクの entitlement が無く無音になるため、許可を自分で取れるこのアプリが録音する。
// 127.0.0.1:18867 だけで待ち受ける。  GET /start  /stop  /status
import AppKit
import AVFoundation
import Network
import Carbon.HIToolbox

let outURL = URL(fileURLWithPath: NSHomeDirectory() + "/Library/Caches/herdr-voice-in.wav")
var recorder: AVAudioRecorder?

func authStatus() -> String {
	switch AVCaptureDevice.authorizationStatus(for: .audio) {
	case .authorized: return "authorized"
	case .denied: return "denied"
	case .restricted: return "restricted"
	default: return "notDetermined"
	}
}

func startRecording() -> String {
	guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
		AVCaptureDevice.requestAccess(for: .audio) { _ in }
		return "error: mic \(authStatus())"
	}
	recorder?.stop()
	try? FileManager.default.removeItem(at: outURL)
	let settings: [String: Any] = [
		AVFormatIDKey: Int(kAudioFormatLinearPCM), AVSampleRateKey: 16000.0, AVNumberOfChannelsKey: 1,
		AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
	]
	do { recorder = try AVAudioRecorder(url: outURL, settings: settings) } catch { return "error: \(error)" }
	return recorder!.record() ? "recording" : "error: record() failed"
}

func stopRecording() -> String {
	recorder?.stop()
	recorder = nil
	return "stopped"
}

func handle(_ path: String) -> String {
	switch path {
	case "/start": return startRecording()
	case "/stop": return stopRecording()
	case "/status": return authStatus()
	default: return "unknown"
	}
}

// ---- 外部デバイス(TourBox など)用のグローバルホットキー ----
// ~/.config/herdr-hotkeys.json: [{"keys":"ctrl+alt+cmd+1","cmd":"/usr/bin/python3 ~/streamdeck-herdr/hue.py preset focus"}, ...]
let keyCodes: [String: Int] = ["a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"9":25,"7":26,"8":28,"0":29,"o":31,"u":32,"i":34,"p":35,"l":37,"j":38,"k":40,"n":45,"m":46]
var hotkeyCmds: [UInt32: String] = [:]

func registerHotkeys() {
	let path = NSHomeDirectory() + "/.config/herdr-hotkeys.json"
	guard let data = FileManager.default.contents(atPath: path),
	      let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: String]] else { return }
	var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
	InstallEventHandler(GetApplicationEventTarget(), { _, ev, _ in
		var id = EventHotKeyID()
		GetEventParameter(ev, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
		if let cmd = hotkeyCmds[id.id] {
			let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/sh"); p.arguments = ["-c", cmd]
			try? p.run()
		}
		return noErr
	}, 1, &spec, nil, nil)
	for (i, e) in arr.enumerated() {
		guard let keys = e["keys"], let cmd = e["cmd"] else { continue }
		let parts = keys.lowercased().split(separator: "+").map(String.init)
		var mods: UInt32 = 0
		for m in parts.dropLast() {
			switch m { case "ctrl": mods |= UInt32(controlKey); case "alt", "opt": mods |= UInt32(optionKey); case "cmd": mods |= UInt32(cmdKey); case "shift": mods |= UInt32(shiftKey); default: break }
		}
		guard let last = parts.last, let code = keyCodes[last] else { continue }
		let id = UInt32(i + 1)
		hotkeyCmds[id] = cmd
		var ref: EventHotKeyRef?
		RegisterEventHotKey(UInt32(code), mods, EventHotKeyID(signature: OSType(0x48484B31), id: id), GetApplicationEventTarget(), 0, &ref)
	}
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // ドックにも画面にも出さない
registerHotkeys()
AVCaptureDevice.requestAccess(for: .audio) { _ in } // 初回はここで macOS の許可ダイアログが出る

let params = NWParameters.tcp
params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: 18867)
let listener = try! NWListener(using: params)
listener.newConnectionHandler = { conn in
	conn.start(queue: .main)
	conn.receive(minimumIncompleteLength: 1, maximumLength: 4096) { data, _, _, _ in
		let line = String(data: data ?? Data(), encoding: .utf8)?.components(separatedBy: "\r\n").first ?? ""
		let path = line.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
		let body = handle(path)
		let resp = "HTTP/1.1 200 OK\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
		conn.send(content: resp.data(using: .utf8), completion: .contentProcessed { _ in conn.cancel() })
	}
}
listener.start(queue: .main)
app.run()
