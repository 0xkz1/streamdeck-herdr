// HerdrScribe: メニューバー常駐のリアルタイム文字起こし(Mac 標準の SpeechTranscriber、端末内で動く)。
//   自分のマイク … AVAudioEngine
//   相手の音声   … ScreenCaptureKit のシステム音声(イヤホン使用中でも取れる。画面収録の許可が要る)
// 2つを別々の認識器で並行して動かし、行頭に「自分」「相手」を付ける。英語は日本語訳を添える。
// 止めると録音(.m4a)と時刻つき Markdown が ~/Documents/HerdrScribe/ に残る。  ショートカット: ⌃⌥⌘R
import AppKit
import AVFoundation
import Carbon.HIToolbox
import Network
import CoreMedia
import ScreenCaptureKit
import Speech
import Translation

let outDir = URL(fileURLWithPath: NSHomeDirectory() + "/Documents/HerdrScribe")

// ---- 1チャンネル分: 認識器 + 変換 + 録音ファイル ----
final class Channel {
	let label: String
	let lang: String // "ja" | "en"
	var analyzer: SpeechAnalyzer?
	var cont: AsyncStream<AnalyzerInput>.Continuation?
	var fmt: AVAudioFormat?
	var converter: AVAudioConverter?
	var converterSrc: AVAudioFormat?
	var file: AVAudioFile?
	var fileURL: URL
	var task: Task<Void, Never>?
	var translator: TranslationSession?
	var firstBufferAt: Date?

	init(label: String, lang: String, fileURL: URL) {
		self.label = label; self.lang = lang; self.fileURL = fileURL
	}

	func prepare(onVolatile: @escaping (String) -> Void, onFinal: @escaping (String, TranslationSession?) -> Void, onDownload: @escaping () -> Void) async throws {
		let transcriber = SpeechTranscriber(locale: Locale(identifier: lang == "en" ? "en_US" : "ja_JP"), transcriptionOptions: [], reportingOptions: [.volatileResults, .fastResults], attributeOptions: [])
		if let req = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
			onDownload()
			try await req.downloadAndInstall()
		}
		let analyzer = SpeechAnalyzer(modules: [transcriber])
		self.analyzer = analyzer
		fmt = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
		let (stream, c) = AsyncStream<AnalyzerInput>.makeStream()
		cont = c
		try await analyzer.start(inputSequence: stream)
		if lang == "en" {
			translator = TranslationSession(installedSource: Locale.Language(identifier: "en"), target: Locale.Language(identifier: "ja"))
		}
		let tr = translator
		task = Task {
			do {
				for try await r in transcriber.results {
					let text = String(r.text.characters)
					if r.isFinal { onFinal(text, tr) } else { onVolatile(text) }
				}
			} catch { onFinal("(認識エラー: \(error))", nil) }
		}
	}

	// どの入力形式でも受け取り、録音ファイルに書き、認識器の形式に変換して渡す
	func feed(_ buf: AVAudioPCMBuffer) {
		if firstBufferAt == nil { firstBufferAt = Date() }
		if file == nil {
			file = try? AVAudioFile(forWriting: fileURL, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 22050, AVNumberOfChannelsKey: 1])
		}
		try? file?.write(from: buf)
		guard let fmt else { return }
		if converter == nil || converterSrc != buf.format {
			converter = AVAudioConverter(from: buf.format, to: fmt)
			converterSrc = buf.format
		}
		guard let converter else { return }
		let ratio = fmt.sampleRate / buf.format.sampleRate
		guard let out = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(Double(buf.frameLength) * ratio) + 64) else { return }
		var fed = false
		converter.convert(to: out, error: nil) { _, status in
			if fed { status.pointee = .noDataNow; return nil }
			fed = true; status.pointee = .haveData; return buf
		}
		if out.frameLength > 0 { cont?.yield(AnalyzerInput(buffer: out)) }
	}

	func finish() async {
		cont?.finish()
		try? await analyzer?.finalizeAndFinishThroughEndOfInput()
		file = nil
	}
}

