import { execFile, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { isSleeping } from "./power";
import { isMuted } from "./sound";

const FILE = `${process.env.HOME}/.config/herdr-music.json`;
const BASE = "http://127.0.0.1:18869";
type Config = { enabled: boolean; url: string; category?: string };
export type State = {
	playing: boolean;
	loading: boolean;
	track: string;
	artist?: string;
	url?: string;
	category?: string;
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
let retryAt = 0;
let state: State = { playing: false, loading: false, track: "", artist: "", url: "", category: "all", duration: 0, position: 0, remaining: 0, error: "" };

function load() {
	if (loaded) return;
	loaded = true;
	try { cfg = { ...cfg, ...JSON.parse(readFileSync(FILE, "utf8")) }; }
	catch { writeFileSync(FILE, JSON.stringify(cfg, null, 2)); }
}

async function call(route: string) {
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
	try { response = await fetch(`${BASE}${route}`, { signal: AbortSignal.timeout(5000) }); }
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

export async function musicToggle(category = "all") {
	load();
	if (isSleeping()) return;
	if (busy) return;
	busy = true;
	try {
		const isCurrentlyPlayingThis = (state.playing || state.loading) && (state.category === category || (category === "all" && !state.category));
		if (isCurrentlyPlayingThis) {
			// 同じカテゴリで再生中なら一時停止
			cfg.enabled = false;
		} else {
			// 停止中、または別のカテゴリに切り替え
			cfg.enabled = true;
			cfg.category = category;
		}
		manual = cfg.enabled;
		retryAt = 0;
		writeFileSync(FILE, JSON.stringify(cfg, null, 2));
		wanted = cfg.enabled;
		const route = wanted ? `/play?category=${encodeURIComponent(category)}` : "/pause";
		await call(route);
	} catch (e) {
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
	const now = Date.now();
	const shouldPlay = cfg.enabled && manual && !quiet && !isSleeping() && !isMuted();
	if (!shouldPlay) wanted = false;
	if (busy) return;
	if (now < retryAt && shouldPlay) return;
	busy = true;
	try {
		if (!started && !checkedExisting) {
			checkedExisting = true;
			try {
				const response = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(1000) });
				state = { ...state, ...await response.json() as State };
				started = true;
			} catch { /* 未起動なら、ボタンを押すまで起動しない */ }
		}
		if (shouldPlay && !wanted) {
			wanted = shouldPlay;
			const cat = cfg.category || "all";
			await call(`/play?category=${encodeURIComponent(cat)}`);
		} else if (!shouldPlay && started && (state.playing || state.loading)) {
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


