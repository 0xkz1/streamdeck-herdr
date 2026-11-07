import { execFile, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { isSleeping } from "./power";
import { isMuted } from "./sound";

const FILE = `${process.env.HOME}/.config/herdr-music.json`;
const CATALOG_FILE = `${process.env.HOME}/.config/herdr-music-catalog.json`;
const USER_TAGS_FILE = `${process.env.HOME}/.config/herdr-music-user-tags.json`;
const BASE = "http://127.0.0.1:18869";
type Config = {
	enabled: boolean; url: string; category?: string; ratingFilter?: string;
	autoStart?: { enabled: boolean; minute: number };
	lastAutoStartSlot?: number;
};
export type State = {
	playing: boolean;
	loading: boolean;
	track: string;
	artist?: string;
	url?: string;
	category?: string;
	rating?: number;
	ratingFilter?: string;
	ratedCount?: number;
	duration?: number;
	position?: number;
	remaining?: number;
	volume?: number;
	ducked?: boolean;
	error: string;
	likesCount?: number;
};
let cfg: Config = { enabled: true, url: "https://soundcloud.com/your-account/likes", category: "all" };
let loaded = false, started = false, busy = false;
let checkedExisting = false;
let wanted = false;
let manual = false;
let quietNow = false;
let retryAt = 0;
let state: State = { playing: false, loading: false, track: "", artist: "", url: "", category: "all", duration: 0, position: 0, remaining: 0, error: "" };

function load() {
	if (loaded) return;
	loaded = true;
	try { cfg = { ...cfg, ...JSON.parse(readFileSync(FILE, "utf8")) }; }
	catch { writeFileSync(FILE, JSON.stringify(cfg, null, 2)); }
}

function scheduledSlot(now: number): number | undefined {
	const minute = cfg.autoStart?.minute;
	if (cfg.autoStart?.enabled !== true || typeof minute !== "number" || !Number.isInteger(minute) || minute < 0 || minute >= 60) return;
	const scheduled = new Date(now);
	scheduled.setMinutes(minute, 0, 0);
	const slot = scheduled.getTime();
	if (now >= slot && now - slot < 60_000) return slot;
}

async function call(route: string, method = "GET") {
	if (!started) {
		try { await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(1000) }); }
		catch {
			await new Promise<void>((resolve, reject) => execFile("/usr/bin/open", ["-gj", "-a", `${process.env.HOME}/Applications/HerdrMusic.app`, "--args", "--background"], (e) => e ? reject(e) : resolve()));
			for (let attempt = 0; attempt < 20; attempt++) {
				try { await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(1000) }); break; }
				catch { await new Promise((r) => setTimeout(r, 250)); }
			}
		}
		started = true;
	}
	if (route.startsWith("/play") && (!wanted || isSleeping() || isMuted())) route = "/pause";
	let response: Response;
	try { response = await fetch(`${BASE}${route}`, { method, signal: AbortSignal.timeout(5000) }); }
	catch (e) { started = false; throw e; }
	state = { ...state, ...await response.json() as State };
	if (state.error) throw new Error(state.error);
}

export const musicState = () => state;

export async function musicPause() {
	wanted = false;
	if (!started) return;
	await call("/pause");
}

export async function musicToggle(category = "all", ratingFilter = "all") {
	load();
	if (isSleeping()) return;
	if (busy) return;
	busy = true;
	try {
		const isCurrentlyPlayingThis = (state.playing || state.loading) && (state.category === category || (category === "all" && !state.category)) && (state.ratingFilter || "all") === ratingFilter;
		if (isCurrentlyPlayingThis) {
			// 同じカテゴリで再生中なら一時停止
			cfg.enabled = false;
			const slot = scheduledSlot(Date.now());
			if (slot !== undefined) cfg.lastAutoStartSlot = slot;
		} else {
			// 停止中、または別のカテゴリに切り替え
			cfg.enabled = true;
			cfg.category = category;
			cfg.ratingFilter = ratingFilter;
		}
		manual = cfg.enabled;
		retryAt = 0;
		writeFileSync(FILE, JSON.stringify(cfg, null, 2));
		wanted = cfg.enabled;
		const route = wanted ? `/play?category=${encodeURIComponent(category)}&rating=${encodeURIComponent(ratingFilter)}` : "/pause";
		await call(route);
	} catch (e) {
		wanted = false; manual = false; cfg.enabled = false;
		writeFileSync(FILE, JSON.stringify(cfg, null, 2));
		if (started) await fetch(`${BASE}/open`, { signal: AbortSignal.timeout(3000) }).catch(() => {});
		throw e;
	} finally { busy = false; }
}

