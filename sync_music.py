#!/usr/bin/env python3
"""SoundCloud Likes (いいね一覧) から更新分を取得し、再生時間と雰囲気でラベリングしてカタログに保存する。

使い方:
  python3 sync_music.py            更新分 (新しくいいねした曲) を取得してカタログに差分マージ
  python3 sync_music.py --force    全件再取得
  python3 sync_music.py --stats    カテゴリごとの曲数と合計時間を表示
  python3 sync_music.py --list [カテゴリ]  指定カテゴリの曲一覧を表示 (例: --list long)
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_URL = os.environ.get("SOUNDCLOUD_LIKES_URL", "https://soundcloud.com/your-account/likes")
CONFIG_FILE = Path(os.environ.get("HERDR_MUSIC_CONFIG", Path.home() / ".config" / "herdr-music.json"))
CATALOG_FILE = Path(os.environ.get("HERDR_MUSIC_CATALOG", Path.home() / ".config" / "herdr-music-catalog.json"))
USER_TAGS_FILE = Path(os.environ.get("HERDR_MUSIC_USER_TAGS", Path.home() / ".config" / "herdr-music-user-tags.json"))

DEFAULT_CATEGORIES = {
    "all": {"name": "全曲", "emoji": "🎲", "color": "#f26f23", "description": "いいねした全曲"},
    "long": {"name": "長尺BGM", "emoji": "🎯", "color": "#ff5500", "description": "30分以上の作業用Mix・セット"},
    "short": {"name": "短曲", "emoji": "🎵", "color": "#3399ff", "description": "10分未満のトラック"},
    "chill": {"name": "チル・静か", "emoji": "☕", "color": "#66bb6a", "description": "Ambient, Lo-Fi, Piano, 静かなBGM"},
    "upbeat": {"name": "気分転換", "emoji": "⚡", "color": "#ffb300", "description": "テンポの良い曲・エネルギッシュ"},
    "focus": {"name": "作業没入", "emoji": "🎧", "color": "#ab47bc", "description": "長尺アンビエント・集中用BGM"},
    "acid-pauli": {"name": "Acid Pauli", "emoji": "🌀", "color": "#8e24aa", "description": "Acid Pauli DJ Sets & Mixes"},
    "soundtrack": {"name": "映画音楽", "emoji": "🎬", "color": "#e53935", "description": "映画・ドラマ・ゲームのサントラ・劇伴"},
    "piano": {"name": "ピアノ", "emoji": "🎹", "color": "#4a90e2", "description": "ピアノ主体の楽曲・ソロ・協奏曲"},
    "guitar-strings": {"name": "ギター・弦楽器", "emoji": "🎸", "color": "#e67e22", "description": "ギター、バイオリン、チェロ等の弦楽器"},
    "guitar": {"name": "ギター", "emoji": "🎸", "color": "#d97706", "description": "アコースティック・クラシックギター等"},
    "strings": {"name": "弦楽器", "emoji": "🎻", "color": "#8b5cf6", "description": "バイオリン、チェロ、ハープ等の弦楽"},
    "oriental": {"name": "オリエンタル", "emoji": "🕌", "color": "#0d9488", "description": "東洋・中東・アラビック・民族音楽・Orient"},
    "latin": {"name": "ラテン", "emoji": "💃", "color": "#e11d48", "description": "ボサノバ・タンゴ・サンバ・ラテン音楽"},
    "witcher": {"name": "Witcher", "emoji": "🐺", "color": "#78716c", "description": "The Witcher・Gwent・ファンタジーサントラ"},
}


def load_user_tags() -> dict:
    if USER_TAGS_FILE.exists():
        try:
            return json.loads(USER_TAGS_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def load_config() -> dict:
    if CONFIG_FILE.exists():
        try:
            return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"enabled": True, "url": DEFAULT_URL}


def load_catalog() -> dict:
    if CATALOG_FILE.exists():
        try:
            data = json.loads(CATALOG_FILE.read_text(encoding="utf-8"))
            if "categories" not in data:
                data["categories"] = DEFAULT_CATEGORIES
            return data
        except Exception:
            pass
    return {
        "updated_at": "",
        "categories": DEFAULT_CATEGORIES,
        "tracks": [],
    }


def save_catalog(catalog: dict):
    CATALOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CATALOG_FILE.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def fetch_credentials(profile_url: str) -> tuple[str, str]:
    """プロフィール/Likes ページの HTML から apiClient id と user id を取得する。"""
    req = urllib.request.Request(
        profile_url,
        headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"},
    )
    html = urllib.request.urlopen(req, timeout=15).read().decode("utf-8", "ignore")

    client_id = None
    m_client = re.search(r"\"hydratable\":\"apiClient\",\"data\":\{\"id\":\"([^\"]+)\"", html)
    if m_client:
        client_id = m_client.group(1)
    else:
        m_alt = re.search(r"client_id=([a-zA-Z0-9]{32})", html)
        if m_alt:
            client_id = m_alt.group(1)

    user_id = None
    m_user = re.search(r"\"hydratable\":\"user\",\"data\":\{.*?\"id\":(\d+)", html)
    if m_user:
        user_id = m_user.group(1)

    if not client_id or not user_id:
        raise RuntimeError(f"SoundCloud の認証情報取得に失敗しました (client_id: {client_id}, user_id: {user_id})")

    return client_id, user_id


def classify_track(raw_item: dict) -> tuple[list[str], list[str]]:
    """再生時間とメタデータから categories と tags を自動判定する。"""
    duration_sec = (raw_item.get("duration") or 0) / 1000.0
    title = (raw_item.get("title") or "").lower()
    genre = (raw_item.get("genre") or "").lower()
    tag_list = (raw_item.get("tag_list") or "").lower()
    combined = f"{title} {genre} {tag_list}"

    categories = ["all"]
    tags = []

    # 1. 長さ判定
    if duration_sec >= 1800:
        categories.append("long")
        tags.append("long")
    elif duration_sec < 600:
        categories.append("short")
        tags.append("short")
    else:
        tags.append("mid")

    if any(k in title for k in ["mix", "dj set", "continuous mix", "1 hour", "2 hour", "3 hour", "4 hour"]):
        if "long" not in categories:
            categories.append("long")
        tags.append("mix")

    # 2. 雰囲気判定
    chill_keywords = [
        "ambient", "chill", "lofi", "lo-fi", "downtempo", "relax", "sleep", "meditation",
        "study", "piano", "acoustic", "calm", "drone", "peaceful", "soundtrack", "soundtracks"
    ]
    upbeat_keywords = [
        "upbeat", "energetic", "dance", "club", "house", "techno", "trance", "edm",
        "drum & bass", "dnb", "dubstep", "synthwave", "funk", "disco", "electro", "party",
        "anime", "rock", "hardstyle"
    ]
    focus_keywords = ["focus", "deep focus", "work", "coding", "concentration", "brainwave"]

    is_chill = any(k in combined for k in chill_keywords)
    is_upbeat = any(k in combined for k in upbeat_keywords)
    is_focus = any(k in combined for k in focus_keywords)

    if is_chill or ("long" in categories and not is_upbeat):
        categories.append("chill")
        tags.append("chill")

    if is_upbeat:
        categories.append("upbeat")
        tags.append("upbeat")

    if is_focus or ("long" in categories and "chill" in categories):
        categories.append("focus")
        tags.append("focus")

    # 3. Acid Pauli
    if "acid pauli" in combined:
        categories.append("acid-pauli")
        tags.append("acid-pauli")

    # 4. 映画音楽・サントラ
    soundtrack_keywords = [
        "soundtrack", "soundtracks", "ost", "score", "scores", "film", "movie", "cinema",
        "original score", "theme", "hans zimmer", "ramin djawadi", "morricone", "williams",
        "batman", "valhalla", "witcher", "interstellar", "dune"
    ]
    if any(k in combined for k in soundtrack_keywords):
        categories.append("soundtrack")
        tags.append("soundtrack")

    # 5. 楽器判定 (ピアノ / ギター / 弦楽器)
    re_piano = re.compile(r"\b(piano[s]?|pianist|keyboard|klavier)\b", re.IGNORECASE)

    # ギター判定: クラシックギター・アコギ・ボサノバギター等を採用、エレキギター・メタル・ロック系を除外
    re_guitar_core = re.compile(r"\b(guitars?|guitarist|guitares?|guitarras?|classical guitar|acoustic guitar|fingerstyle|flamenco|bonfa)\b", re.IGNORECASE)
    re_acoustic_genre = re.compile(r"\bacoustic\b", re.IGNORECASE)
    re_bossa = re.compile(r"\b(bossanova|bossa nova)\b", re.IGNORECASE)
    re_electric = re.compile(r"\b(electric|electric guitar|metal|hard rock|shred|distortion|overdrive|heroes of might and magic)\b", re.IGNORECASE)

    # 弦楽器判定: バイオリン、チェロ、ハープ等 (ギターとは区別)
    re_strings = re.compile(r"\b(strings?|violin[s]?|viola|cello|cellist|harp|fiddle|contrabass)\b", re.IGNORECASE)

    is_piano = bool(re_piano.search(combined))
    
    is_electric = bool(re_electric.search(combined))
    is_guitar_match = (
        bool(re_guitar_core.search(combined)) or
        bool(re_acoustic_genre.search(genre)) or
        (bool(re_bossa.search(genre)) and duration_sec < 600 and "civic club" not in combined and "dj mix" not in combined)
    )
    is_guitar = is_guitar_match and not is_electric
    
    is_strings = bool(re_strings.search(combined))

    if is_piano:
        categories.append("piano")
        tags.append("piano")

    if is_guitar:
        categories.append("guitar")
        tags.append("guitar")

    if is_strings:
        categories.append("strings")
        tags.append("strings")

    if is_guitar or is_strings:
        categories.append("guitar-strings")
        tags.append("guitar-strings")

    # 6. Oriental (東洋・中東・アラビック・民族音楽・Orient)
    oriental_words = [
        r"oriental", r"orient", r"eastern", r"arabic", r"arabian", r"middle[\s-]east(ern)?",
        r"turkish", r"ottoman", r"persian", r"iranian", r"egyptian",
        r"taqaseem", r"sufi", r"dervish", r"oud", r"ney", r"nay", r"kanun", r"qanun", r"duduk", r"sitar",
        r"shakuhachi", r"shamisen", r"koto", r"erhu", r"guzheng", r"pipa",
        r"ainu", r"silk[\s-]road", r"bedouin", r"nomad(ic)?", r"morocco", r"sultan", r"fikriye",
        r"tamavra", r"spanoudakis", r"fahir"
    ]
    oriental_artists = [
        "khaled al kammar", "fahir atakoğlu", "fahir atakoglu", "wesam joubran",
        "peyman khazeni", "soheil peyghambari", "armand amar", "yasmine elbakly",
        "adel hakki", "stamatis spanoudakis", "tigran", "azaiez yacine", "oki dub ainu band",
        "mina el solimany", "karen homayounfar", "karim shæri", "karim shaeri",
        "discovery sound"
    ]
    re_oriental_words = re.compile(r"\b(" + "|".join(oriental_words) + r")\b", re.IGNORECASE)
    re_arabic_script = re.compile(r"[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]")

    is_oriental_word = bool(re_oriental_words.search(combined))
    raw_artist = (raw_item.get("user", {}).get("username") or raw_item.get("artist") or "").lower()
    is_oriental_artist = any(a in raw_artist for a in oriental_artists)
    is_arabic_title = bool(re_arabic_script.search(f"{title} {genre}"))

    # 特定の誤判定を除外 (Interstellar, Duneサントラ等)
    is_excluded = ("interstellar" in combined and "zimmer" in combined) or ("soundtrack" in title and "dune" in title)

    if (is_oriental_word or is_oriental_artist or is_arabic_title) and not is_excluded:
        categories.append("oriental")
        tags.append("oriental")

    # 7. Latin (ボサノバ・タンゴ・サンバ・フラメンコ・ラテン・クンビア)
    latin_words = [
        r"latin", r"latino", r"latina", r"bossa", r"bossanova", r"bossa[\s-]nova",
        r"samba", r"tango", r"flamenco", r"cumbia", r"salsa", r"mambo",
        r"choro", r"buena[\s-]vista", r"brazilian?", r"brazil", r"cuban?"
    ]
    re_latin = re.compile(r"\b(" + "|".join(latin_words) + r")\b", re.IGNORECASE)
    if bool(re_latin.search(combined)):
        categories.append("latin")
        tags.append("latin")

    # 8. Witcher (The Witcher・Gwent・サントラ・作曲者)
    witcher_words = [
        r"witcher", r"geralt", r"gwent", r"velen", r"skellige", r"novigrad",
        r"kaer[\s-]morhen", r"wild[\s-]hunt", r"hearts[\s-]of[\s-]stone",
        r"blood[\s-]and[\s-]wine", r"toussaint", r"thronebreaker",
        r"marcin[\s-]przybylowicz", r"mikolai[\s-]stroinski", r"percival"
    ]
    re_witcher = re.compile(r"\b(" + "|".join(witcher_words) + r")\b", re.IGNORECASE)
    if bool(re_witcher.search(combined)):
        categories.append("witcher")
        tags.append("witcher")

    # 重複排除
    return list(dict.fromkeys(categories)), list(dict.fromkeys(tags))


def sync(force=False) -> dict:
    cfg = load_config()
    profile_url = cfg.get("url", DEFAULT_URL)
    catalog = load_catalog()

    print(f"SoundCloud 情報を取得中: {profile_url}")
    client_id, user_id = fetch_credentials(profile_url)
    print(f"認証取得完了: user_id={user_id}, client_id={client_id[:6]}...")

    existing_tracks = {t["url"]: t for t in catalog.get("tracks", [])}
    user_tags = load_user_tags()
    new_tracks_count = 0
    page_count = 0

    next_url = f"https://api-v2.soundcloud.com/users/{user_id}/likes?client_id={client_id}&limit=50"

    collected = []
    stopped_early = False

    while next_url:
        page_count += 1
        req = urllib.request.Request(
            next_url,
            headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"},
        )
        try:
            resp = urllib.request.urlopen(req, timeout=20)
            data = json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            print(f"APIリクエストエラー: {e}")
            break

        collection = data.get("collection", [])
        if not collection:
            break

        page_new = 0
        for item in collection:
            raw = item.get("track") or item.get("playlist")
            if not raw:
                continue

            url = raw.get("permalink_url")
            if not url:
                continue

            # 既存かつ force でない場合、差分取得完了とみなして停止
            if not force and url in existing_tracks:
                stopped_early = True
                break

            dur_ms = raw.get("duration") or 0
            dur_sec = dur_ms / 1000.0
            cats, tags = classify_track(raw)

            # 既存曲がある場合は手動編集された categories / tags を維持
            if url in existing_tracks:
                existing = existing_tracks[url]
                cats = existing.get("categories", cats)
                tags = existing.get("tags", tags)

            # ユーザーカスタムタグがあればマージ
            manual = user_tags.get(url, [])
            for m in manual:
                if m not in cats:
                    cats.append(m)
                if m not in tags:
                    tags.append(m)
            if "guitar" in cats or "strings" in cats:
                if "guitar-strings" not in cats:
                    cats.append("guitar-strings")

            entry = {
                "url": url,
                "title": raw.get("title", ""),
                "artist": raw.get("user", {}).get("username", ""),
                "duration": round(dur_sec),
                "genre": raw.get("genre") or "",
                "categories": cats,
                "tags": tags,
                "kind": raw.get("kind", "track"),
                "liked_at": item.get("created_at", ""),
            }
            collected.append(entry)
            page_new += 1

        new_tracks_count += page_new
        print(f"  ページ {page_count}: {page_new} 件の新着曲を取得 (累計: {len(collected)} 件)")

        if stopped_early:
            print("  既知の曲に到達したため、更新分の取得を完了しました。")
            break

        next_url = data.get("next_href")
        if next_url and "client_id=" not in next_url:
            next_url += f"&client_id={client_id}"
        time.sleep(0.5)

    # 差分マージ（新規曲を先頭に、既存曲と結合）
    final_tracks = []
    seen = set()

    for t in collected:
        if t["url"] not in seen:
            seen.add(t["url"])
            final_tracks.append(t)

    for t in catalog.get("tracks", []):
        if t["url"] not in seen:
            seen.add(t["url"])
            final_tracks.append(t)

    catalog["updated_at"] = datetime.now(timezone.utc).isoformat()
    catalog["tracks"] = final_tracks
    save_catalog(catalog)

    print(f"\n同期完了: 合計 {len(final_tracks)} 曲 (今回の更新: {new_tracks_count} 曲)")
    return catalog


def print_stats(catalog: dict):
    tracks = catalog.get("tracks", [])
    cats = catalog.get("categories", DEFAULT_CATEGORIES)
    print(f"=== Herdr 音楽カタログ統計 (全 {len(tracks)} 曲) ===")
    print(f"最終更新: {catalog.get('updated_at', '未記録')}\n")

    for cat_id, cat_info in cats.items():
        matched = [t for t in tracks if cat_id in t.get("categories", [])]
        total_sec = sum(t.get("duration", 0) for t in matched)
        hours = total_sec // 3600
        mins = (total_sec % 3600) // 60
        time_str = f"{hours}時間{mins}分" if hours > 0 else f"{mins}分"
        print(f"{cat_info.get('emoji', '•')} {cat_info.get('name', cat_id):<10} ({cat_id}): {len(matched):4d} 曲  [合計 {time_str}] - {cat_info.get('description', '')}")


def print_list(catalog: dict, category: str):
    tracks = catalog.get("tracks", [])
    if category and category != "all":
        tracks = [t for t in tracks if category in t.get("categories", [])]

    print(f"=== カテゴリ [{category}] の曲一覧 ({len(tracks)} 件) ===")
    for i, t in enumerate(tracks[:100], 1):
        mins = t.get("duration", 0) // 60
        secs = t.get("duration", 0) % 60
        cats = ",".join(t.get("categories", []))
        print(f"{i:3d}. [{mins:2d}:{secs:02d}] {t.get('title')} ({t.get('artist')}) [{cats}]")
    if len(tracks) > 100:
        print(f"... 他 {len(tracks) - 100} 件")


def reclassify(catalog: dict):
    catalog["categories"] = DEFAULT_CATEGORIES
    user_tags = load_user_tags()
    count = 0
    for t in catalog.get("tracks", []):
        url = t.get("url", "")
        orig_tags = [tg for tg in t.get("tags", []) if tg not in DEFAULT_CATEGORIES]
        raw = {
            "duration": (t.get("duration", 0) * 1000),
            "title": t.get("title", ""),
            "artist": t.get("artist", ""),
            "genre": t.get("genre", ""),
            "tag_list": " ".join(orig_tags)
        }
        cats, tags = classify_track(raw)
        # ユーザー手動付与タグをマージ
        manual = user_tags.get(url, [])
        for m in manual:
            if m not in cats:
                cats.append(m)
            if m not in tags:
                tags.append(m)
        if "guitar" in cats or "strings" in cats:
            if "guitar-strings" not in cats:
                cats.append("guitar-strings")
        t["categories"] = cats
        t["tags"] = tags
        count += 1
    save_catalog(catalog)
    print(f"{count} 曲のカテゴリを再判定・更新しました。")


def main():
    parser = argparse.ArgumentParser(description="SoundCloud Likes 更新分取得＆ラベリング")
    parser.add_argument("--force", action="store_true", help="全件を再取得する")
    parser.add_argument("--stats", action="store_true", help="カテゴリごとの統計を表示する")
    parser.add_argument("--list", type=str, nargs="?", const="all", help="指定カテゴリの曲一覧を表示")
    parser.add_argument("--reclassify", action="store_true", help="既存カタログの全曲を新しいルールで再分類する")
    args = parser.parse_args()

    if args.stats:
        catalog = load_catalog()
        print_stats(catalog)
        return

    if args.list:
        catalog = load_catalog()
        print_list(catalog, args.list)
        return

    if args.reclassify:
        catalog = load_catalog()
        reclassify(catalog)
        print_stats(catalog)
        return

    sync(force=args.force)
    catalog = load_catalog()
    print()
    print_stats(catalog)


if __name__ == "__main__":
    main()
