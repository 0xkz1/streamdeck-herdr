// SoundCloud公式Widget APIを使う、HerdrのBGMプレイヤー。
import AppKit
import WebKit
import Network

final class MusicPlayer: NSObject, NSApplicationDelegate, WKScriptMessageHandler, NSWindowDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var likes: WKWebView!
    var tracks: [String] = []
    var remaining: [String] = []
    var waitingForNext = false
    var trackIndex = -1
    var scanIdle = 0
    var scanning = false
    var scanned = false
    var ticks = 0
    var listener: NWListener!
    var timer: Timer!
    var wanted = false
    var issued = false
    var ready = false
    var playing = false
    var hasPlayed = false
    var position = 0.0
    var track = ""
    var errorText = ""
    var requestedAt = Date.distantPast
    var sleeping: Bool { FileManager.default.fileExists(atPath: NSHomeDirectory() + "/.config/herdr-sleeping") }

    func applicationDidFinishLaunching(_ notification: Notification) {
        var source = "https://soundcloud.com/your-account/likes"
        let file = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/herdr-music.json")
        if let data = try? Data(contentsOf: file), let cfg = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let value = cfg["url"] as? String, let url = URL(string: value), url.scheme == "https", url.host == "soundcloud.com" { source = value }
        let configuration = WKWebViewConfiguration()
        configuration.mediaTypesRequiringUserActionForPlayback = []
        if #available(macOS 14.5, *) { configuration.preferences.inactiveSchedulingPolicy = .none }
        configuration.userContentController.add(self, name: "music")
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 760, height: 480), configuration: configuration)
        let likesConfiguration = WKWebViewConfiguration()
        if #available(macOS 14.5, *) { likesConfiguration.preferences.inactiveSchedulingPolicy = .none }
        likesConfiguration.applicationNameForUserAgent = "Version/26.0 Safari/605.1.15"
        likes = WKWebView(frame: web.frame, configuration: likesConfiguration)
        likes.load(URLRequest(url: URL(string: source)!))
        window = NSWindow(contentRect: web.frame, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Herdr — SoundCloud"
        window.contentView = web
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.center()
        if !CommandLine.arguments.contains("--background") { show() }
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: 18869)
        do { listener = try NWListener(using: parameters) }
        catch { NSApp.terminate(nil); return }
        listener.newConnectionHandler = { [weak self] connection in
            connection.start(queue: .main)
            connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { data, _, _, _ in
                let first = String(data: data ?? Data(), encoding: .utf8)?.components(separatedBy: "\r\n").first ?? ""
                let route = first.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
                let state = self?.handle(route) ?? [:]
                let body = (try? JSONSerialization.data(withJSONObject: state)) ?? Data("{}".utf8)
                var response = Data("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n".utf8)
                response.append(body)
                connection.send(content: response, completion: .contentProcessed { _ in connection.cancel() })
            }
        }
        listener.start(queue: .main)
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            self.advance()
            self.ticks += 1
            if self.ticks % 2 == 0 && !self.scanned { self.collectLikes() }
        }
    }

    func loadPlayer(_ source: String) {
        var url = URLComponents(string: "https://w.soundcloud.com/player/")!
        url.queryItems = [URLQueryItem(name: "url", value: source), URLQueryItem(name: "auto_play", value: "false")]
        web.loadHTMLString("""
        <!doctype html><html><meta name="viewport" content="width=device-width"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;background:#202020}</style>
        <iframe id="player" allow="autoplay" src="\(url.url!.absoluteString)"></iframe>
        <script src="https://w.soundcloud.com/player/api.js"></script><script>
        const widget=SC.Widget(document.getElementById('player'));
        const send=(type,data={})=>window.webkit.messageHandlers.music.postMessage({type,...data});
        widget.bind(SC.Widget.Events.READY,()=>send('ready'));
        widget.bind(SC.Widget.Events.PLAY,()=>{send('play');widget.getCurrentSound(s=>send('track',{title:s?.title||''}));});
        widget.bind(SC.Widget.Events.PAUSE,()=>send('pause'));
        widget.bind(SC.Widget.Events.FINISH,()=>send('finish'));
        widget.bind(SC.Widget.Events.PLAY_PROGRESS,e=>send('progress',{position:e.currentPosition}));
        widget.bind(SC.Widget.Events.ERROR,()=>send('error'));
        </script></html>
        """, baseURL: URL(string: "https://soundcloud.com"))
    }
    func collectLikes() {
        guard !scanning, !likes.isLoading else { return }
        scanning = true
        likes.evaluateJavaScript("""
        (()=>{const rows=[...document.querySelectorAll('.soundList__item')];
        const urls=rows.filter(row=>!row.querySelector('.sound')?.classList.contains('playlist')).map(row=>row.querySelector('a.soundTitle__title')?.href).filter(Boolean);
        window.scrollTo(0,document.body.scrollHeight);return JSON.stringify(urls);})()
        """) { value, _ in
            self.scanning = false
            guard let text = value as? String, let data = text.data(using: .utf8), let urls = try? JSONSerialization.jsonObject(with: data) as? [String] else { return }
            let before = self.tracks.count
            for url in urls where URL(string: url)?.host == "soundcloud.com" && !self.tracks.contains(url) {
                self.tracks.append(url)
                self.remaining.append(url)
            }
            if self.tracks.count != before { self.remaining.shuffle() }
            self.scanIdle = self.tracks.count == before ? self.scanIdle + 1 : 0
            if !self.tracks.isEmpty && self.scanIdle >= 6 { self.scanned = true }
            if self.trackIndex < 0 && !self.tracks.isEmpty && (self.wanted || self.scanned) { self.selectTrack() }
            else if self.waitingForNext && (!self.remaining.isEmpty || self.scanned) { self.nextTrack() }
        }
    }
    func selectTrack() {
        if remaining.isEmpty {
            remaining = tracks.shuffled()
            // 周回の境目でも同じ曲を続けない。
            if tracks.count > 1 && trackIndex >= 0 && remaining.last == tracks[trackIndex],
               let other = remaining.firstIndex(where: { $0 != tracks[trackIndex] }) {
                remaining.swapAt(other, remaining.count - 1)
            }
        }
        guard let source = remaining.popLast(), let index = tracks.firstIndex(of: source) else { return }
        trackIndex = index
        waitingForNext = false
        ready = false; issued = false; playing = false; hasPlayed = false; position = 0; requestedAt = Date()
        loadPlayer(source)
    }
    func nextTrack() {
        guard wanted, !sleeping, !tracks.isEmpty else { return }
        if remaining.isEmpty && !scanned { waitingForNext = true; playing = false; return }
        selectTrack()
    }
    func show() {
        window.contentView = tracks.isEmpty ? likes : web
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { sender.orderOut(nil); return false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { show(); return true }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let data = message.body as? [String: Any], let type = data["type"] as? String else { return }
        if type == "ready" { ready = true; advance() }
        if type == "play" { playing = true; hasPlayed = true; if !wanted || sleeping { pause() } }
        if type == "pause" { playing = false }
        if type == "finish" { nextTrack() }
        if type == "track" { track = data["title"] as? String ?? "" }
        if type == "progress" { position = data["position"] as? Double ?? 0 }
        if type == "error" { errorText = "SoundCloudのプレイヤーで再生を確認してください"; wanted = false }
    }
    func pause() { wanted = false; web.evaluateJavaScript("widget.pause()", completionHandler: nil) }
    func handle(_ route: String) -> [String: Any] {
        if route == "/open" { show() }
        else if route == "/play" { wanted = !sleeping; issued = false; hasPlayed = false; requestedAt = Date(); errorText = ""; advance() }
        else if route == "/pause" { pause() }
        else if route == "/next" { nextTrack() }
        else if route != "/status" { return ["error": "unknown action"] }
        return ["playing": playing, "loading": wanted && !hasPlayed && errorText.isEmpty, "ready": ready, "track": track, "position": position, "likesCount": tracks.count, "trackIndex": trackIndex, "remaining": remaining.count, "scanned": scanned, "shuffle": true, "error": errorText]
    }
    func advance() {
        if sleeping { if wanted || playing { pause() }; return }
        guard wanted else { return }
        if !hasPlayed && Date().timeIntervalSince(requestedAt) > 40 { wanted = false; errorText = "SoundCloudのプレイヤーで再生を確認してください"; return }
        if ready && !issued { issued = true; web.evaluateJavaScript("widget.play()", completionHandler: nil) }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let player = MusicPlayer()
app.delegate = player
app.run()