export async function musicNext() {
	load();
	if (isSleeping() || busy) return;
	busy = true;
	try {
		cfg.enabled = true;
		manual = true;
		wanted = true;
		retryAt = 0;
		writeFileSync(FILE, JSON.stringify(cfg, null, 2));
		await call("/next");
	} finally { busy = false; }
}

export async function musicPrev() {
	load();
	if (isSleeping() || busy) return;
	busy = true;
	try {
		cfg.enabled = true;
		manual = true;
		wanted = true;
		retryAt = 0;
		writeFileSync(FILE, JSON.stringify(cfg, null, 2));
		await call("/prev");
	} finally { busy = false; }
}

export async function musicOpen() {
	if (!started) return;
	try {
		await call("/open");
	} catch { /* ignore */ }
}

export async function musicRate(value: number) {
	if (!Number.isInteger(value) || value < 0 || value > 5) throw new Error("評価は1〜5です");
	if (busy) throw new Error("曲を切り替え中です。もう一度押してください");
	busy = true;
	try {
		await call("/status");
		if (!state.url || !state.track || state.loading) throw new Error("評価する曲がありません");
		await call(`/rate?value=${value}&url=${encodeURIComponent(state.url)}`, "POST");
	} finally { busy = false; }
}

export async function musicRatingsOpen() { await call("/ratings/open"); }

type CatalogTrack = {
	url: string;
	title: string;
	artist?: string;
	categories?: string[];
	tags?: string[];
	[key: string]: unknown;
};

type CatalogData = {
	tracks: CatalogTrack[];
	[key: string]: unknown;
};

type UserTagsData = Record<string, string[]>;

function loadCatalogData(): CatalogData | undefined {
	try {
		return JSON.parse(readFileSync(CATALOG_FILE, "utf8")) as CatalogData;
	} catch {
		return undefined;
	}
}

function loadUserTagsData(): UserTagsData {
	try {
		return JSON.parse(readFileSync(USER_TAGS_FILE, "utf8")) as UserTagsData;
	} catch {
		return {};
	}
}

export function currentTrackTags(): string[] {
	if (!state.url) return [];
	const cat = loadCatalogData();
	const track = cat?.tracks.find(t => t.url === state.url);
	return track?.categories || track?.tags || [];
}

export async function musicToggleTag(tag: string) {
	if (busy) throw new Error("曲を切り替え中です。もう一度押してください");
	busy = true;
	try {
		await call("/status");
		if (!state.url || !state.track || state.loading) throw new Error("タグ付けする曲がありません");
		const url = state.url;
		const catalog = loadCatalogData();
		if (!catalog) throw new Error("音楽カタログを読み込めません");
		const track = catalog.tracks.find(t => t.url === url);
		if (!track) throw new Error("カタログ内に曲が見つかりません");

		const userTags = loadUserTagsData();
		const currentTags = new Set(track.categories || []);
		const hasTag = currentTags.has(tag);

		if (hasTag) {
			currentTags.delete(tag);
			if (track.tags) track.tags = track.tags.filter(t => t !== tag);
			if (userTags[url]) {
				userTags[url] = userTags[url].filter(t => t !== tag);
				if (userTags[url].length === 0) delete userTags[url];
			}
		} else {
			currentTags.add(tag);
			if (!track.tags) track.tags = [];
			if (!track.tags.includes(tag)) track.tags.push(tag);
			if (!userTags[url]) userTags[url] = [];
			if (!userTags[url].includes(tag)) userTags[url].push(tag);
		}

		if (tag === "guitar" || tag === "strings") {
			if (currentTags.has("guitar") || currentTags.has("strings")) {
				currentTags.add("guitar-strings");
			} else {
				currentTags.delete("guitar-strings");
			}
		}

		track.categories = Array.from(currentTags);
		writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 2) + "\n", "utf8");
		writeFileSync(USER_TAGS_FILE, JSON.stringify(userTags, null, 2) + "\n", "utf8");

		if (started) {
			await call("/reload");
		}
	} finally {
		busy = false;
	}
}

export async function musicClearTags() {
	if (busy) throw new Error("曲を切り替え中です。もう一度押してください");
	busy = true;
	try {
		await call("/status");
		if (!state.url || !state.track || state.loading) throw new Error("タグ付けする曲がありません");
		const url = state.url;
		const catalog = loadCatalogData();
		if (!catalog) throw new Error("音楽カタログを読み込めません");
		const track = catalog.tracks.find(t => t.url === url);
		if (!track) throw new Error("カタログ内に曲が見つかりません");

		const userTags = loadUserTagsData();
		const removable = ["piano", "guitar", "strings", "guitar-strings", "oriental", "chill"];
		track.categories = (track.categories || []).filter(c => !removable.includes(c));
		if (track.tags) track.tags = track.tags.filter(t => !removable.includes(t));
		if (userTags[url]) {
			userTags[url] = userTags[url].filter(t => !removable.includes(t));
			if (userTags[url].length === 0) delete userTags[url];
		}

		writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 2) + "\n", "utf8");
		writeFileSync(USER_TAGS_FILE, JSON.stringify(userTags, null, 2) + "\n", "utf8");

		if (started) {
			await call("/reload");
		}
	} finally {
		busy = false;
	}
}

