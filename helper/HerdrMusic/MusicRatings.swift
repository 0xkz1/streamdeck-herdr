import Foundation

struct MusicRating: Codable, Equatable {
    var rating: Int
    var title: String
    var artist: String
    var updatedAt: String
    var remainingPlays: Int?
}

struct MusicRatings {
    var file = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/herdr-music-ratings.json")
    static let filters = ["all", "unrated", "1", "2", "3", "4", "5", "4+"]

    func load() throws -> [String: MusicRating] {
        guard FileManager.default.fileExists(atPath: file.path) else { return [:] }
        let entries = try JSONDecoder().decode([String: MusicRating].self, from: Data(contentsOf: file))
        guard entries.values.allSatisfy({ (1...5).contains($0.rating) }) else {
            throw NSError(domain: "HerdrMusic", code: 1, userInfo: [NSLocalizedDescriptionKey: "評価ファイルの値が不正です"])
        }
        return entries
    }

    func save(url: String, value: Int, title: String, artist: String, remainingPlays: Int? = nil) throws {
        guard (0...5).contains(value), let source = URL(string: url), source.scheme == "https", source.host == "soundcloud.com", source.path.split(separator: "/").count >= 2 else {
            throw NSError(domain: "HerdrMusic", code: 2, userInfo: [NSLocalizedDescriptionKey: "曲または評価が不正です"])
        }
        var entries = try load()
        if value == 0 {
            entries.removeValue(forKey: url)
        } else {
            let plays: Int?
            if let explicit = remainingPlays {
                plays = explicit
            } else if value == 1 {
                plays = 0
            } else if value == 2 {
                // 既に★2が付いている曲で再評価された場合は据え置き（除外確定: 0）、新規★2ならあと1回再生（1）
                if let existing = entries[url], existing.rating == 2 {
                    plays = 0
                } else {
                    plays = 1
                }
            } else {
                plays = nil
            }
            entries[url] = MusicRating(rating: value, title: title, artist: artist, updatedAt: ISO8601DateFormatter().string(from: Date()), remainingPlays: plays)
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(entries)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: file, options: .atomic)
    }

    func consumeReplay(url: String) throws {
        var entries = try load()
        guard var entry = entries[url], entry.rating == 2 else { return }
        entry.remainingPlays = 0
        entry.updatedAt = ISO8601DateFormatter().string(from: Date())
        entries[url] = entry
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(entries)
        try data.write(to: file, options: .atomic)
    }

    static func matches(_ rating: Int, remainingPlays: Int? = nil, filter: String) -> Bool {
        if filter == "all" {
            if rating == 1 { return false }
            if rating == 2 { return (remainingPlays ?? 1) > 0 }
            return true
        }
        if filter == "unrated" { return rating == 0 }
        if filter == "4+" { return rating >= 4 }
        return Int(filter) == rating
    }

    static func matches(_ entry: MusicRating?, filter: String) -> Bool {
        return matches(entry?.rating ?? 0, remainingPlays: entry?.remainingPlays, filter: filter)
    }
}
