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
    var catalogTracks: [[String: Any]] = []
    var currentCategory = "all"
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
    var duration = 0.0
    var track = ""
    var artist = ""
    var currentUrl = ""
    var history: [String] = []
    var errorText = ""
    var requestedAt = Date.distantPast
    var sleeping: Bool { FileManager.default.fileExists(atPath: NSHomeDirectory() + "/.config/herdr-sleeping") }
    var normalVolume = 40
    var duckVolume = 15
    var currentVolume = 40
    var duckCount = 0

    func saveVolumeConfig() {
        let file = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/herdr-music.json")
        var cfg: [String: Any] = [:]
        if let data = try? Data(contentsOf: file), let existing = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            cfg = existing
        }
        cfg["normalVolume"] = normalVolume
        cfg["duckVolume"] = duckVolume
        if let out = try? JSONSerialization.data(withJSONObject: cfg, options: [.prettyPrinted]) {
            try? out.write(to: file)
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        var source = "https://soundcloud.com/your-account/likes"
        let file = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/herdr-music.json")
        if let data = try? Data(contentsOf: file), let cfg = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let value = cfg["url"] as? String, let url = URL(string: value), url.scheme == "https", url.host == "soundcloud.com" { source = value }
            if let nv = cfg["normalVolume"] as? Int { normalVolume = max(0, min(100, nv)); currentVolume = normalVolume }
            if let dv = cfg["duckVolume"] as? Int { duckVolume = max(0, min(100, dv)) }
        }
        let configuration = WKWebViewConfiguration()
        configuration.mediaTypesRequiringUserActionForPlayback = []
        if #available(macOS 14.5, *) { configuration.preferences.inactiveSchedulingPolicy = .none }
        configuration.userContentController.add(self, name: "music")
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 760, height: 480), configuration: configuration)
        let likesConfiguration = WKWebViewConfiguration()
        if #available(macOS 14.5, *) { likesConfiguration.preferences.inactiveSchedulingPolicy = .none }
        likesConfiguration.applicationNameForUserAgent = "Version/26.0 Safari/605.1.15"
        likes = WKWebView(frame: web.frame, configuration: likesConfiguration)

        loadCatalog()
        if !scanned {
            likes.load(URLRequest(url: URL(string: source)!))
        }

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

    func loadCatalog() {
        let catalogFile = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/herdr-music-catalog.json")
        guard let data = try? Data(contentsOf: catalogFile),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = json["tracks"] as? [[String: Any]], !list.isEmpty else { return }
        catalogTracks = list
        applyCategory(currentCategory)
    }

    func applyCategory(_ cat: String) {
        currentCategory = cat
        guard !catalogTracks.isEmpty else { return }
        let filtered: [String]
        if cat == "all" || cat.isEmpty {
            filtered = catalogTracks.compactMap { $0["url"] as? String }
        } else {
            let matched = catalogTracks.filter {
                (($0["categories"] as? [String]) ?? []).contains(cat)
            }.compactMap { $0["url"] as? String }
            filtered = matched.isEmpty ? catalogTracks.compactMap { $0["url"] as? String } : matched
        }
        tracks = filtered
        remaining = tracks.shuffled()
        trackIndex = -1
        scanned = true
    }

    func loadPlayer(_ source: String) {
        var url = URLComponents(string: "https://w.soundcloud.com/player/")!
        url.queryItems = [URLQueryItem(name: "url", value: source), URLQueryItem(name: "auto_play", value: "false")]
        let targetVol = (duckCount > 0) ? duckVolume : normalVolume
        web.loadHTMLString("""
        <!doctype html><html><meta name="viewport" content="width=device-width"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;background:#202020}</style>
        <iframe id="player" allow="autoplay" src="\(url.url!.absoluteString)"></iframe>
        <script src="https://w.soundcloud.com/player/api.js"></script><script>
        const widget=SC.Widget(document.getElementById('player'));
        const send=(type,data={})=>window.webkit.messageHandlers.music.postMessage({type,...data});
        let currentVol=\(targetVol);
        let targetVol=\(targetVol);
        let volTimer=null;
        let isReady=false;
        function setPlayerVolume(t,d){
            t=Math.max(0,Math.min(100,Math.round(t)));
            targetVol=t;
            if(!isReady)return;
            if(!d||d<=0){
                if(volTimer){clearInterval(volTimer);volTimer=null;}
                currentVol=t;
                try{widget.setVolume(currentVol);}catch(e){}
                return;
            }
            if(volTimer)clearInterval(volTimer);
            const start=currentVol;
            const startTime=Date.now();
            volTimer=setInterval(()=>{
                const elapsed=Date.now()-startTime;
                const p=Math.min(1,elapsed/d);
                currentVol=Math.round(start+(t-start)*p);
                try{widget.setVolume(currentVol);}catch(e){}
                if(p>=1){clearInterval(volTimer);volTimer=null;}
            },25);
        }
        window.setPlayerVolume=setPlayerVolume;
        widget.bind(SC.Widget.Events.READY,()=>{
            isReady=true;
            try{widget.setVolume(targetVol);}catch(e){}
            currentVol=targetVol;
            send('ready');
        });
        widget.bind(SC.Widget.Events.PLAY,()=>{send('play');widget.getCurrentSound(s=>send('track',{title:s?.title||'',artist:s?.user?.username||'',duration:s?.duration||0}));});
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
        if !currentUrl.isEmpty && currentUrl != source {
            history.append(currentUrl)
            if history.count > 50 { history.removeFirst() }
        }
        trackIndex = index
        currentUrl = source
        waitingForNext = false
        ready = false; issued = false; playing = false; hasPlayed = false; position = 0; duration = 0; requestedAt = Date()
        if let info = catalogTracks.first(where: { ($0["url"] as? String) == source }) {
            track = info["title"] as? String ?? ""
            artist = info["artist"] as? String ?? ""
            if let d = info["duration"] as? Double { duration = d * 1000.0 }
            else if let d = info["duration"] as? Int { duration = Double(d) * 1000.0 }
        }
        loadPlayer(source)
    }

    func nextTrack(forcePlay: Bool = false) {
        if forcePlay {
            wanted = !sleeping
            issued = false
            hasPlayed = false
            requestedAt = Date()
            errorText = ""
        }
        guard (wanted || forcePlay), !sleeping, !tracks.isEmpty else { return }
        if remaining.isEmpty && !scanned { waitingForNext = true; playing = false; return }
        selectTrack()
        if wanted { advance() }
    }

    func prevTrack() {
        guard !sleeping else { return }
        if history.isEmpty {
            web.evaluateJavaScript("widget.seekTo(0)", completionHandler: nil)
            return
        }
        let previous = history.removeLast()
        if let idx = tracks.firstIndex(of: previous) {
            trackIndex = idx
        }
        currentUrl = previous
        waitingForNext = false
        ready = false; issued = false; playing = false; hasPlayed = false; position = 0; duration = 0; requestedAt = Date()
        if let info = catalogTracks.first(where: { ($0["url"] as? String) == previous }) {
            track = info["title"] as? String ?? ""
            artist = info["artist"] as? String ?? ""
            if let d = info["duration"] as? Double { duration = d * 1000.0 }
            else if let d = info["duration"] as? Int { duration = Double(d) * 1000.0 }
        }
        wanted = !sleeping
        loadPlayer(previous)
        advance()
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
        if type == "track" {
            track = data["title"] as? String ?? track
            if let a = data["artist"] as? String, !a.isEmpty { artist = a }
            if let d = data["duration"] as? Double, d > 0 { duration = d }
        }
        if type == "progress" { position = data["position"] as? Double ?? 0 }
        if type == "error" { errorText = "SoundCloudのプレイヤーで再生を確認してください"; wanted = false }
    }

    func pause() { wanted = false; web.evaluateJavaScript("widget.pause()", completionHandler: nil) }

    func duck(duration: Double? = nil) {
        duckCount += 1
        applyVolume(target: duckVolume, durationMs: 150)
        if let d = duration, d > 0 {
            Timer.scheduledTimer(withTimeInterval: d, repeats: false) { [weak self] _ in
                self?.unduck()
            }
        } else {
            Timer.scheduledTimer(withTimeInterval: 45.0, repeats: false) { [weak self] _ in
                guard let self = self, self.duckCount > 0 else { return }
                self.duckCount = max(0, self.duckCount - 1)
                if self.duckCount == 0 {
                    self.applyVolume(target: self.normalVolume, durationMs: 400)
                }
            }
        }
    }

    func unduck() {
        duckCount = max(0, duckCount - 1)
        if duckCount == 0 {
            applyVolume(target: normalVolume, durationMs: 400)
        }
    }

    func applyVolume(target: Int, durationMs: Int) {
        currentVolume = target
        web.evaluateJavaScript("window.setPlayerVolume && window.setPlayerVolume(\(target), \(durationMs))", completionHandler: nil)
    }

    func handle(_ route: String) -> [String: Any] {
        let components = URLComponents(string: route)
        let path = components?.path ?? route
        let queryCategory = components?.queryItems?.first(where: { $0.name == "category" })?.value

        if path == "/open" {
            if !currentUrl.isEmpty, let u = URL(string: currentUrl) {
                NSWorkspace.shared.open(u)
            } else {
                show()
            }
        } else if path.starts(with: "/play") {
            let catParam: String?
            if let q = queryCategory {
                catParam = q
            } else if path.hasPrefix("/play/") {
                catParam = String(path.dropFirst("/play/".count))
            } else {
                catParam = nil
            }

            let catChanged = catParam != nil && catParam != currentCategory
            if catChanged, let newCat = catParam {
                applyCategory(newCat)
                selectTrack()
            } else if trackIndex < 0 && !tracks.isEmpty {
                selectTrack()
            }

            wanted = !sleeping
            issued = false
            hasPlayed = false
            requestedAt = Date()
            errorText = ""
            advance()
        } else if path == "/pause" {
            pause()
        } else if path == "/next" {
            nextTrack(forcePlay: true)
        } else if path == "/prev" {
            prevTrack()
        } else if path.starts(with: "/category/") {
            let newCat = String(path.dropFirst("/category/".count))
            applyCategory(newCat)
            if wanted {
                selectTrack()
            }
        } else if path == "/duck" || path == "/duck/start" {
            let dur = components?.queryItems?.first(where: { $0.name == "duration" })?.value.flatMap(Double.init)
            duck(duration: dur)
        } else if path == "/duck/stop" || path == "/duck/end" || path == "/unduck" {
            unduck()
        } else if path.starts(with: "/volume") {
            if path == "/volume/up" {
                normalVolume = min(100, normalVolume + 10)
            } else if path == "/volume/down" {
                normalVolume = max(0, normalVolume - 10)
            } else if let levelStr = components?.queryItems?.first(where: { $0.name == "level" })?.value,
                      let level = Int(levelStr) {
                normalVolume = max(0, min(100, level))
            }
            duckVolume = max(5, normalVolume * 35 / 100)
            saveVolumeConfig()
            if duckCount == 0 {
                applyVolume(target: normalVolume, durationMs: 200)
            }
        } else if path == "/reload" {
            loadCatalog()
        } else if path != "/status" {
            return ["error": "unknown action"]
        }

        let posSec = position / 1000.0
        let durSec = duration / 1000.0
        let remSec = max(0, durSec - posSec)
        return [
            "playing": playing,
            "loading": wanted && !hasPlayed && errorText.isEmpty,
            "ready": ready,
            "track": track,
            "artist": artist,
            "url": currentUrl,
            "position": posSec,
            "duration": durSec,
            "remaining": remSec,
            "volume": currentVolume,
            "ducked": duckCount > 0,
            "likesCount": tracks.count,
            "trackIndex": trackIndex,
            "historyCount": history.count,
            "queueRemaining": remaining.count,
            "scanned": scanned,
            "shuffle": true,
            "category": currentCategory,
            "error": errorText
        ]
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
