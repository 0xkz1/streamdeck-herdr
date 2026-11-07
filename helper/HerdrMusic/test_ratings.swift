import AppKit
import WebKit

func runMusicRatingsTests() {
    func check(_ condition: @autoclosure () throws -> Bool) throws {
        let passed = try condition()
        assert(passed)
    }
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: folder) }
    let store = MusicRatings(file: folder.appendingPathComponent("ratings.json"))
    let first = "https://soundcloud.com/test/first"
    let second = "https://soundcloud.com/test/second"
    do {
        try check(try store.load().isEmpty)
        try store.save(url: first, value: 4, title: "First", artist: "Artist")
        try store.save(url: second, value: 5, title: "Second", artist: "Artist")
        let reloaded = try MusicRatings(file: store.file).load()
        assert(reloaded[first]?.rating == 4 && reloaded[second]?.rating == 5)
        try store.save(url: first, value: 2, title: "First", artist: "Artist")
        try check(try store.load()[first]?.rating == 2)
        try store.save(url: first, value: 0, title: "First", artist: "Artist")
        try check(try store.load()[first] == nil)
        let before = try Data(contentsOf: store.file)
        do { try store.save(url: second, value: 6, title: "", artist: ""); assertionFailure("invalid rating accepted") } catch {}
        try check(try Data(contentsOf: store.file) == before)
        assert(MusicRatings.matches(0, filter: "unrated"))
        assert(!MusicRatings.matches(0, filter: "1"))
        assert(MusicRatings.matches(5, filter: "4+"))
        assert(!MusicRatings.matches(3, filter: "4+"))

        // 星1と星2の選曲条件テスト
        assert(!MusicRatings.matches(1, filter: "all")) // 星1は次回再生しない
        assert(MusicRatings.matches(1, filter: "1"))   // 星1絞り込みでは再生可能
        assert(MusicRatings.matches(2, remainingPlays: 1, filter: "all")) // 星2はあと1回再生
        assert(!MusicRatings.matches(2, remainingPlays: 0, filter: "all")) // 星2で据え置き後は除外
        assert(MusicRatings.matches(2, remainingPlays: 0, filter: "2"))   // 星2絞り込みでは再生可能
        assert(MusicRatings.matches(3, filter: "all"))  // 星3以上は通常再生
        assert(MusicRatings.matches(0, filter: "all"))  // 未評価は通常再生

        _ = NSApplication.shared
        let player = MusicPlayer()
        player.web = WKWebView()
        player.ratings = store
        player.catalogTracks = [
            ["url": first, "title": "First", "categories": ["all", "chill"]],
            ["url": second, "title": "Second", "categories": ["all", "upbeat"]]
        ]
        assert(player.applyCategory("all", ratingFilter: "5"))
        assert(player.tracks == [second])
        assert(!player.applyCategory("chill", ratingFilter: "5"))
        assert(player.tracks.isEmpty && !player.wanted)
        assert(player.applyCategory("chill", ratingFilter: "unrated"))
        assert(player.tracks == [first])
        player.currentUrl = first; player.track = "First"; player.artist = "Artist"; player.hasPlayed = true
        assert(player.handle("/rate?value=3&url=\(second)", method: "POST")["error"] != nil)
        try check(try store.load()[first] == nil)
        assert(player.handle("/rate?value=3&url=\(first)")["error"] != nil)
        assert(player.handle("/rate?value=3&url=\(first)", method: "POST")["rating"] as? Int == 3)
        assert(player.tracks.isEmpty) // 未評価の再生対象から外れる。
        assert(player.handle("/ratings/data")["tracks"] != nil)
        assert(player.handle("/rate?value=0&url=\(first)", method: "POST")["rating"] as? Int == 0)

        // 未評価先出しキューのテスト（popLastが未評価から順に出る）
        let q = player.buildQueue(from: [second, first])
        assert(q.last == first)  // 末尾（先出し）が未評価のfirst
        assert(q.first == second) // 先頭（後出し）が評価済みのsecond

        // 星1評価の即時除外テスト
        assert(player.applyCategory("all", ratingFilter: "all"))
        assert(player.tracks.count == 2)
        player.currentUrl = first; player.track = "First"; player.artist = "Artist"; player.hasPlayed = true
        _ = player.handle("/rate?value=1&url=\(first)", method: "POST")
        assert(!player.tracks.contains(first)) // tracksから即座に除外
        assert(!player.remaining.contains(first)) // remainingからも即座に除外

        // 星2評価の「もう1回再生＋据え置きで除外」テスト
        player.currentUrl = second; player.track = "Second"; player.artist = "Artist"; player.hasPlayed = true
        _ = player.handle("/rate?value=2&url=\(second)", method: "POST")
        try check(try store.load()[second]?.remainingPlays == 1) // 初回は残り1回
        // 最初のセッション終了時はまだ消費されない（この回で付けたため）
        player.finishCurrentTrack()
        try check(try store.load()[second]?.remainingPlays == 1)
        // 次の選曲で再度選ばれて再生されたとする
        player.selectTrack()
        player.hasPlayed = true
        assert(!player.ratingAssignedThisPlay)
        // 評価を変更せず再生終了
        player.finishCurrentTrack()
        try check(try store.load()[second]?.remainingPlays == 0) // 据え置きにより消費
        // 以降は全曲再生に含まれない（全曲が除外されたため該当なし）
        assert(!player.applyCategory("all", ratingFilter: "all"))
        assert(player.tracks.isEmpty)
        // ただし★2絞り込みでは再生可能
        assert(player.applyCategory("all", ratingFilter: "2"))
        assert(player.tracks == [second])
        // ★1絞り込みでも再生可能
        assert(player.applyCategory("all", ratingFilter: "1"))
        assert(player.tracks == [first])

        player.catalogTracks = []
        assert(!player.applyCategory("all", ratingFilter: "4+"))
        assert(player.errorText.contains("BGM更新"))

        // 壊れた評価ファイルを「空」と扱って上書きしない。
        let broken = Data("broken json".utf8)
        try broken.write(to: store.file)
        do { try store.save(url: first, value: 1, title: "", artist: ""); assertionFailure("corrupt file overwritten") } catch {}
        try check(try Data(contentsOf: store.file) == broken)
        print("PASS: persistence, overwrite, clear, validation, rating/category filters, empty selection, stale-track rejection, corrupt-file preservation")
    } catch { fatalError("Music ratings test failed: \(error)") }
}