// ---- システム音声の受け口 ----
final class SystemTap: NSObject, SCStreamOutput {
	var handler: ((AVAudioPCMBuffer) -> Void)?
	func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
		guard type == .audio, sb.isValid, let desc = sb.formatDescription, var asbd = desc.audioStreamBasicDescription,
		      let fmt = AVAudioFormat(streamDescription: &asbd) else { return }
		let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sb))
		guard frames > 0, let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: frames) else { return }
		buf.frameLength = frames
		let st = CMSampleBufferCopyPCMDataIntoAudioBufferList(sb, at: 0, frameCount: Int32(frames), into: buf.mutableAudioBufferList)
		if st == noErr { handler?(buf) }
	}
}

final class Scribe: NSObject, NSApplicationDelegate {
	var status: NSStatusItem!
	var panel: NSPanel!
	var textView: NSTextView!
	var toggleItem: NSMenuItem!
	var micItems: [String: NSMenuItem] = [:]
	var sysItems: [String: NSMenuItem] = [:]

	var engine: AVAudioEngine?
	var scStream: SCStream?
	let tap = SystemTap()
	var channels: [Channel] = []
	var running = false
	var startedAt = Date()
	var mdURL: URL?
	var baseURL: URL?
	var refining = 0
	var finals: [String] = []
	var volatiles: [String: String] = [:]

	// 設定: 自分のマイクの言語 / 相手(システム音声)のモード
	var micLang: String { get { UserDefaults.standard.string(forKey: "micLang") ?? "ja" } set { UserDefaults.standard.set(newValue, forKey: "micLang") } }
	var sysMode: String { get { UserDefaults.standard.string(forKey: "sysMode") ?? "en" } set { UserDefaults.standard.set(newValue, forKey: "sysMode") } }