export async function musicSync() {
	load();
	if (busy) return;
	busy = true;
	const prevLoading = state.loading;
	state.loading = true;
	try {
		const syncScript = `${process.env.HERDR_ROOT || `${process.env.HOME}/atelier/forge/herdr`}/sync_music.py`;
		await new Promise<void>((resolve, reject) => {
			execFile("/usr/bin/python3", [syncScript], (err) => err ? reject(err) : resolve());
		});
		if (started) {
			await call("/reload");
		}
	} catch (e) {
		state.error = `同期エラー: ${e}`;
	} finally {
		state.loading = prevLoading;
		busy = false;
	}
}

export async function musicTick(quiet = false) {
	load();
	quietNow = quiet;
	const now = Date.now();
	const allowed = !quiet && !isSleeping() && !isMuted();
	if (!allowed || !cfg.enabled || !manual) wanted = false;
	if (busy) return;
	busy = true;
	try {
		if (!started && !checkedExisting) {
			checkedExisting = true;
			try {
				const response = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(1000) });
				state = { ...state, ...await response.json() as State };
				started = true;
				// 自動再生を有効にした環境では、プラグイン更新で流れている曲を止めない。
				if (cfg.autoStart?.enabled && (state.playing || state.loading)) {
					cfg.enabled = true; manual = true; wanted = true;
					cfg.category = state.category || "all";
					cfg.ratingFilter = state.ratingFilter || "all";
				}
			} catch { /* 未起動なら、手動操作または予約時刻まで起動しない */ }
		}
		const slot = scheduledSlot(now);
		if (slot !== undefined && cfg.lastAutoStartSlot !== slot) {
			// 消音・睡眠・録音中の回はスキップし、復帰後にまとめて鳴らさない。
			cfg.lastAutoStartSlot = slot;
			writeFileSync(FILE, JSON.stringify(cfg, null, 2));
			if (allowed) {
				await call("/status").catch(() => {});
				if (quietNow || isSleeping() || isMuted()) return;
				if (state.playing || state.loading) {
					cfg.category = state.category || "all";
					cfg.ratingFilter = state.ratingFilter || "all";
					wanted = true;
				} else {
					cfg.category = "all"; cfg.ratingFilter = "all"; wanted = false;
				}
				cfg.enabled = true; manual = true; retryAt = 0;
				writeFileSync(FILE, JSON.stringify(cfg, null, 2));
			}
		}
		const shouldPlay = cfg.enabled && manual && allowed && !quietNow && !isSleeping() && !isMuted();
		if (now < retryAt && shouldPlay) return;
		if (shouldPlay && !wanted) {
			wanted = shouldPlay;
			const cat = cfg.category || "all";
			await call(`/play?category=${encodeURIComponent(cat)}&rating=${encodeURIComponent(cfg.ratingFilter || "all")}`);
		} else if (!shouldPlay && started && (state.playing || state.loading)) {
			wanted = false;
			await call("/pause");
		} else if (started) await call("/status");
	} catch (e) { state.error = String(e); wanted = false; retryAt = now + 30_000; }
	finally { busy = false; }
}

export async function musicDuck(durationSec?: number): Promise<void> {
	if (!started) return;
	try {
		const q = durationSec && durationSec > 0 ? `?duration=${durationSec}` : "";
		await call(`/duck${q}`);
	} catch { /* ignore */ }
}

export async function musicUnduck(): Promise<void> {
	if (!started) return;
	try {
		await call("/duck/stop");
	} catch { /* ignore */ }
}

export function duckProcess(child: ChildProcess | undefined): ChildProcess | undefined {
	if (!child) return child;
	void musicDuck();
	let done = false;
	const cleanup = () => {
		if (done) return;
		done = true;
		void musicUnduck();
	};
	child.once("close", cleanup);
	child.once("error", cleanup);
	return child;
}

export async function musicVolumeUp(): Promise<void> {
	if (!started) return;
	try { await call("/volume/up"); } catch { /* ignore */ }
}

export async function musicVolumeDown(): Promise<void> {
	if (!started) return;
	try { await call("/volume/down"); } catch { /* ignore */ }
}

export async function musicSetVolume(level: number): Promise<void> {
	if (!started) return;
	try { await call(`/volume?level=${Math.max(0, Math.min(100, Math.round(level)))}`); } catch { /* ignore */ }
}


