import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { isSleeping } from "./power";
import { isMuted } from "./sound";

const FILE = `${process.env.HOME}/.config/herdr-music.json`;
const BASE = "http://127.0.0.1:18869";
type Config = { enabled: boolean; url: string };
type State = { playing: boolean; loading: boolean; track: string; error: string };
let cfg: Config = { enabled: true, url: "https://soundcloud.com/your-account/likes" };
let loaded = false, started = false, busy = false;
let checkedExisting = false;
let wanted = false;
let manual = false;
let retryAt = 0;
let state: State = { playing: false, loading: false, track: "", error: "" };

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
	if (route === "/play" && (!wanted || isSleeping() || isMuted())) route = "/pause";
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

export async function musicToggle() {
	load();
	if (isSleeping()) return;
	if (busy) return;
	busy = true;
	try {
		cfg.enabled = !(state.playing || state.loading);
		manual = cfg.enabled;
		retryAt = 0;
		writeFileSync(FILE, JSON.stringify(cfg, null, 2));
		wanted = cfg.enabled;
		await call(wanted ? "/play" : "/pause");
	} catch (e) {
		if (started) await fetch(`${BASE}/open`, { signal: AbortSignal.timeout(3000) }).catch(() => {});
		throw e;
	} finally { busy = false; }
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
			await call("/play");
		} else if (!shouldPlay && started && (state.playing || state.loading)) {
			await call("/pause");
		} else if (started) await call("/status");
	} catch (e) { state.error = String(e); wanted = false; retryAt = now + 30_000; }
	finally { busy = false; }
}