	func applicationDidFinishLaunching(_ n: Notification) {
		try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
		status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
		setIcon("🎙")
		let menu = NSMenu()
		toggleItem = NSMenuItem(title: "開始  ⌃⌥⌘R", action: #selector(toggle), keyEquivalent: "")
		toggleItem.target = self
		menu.addItem(toggleItem)
		menu.addItem(.separator())
		menu.addItem(header("自分のマイク"))
		for (k, t) in [("ja", "日本語"), ("en", "英語(日本語訳つき)")] { micItems[k] = item("　" + t, #selector(pickMic(_:)), k); menu.addItem(micItems[k]!) }
		menu.addItem(header("相手の音声(システム音声・イヤホン中も可)"))
		for (k, t) in [("off", "取り込まない"), ("ja", "日本語"), ("en", "英語(日本語訳つき)")] { sysItems[k] = item("　" + t, #selector(pickSys(_:)), k); menu.addItem(sysItems[k]!) }
		menu.addItem(.separator())
		let redo = NSMenuItem(title: "未処理の会議を仕上げる", action: #selector(refinePending), keyEquivalent: "")
		redo.target = self
		menu.addItem(redo)
		let open = NSMenuItem(title: "保存先を開く", action: #selector(openFolder), keyEquivalent: "")
		open.target = self
		menu.addItem(open)
		menu.addItem(NSMenuItem(title: "終了", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
		status.menu = menu
		refreshChecks()
		buildPanel()
		registerHotKey()
		AVCaptureDevice.requestAccess(for: .audio) { _ in }
		DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in self?.refinePending() } // 前回 Ubuntu に繋がらず残った分を再実行
	}

	// ---- 会議後の仕上げ: 録音を Ubuntu(GPU の Whisper large-v3)で取り直し、要約つき議事録 _final.md を作る ----
	@objc func refinePending() {
		let files = (try? FileManager.default.contentsOfDirectory(at: outDir, includingPropertiesForKeys: nil)) ?? []
		for f in files where f.pathExtension == "pending" { refine(f.deletingPathExtension()) }
	}

	func refine(_ base: URL) {
		let marker = base.appendingPathExtension("pending")
		FileManager.default.createFile(atPath: marker.path, contents: nil)
		let p = Process()
		p.executableURL = URL(fileURLWithPath: "/bin/sh")
		p.arguments = [NSHomeDirectory() + "/streamdeck-herdr/helper/HerdrScribe/refine.sh", base.path]
		p.terminationHandler = { [weak self] proc in
			DispatchQueue.main.async {
				guard let self else { return }
				self.refining -= 1
				let final = URL(fileURLWithPath: base.path + "_final.md")
				if proc.terminationStatus == 0, FileManager.default.fileExists(atPath: final.path) {
					try? FileManager.default.removeItem(at: marker)
					NSWorkspace.shared.activateFileViewerSelecting([final])
				}
				self.setIcon(self.running ? "🔴" : (self.refining > 0 ? "🛠" : (FileManager.default.fileExists(atPath: marker.path) ? "⚠️" : "🎙")))
			}
		}
		refining += 1
		setIcon("🛠")
		try? p.run()
	}

	func header(_ s: String) -> NSMenuItem { let i = NSMenuItem(title: s, action: nil, keyEquivalent: ""); i.isEnabled = false; return i }
	func item(_ title: String, _ sel: Selector, _ key: String) -> NSMenuItem { let i = NSMenuItem(title: title, action: sel, keyEquivalent: ""); i.target = self; i.representedObject = key; return i }
	func refreshChecks() {
		for (k, i) in micItems { i.state = k == micLang ? .on : .off }
		for (k, i) in sysItems { i.state = k == sysMode ? .on : .off }
	}
	@objc func pickMic(_ s: NSMenuItem) { guard !running else { return }; micLang = s.representedObject as! String; refreshChecks() }
	@objc func pickSys(_ s: NSMenuItem) { guard !running else { return }; sysMode = s.representedObject as! String; refreshChecks() }

	func setIcon(_ s: String) { status.button?.title = s }

	// 字幕ウィンドウ: アプリが非アクティブでも隠れず、全画面アプリや全デスクトップの上にも常に出す
	func buildPanel() {
		let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1400, height: 900)
		let w: CGFloat = min(1000, screen.width - 80), h: CGFloat = 260
		panel = NSPanel(contentRect: NSRect(x: screen.midX - w / 2, y: screen.minY + 40, width: w, height: h),
		                styleMask: [.titled, .closable, .resizable, .utilityWindow, .nonactivatingPanel, .hudWindow], backing: .buffered, defer: false)
		panel.title = "HerdrScribe"
		panel.isFloatingPanel = true
		panel.hidesOnDeactivate = false // ← 他のアプリを前面にしても隠さない
		panel.level = .statusBar
		panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary] // 全デスクトップ・全画面アプリの上にも出す
		panel.isMovableByWindowBackground = true
		let scroll = NSScrollView(frame: panel.contentView!.bounds)
		scroll.autoresizingMask = [.width, .height]
		scroll.hasVerticalScroller = true
		scroll.drawsBackground = false
		textView = NSTextView(frame: scroll.bounds)
		textView.autoresizingMask = [.width]
		textView.isVerticallyResizable = true
		textView.isHorizontallyResizable = false
		textView.minSize = NSSize(width: 0, height: scroll.contentSize.height)
		textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
		textView.textContainer?.widthTracksTextView = true
		textView.isEditable = false
		textView.drawsBackground = false
		textView.textContainerInset = NSSize(width: 12, height: 10)
		scroll.documentView = textView
		panel.contentView!.addSubview(scroll)
	}

	@objc func openFolder() { NSWorkspace.shared.open(outDir) }
	@objc func toggle() { if running { Task { await stop() } } else { Task { await start() } } }

	func render() {
		let font = NSFont.systemFont(ofSize: 22, weight: .medium)
		let a = NSMutableAttributedString(string: finals.joined(separator: "\n"), attributes: [.font: font, .foregroundColor: NSColor.white])
		for label in ["自分", "相手"] {
			if let v = volatiles[label], !v.isEmpty {
				a.append(NSAttributedString(string: (a.length == 0 ? "" : "\n") + label + ": " + v, attributes: [.font: font, .foregroundColor: NSColor(white: 1, alpha: 0.85)]))
			}
		}
		textView.textStorage?.setAttributedString(a)
		textView.scrollToEndOfDocument(nil)
	}

	func stamp(_ d: TimeInterval) -> String { String(format: "%02d:%02d:%02d", Int(d) / 3600, Int(d) % 3600 / 60, Int(d) % 60) }
	func append(_ s: String) { if let h = try? FileHandle(forWritingTo: mdURL!) { h.seekToEndOfFile(); h.write(s.data(using: .utf8)!); try? h.close() } }

	// チャンネルの確定/途中結果を画面とファイルへ
	func wire(_ ch: Channel) async throws {
		try await ch.prepare(
			onVolatile: { [weak self] t in DispatchQueue.main.async { self?.volatiles[ch.label] = t; self?.render() } },
			onFinal: { [weak self] text, tr in
				DispatchQueue.main.async {
					guard let self else { return }
					self.volatiles[ch.label] = ""
					let line = "[\(self.stamp(Date().timeIntervalSince(self.startedAt)))] **\(ch.label)**: \(text)"
					self.finals.append(line)
					self.append(line + "\n\n")
					self.render()
					guard let tr, !text.isEmpty else { return }
					let idx = self.finals.count - 1
					Task {
						guard let ja = try? await tr.translate(text).targetText else { return }
						DispatchQueue.main.async {
							guard idx < self.finals.count else { return }
							self.finals[idx] += "\n　↳ " + ja
							self.append("> 訳: " + ja + "\n\n")
							self.render()
						}
					}
				}
			},
			onDownload: { [weak self] in DispatchQueue.main.async { self?.volatiles[ch.label] = "音声認識モデルをダウンロード中…"; self?.panel.orderFrontRegardless(); self?.render() } }
		)
	}

	func start() async {
		guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
			await MainActor.run { showAlert("マイクの許可が要ります。システム設定 → プライバシーとセキュリティ → マイク で HerdrScribe を許可してください。") }
			return
		}
		let useSys = sysMode != "off"
		if useSys && !CGPreflightScreenCaptureAccess() {
			CGRequestScreenCaptureAccess()
			await MainActor.run { showAlert("相手の音声を取るには「画面収録」の許可が要ります。\nシステム設定 → プライバシーとセキュリティ → 画面とシステムオーディオの録音 で HerdrScribe を許可し、HerdrScribe を終了して開き直してください。\n(マイクだけで始めるなら、メニューで『相手の音声: 取り込まない』を選んでください)") }
			return
		}
		do {
			let df = DateFormatter(); df.dateFormat = "yyyy-MM-dd_HHmm"
			let base = outDir.appendingPathComponent(df.string(from: Date()))
			mdURL = base.appendingPathExtension("md")
			baseURL = base
			try "# 会議メモ \(df.string(from: Date()))\n\n".write(to: mdURL!, atomically: true, encoding: .utf8)
			startedAt = Date(); finals = []; volatiles = [:]
			await MainActor.run { self.panel.orderFrontRegardless(); self.volatiles["自分"] = "聞いています…"; self.render() }

			let mic = Channel(label: "自分", lang: micLang, fileURL: base.appendingPathExtension("m4a"))
			channels = [mic]
			try await wire(mic)
			let engine = AVAudioEngine()
			self.engine = engine
			let input = engine.inputNode
			input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buf, _ in mic.feed(buf) }
			engine.prepare()
			try engine.start()

			if useSys {
				let sys = Channel(label: "相手", lang: sysMode, fileURL: URL(fileURLWithPath: base.path + "_system.m4a"))
				channels.append(sys)
				try await wire(sys)
				tap.handler = { buf in sys.feed(buf) }
				let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
				guard let display = content.displays.first else { throw NSError(domain: "scribe", code: 3, userInfo: [NSLocalizedDescriptionKey: "ディスプレイが見つからない"]) }
				let cfg = SCStreamConfiguration()
				cfg.capturesAudio = true
				cfg.excludesCurrentProcessAudio = true
				cfg.sampleRate = 48000
				cfg.channelCount = 1
				cfg.width = 2; cfg.height = 2 // 映像は使わないので最小に
				cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
				let s = SCStream(filter: SCContentFilter(display: display, excludingApplications: [], exceptingWindows: []), configuration: cfg, delegate: nil)
				try s.addStreamOutput(tap, type: .audio, sampleHandlerQueue: DispatchQueue(label: "scribe.system"))
				try await s.startCapture()
				scStream = s
			}
			await MainActor.run { self.running = true; self.setIcon("🔴"); self.toggleItem.title = "停止  ⌃⌥⌘R" }
		} catch {
			await stop()
			await MainActor.run { self.showAlert("開始できませんでした: \(error)") }
		}
	}

	func stop() async {
		engine?.inputNode.removeTap(onBus: 0)
		engine?.stop()
		engine = nil
		try? await scStream?.stopCapture()
		scStream = nil
		tap.handler = nil
		for c in channels { await c.finish() }
		let micCh = channels.first, sysCh = channels.count > 1 ? channels[1] : nil
		channels = []
		if let base = baseURL, micCh != nil {
			let iso = ISO8601DateFormatter()
			var meta: [String: Any] = ["name": base.lastPathComponent, "micLang": micCh!.lang, "micStart": iso.string(from: micCh!.firstBufferAt ?? startedAt)]
			if let s = sysCh { meta["sysLang"] = s.lang; meta["sysStart"] = iso.string(from: s.firstBufferAt ?? startedAt) }
			if let d = try? JSONSerialization.data(withJSONObject: meta) { try? d.write(to: URL(fileURLWithPath: base.path + ".meta.json")) }
			await MainActor.run { self.refine(base) }
		}
		let u = mdURL
		await MainActor.run { self.running = false; self.setIcon("🎙"); self.toggleItem.title = "開始  ⌃⌥⌘R" }
		_ = u
	}

	func showAlert(_ s: String) { let a = NSAlert(); a.messageText = "HerdrScribe"; a.informativeText = s; a.runModal() }

	// ⌃⌥⌘R で開始/停止(Carbon のグローバルホットキー。追加の権限は不要)
	func registerHotKey() {
		var ref: EventHotKeyRef?
		RegisterEventHotKey(UInt32(kVK_ANSI_R), UInt32(controlKey | optionKey | cmdKey), EventHotKeyID(signature: OSType(0x48535243), id: 1), GetApplicationEventTarget(), 0, &ref)
		var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
		InstallEventHandler(GetApplicationEventTarget(), { _, _, ud in
			Unmanaged<Scribe>.fromOpaque(ud!).takeUnretainedValue().toggle()
			return noErr
		}, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), nil)
	}
}

// Stream Deck など外からの操作用(この Mac の内側 127.0.0.1:18868 だけ)  GET /toggle /start /stop /status
func startControlServer(_ scribe: Scribe) {
	let params = NWParameters.tcp
	params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: 18868)
	guard let listener = try? NWListener(using: params) else { return }
	listener.newConnectionHandler = { conn in
		conn.start(queue: .main)
		conn.receive(minimumIncompleteLength: 1, maximumLength: 2048) { data, _, _, _ in
			let line = String(data: data ?? Data(), encoding: .utf8)?.components(separatedBy: "\r\n").first ?? ""
			let path = line.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
			switch path {
			case "/toggle": scribe.toggle()
			case "/start": if !scribe.running { scribe.toggle() }
			case "/stop": if scribe.running { scribe.toggle() }
			default: break
			}
			let body = scribe.running ? "running" : "idle"
			let resp = "HTTP/1.1 200 OK\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
			conn.send(content: resp.data(using: .utf8), completion: .contentProcessed { _ in conn.cancel() })
		}
	}
	listener.start(queue: .main)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = Scribe()
app.delegate = delegate
startControlServer(delegate)
app.run()
