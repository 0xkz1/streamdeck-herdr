import { CONFIG } from "./config";
// エージェントの状態に合わせて Hue の電球の色を変える(環境光の通知)。
//   確認待ち=紫 / 完了=緑 / 作業中=普段の色で呼吸 / GPU 高温=赤 / それ以外=最新のシーンに戻す
// 設定: ~/.config/herdr-hue/ambient.json  {"enabled":true,"lights":["6"],"working":true,"doneSeconds":30,"pulse":true}
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { Snapshot } from "./herdr";
import { isMuted, spawnSound } from "./sound";
import { isSleeping } from "./power";

const CFG = `${process.env.HOME}/.config/herdr-hue`;
const IP = CONFIG.hueIp;

type Cfg = { enabled: boolean; lights: string[]; working: boolean; doneSeconds: number; pulse: boolean; neutral: Record<string, unknown>; heatSound: boolean };
type Mode = "idle" | "blocked" | "done" | "working" | "heat1" | "heat2" | "limit";

const COLOR: Record<Exclude<Mode, "idle">, Record<string, unknown>> = {
	blocked: { on: true, hue: 50000, sat: 254, bri: 254, transitiontime: 3 },
	done: { on: true, hue: 25500, sat: 254, bri: 254, transitiontime: 4 },
	working: { transitiontime: 6 },
	// GPU 高温は赤(危険の色)。確認待ちは紫にして取り違えを防ぐ
	heat1: { on: true, hue: 0, sat: 254, bri: 254, transitiontime: 3 },
	heat2: { on: true, hue: 0, sat: 254, bri: 254, transitiontime: 2 },
	limit: { on: true, hue: 0, sat: 254, bri: 254, transitiontime: 2 }, // 使用上限で止まった(赤)。短時間だけ
};

// hi/lo は各ライトの普段の明るさに掛ける％。tt は 0.1 秒単位。
const PULSE: Partial<Record<Mode, { hi: number; lo: number; ms: number; tt: number }>> = {
	working: { hi: 100, lo: 50, ms: 1500, tt: 12 }, // ゆっくり呼吸するように
	blocked: { hi: 100, lo: 10, ms: 800, tt: 3 }, // 速く点滅して目を引く(紫)
	heat2: { hi: 100, lo: 25, ms: 500, tt: 2 }, // 確認待ちより速く(赤)。heat1 は点滅せず常灯
	limit: { hi: 100, lo: 15, ms: 600, tt: 2 },
};
let pulseTimer: ReturnType<typeof setInterval> | undefined;
let pulseHigh = true;
const stopPulse = () => { if (pulseTimer) clearInterval(pulseTimer); pulseTimer = undefined; };
function startPulse(m: Exclude<Mode, "idle">) {
	stopPulse();
	if (suspended || isSleeping()) return;
	const spec = PULSE[m];
	if (!spec || (!cfg.pulse && m !== "heat2")) return; // 高温の点滅は pulse 設定に関わらず出す
	pulseHigh = true;
	pulseTimer = setInterval(async () => {
		if (suspended || isSleeping() || busy || userScenePending()) return;
		busy = true;
		try {
			pulseHigh = !pulseHigh;
			for (const id of cfg.lights) {
				await refreshScene(id);
				if (userScenePending()) return;
				await applyMode(id, m, pulseHigh ? spec.hi : spec.lo, spec.tt);
			}
		} catch (e) { amb(`pulse failed: ${e}`); }
		finally { busy = false; }
	}, spec.ms);
}

const amb = (msg: string) => { try { appendFileSync(`${process.env.HOME}/Library/Caches/herdr-ambient.log`, `${new Date().toISOString().slice(11, 19)} ${msg}\n`); } catch { /* ログは無くても動く */ } };

// GPU 高温(0=平常 / 1=75°C以上 / 2=83°C以上)。Telegram アラート(GPUTemperatureWarning/Critical)と閾値を揃える。
// 上がるときは即、下がるときは 3°C 余裕を見る(境界でのちらつき防止)
export const heatLevel = (prev: 0 | 1 | 2, t: number): 0 | 1 | 2 => {
	const up = t >= 83 ? 2 : t >= 75 ? 1 : 0;
	if (up >= prev) return up;
	return prev === 2 && t >= 80 ? 2 : t >= 72 ? 1 : 0;
};
let heat: 0 | 1 | 2 = 0;
let lastAlarm = 0;
const alarm = (level: 1 | 2) => spawnSound("/opt/homebrew/bin/play", ["-q", "-v", "0.6", `${process.env.HOME}/streamdeck-herdr/sounds/heat${level}.wav`]);
// 温度を渡す(取得失敗 = undefined のときは直前の状態を保つ)。音は上昇時に1回、83°C以上の間は30秒ごと
export function setGpuTemp(t?: number) {
	if (t === undefined) return;
	loadCfg();
	const prev = heat;
	heat = heatLevel(heat, t);
	if (!cfg.heatSound || heat === 0 || isMuted()) return;
	if (heat > prev || (heat === 2 && Date.now() - lastAlarm > 30_000)) { lastAlarm = Date.now(); alarm(heat); }
}

let cfg: Cfg = { enabled: true, lights: ["6"], working: true, doneSeconds: 15, pulse: true, neutral: { on: true, bri: 130, ct: 340 }, heatSound: true };
let cfgAt = 0;
let mode: Mode = "idle";
let doneSince = 0;
let ackedDone = ""; // すでに緑で知らせた「完了」の組(同じものを繰り返し光らせない)
const SAVED_FILE = `${CFG}/ambient-saved.json`; // 元の状態をディスクにも残す(プラグインが途中で止まっても戻せる)
const saved = new Map<string, any>(); // 点ける前の状態
const applied = new Map<string, any>(); // 最後に私たちが設定した状態(ユーザーが変えたか判定する用)
const pending = new Map<string, any>(); // 応答未確認の自分の操作。新しいシーンとして取り込まない
const settledAt = new Map<string, number>();
let busy = false;
let suspended = false;
const USER_CHANGE_FILE = `${CFG}/ambient-user-change`;
let userChangeAt = 0;
let scenePending = false;

// シーンのフェード中に呼吸で上書きしない。hue.py(ホットキー)も同じファイルを使う。
export async function ambientUserChange(action: () => Promise<unknown>) {
	writeFileSync(USER_CHANGE_FILE, String(Date.now() + 10_000));
	stopPulse();
	while (busy) await new Promise((r) => setTimeout(r, 25));
	busy = true;
	try {
		if (mode !== "idle") {
			for (const id of cfg.lights) await refreshScene(id);
			await restore();
			mode = "idle";
		}
		return await action();
	} finally {
		busy = false;
		writeFileSync(USER_CHANGE_FILE, String(Date.now() + 1500));
	}
}

function userScenePending() {
	try {
		const at = Number(readFileSync(USER_CHANGE_FILE, "utf8"));
		if (at !== userChangeAt) {
			userChangeAt = at;
			if (at > Date.now() - 10_000) scenePending = true;
		}
	} catch { /* 他の操作なし */ }
	if (scenePending) stopPulse();
	return scenePending;
}

const curl = (args: string[]) => new Promise<string>((res, rej) => execFile("/usr/bin/curl", ["-sk", "-m", "6", ...args], (e, o) => (e ? rej(new Error(`Hue transport failed (${e.code ?? "unknown"})`)) : res(o))));
const base = () => `https://${IP}/api/${JSON.parse(readFileSync(`${CFG}/bridge.json`, "utf8"))[0].success.username}`;
const persist = () => { try { if (saved.size) writeFileSync(SAVED_FILE, JSON.stringify({ saved: Object.fromEntries(saved), applied: Object.fromEntries(applied), pending: Object.fromEntries(pending) })); else if (existsSync(SAVED_FILE)) unlinkSync(SAVED_FILE); } catch { /* 無くても動く */ } };
// 私たちの色(黄・緑・赤)に見えるか。元の色として覚えてはいけない
const looksLikeOverlay = (st: any) => st?.on && st.colormode === "hs" && st.sat >= 240 && [0, 9000, 12750, 25500, 50000].some((h) => Math.abs((st.hue ?? -9999) - h) < 600);
const light = async (id: string) => JSON.parse(await curl([`${base()}/lights/${id}`])).state;
const setLight = async (id: string, body: object) => {
	const result = JSON.parse(await curl(["-X", "PUT", `${base()}/lights/${id}/state`, "-d", JSON.stringify(body)]));
	if (!Array.isArray(result) || !result.length || result.some((r: any) => !r.success)) {
		throw new Error(`Hue ${id}: ${result?.find?.((r: any) => r.error)?.error?.description ?? "unconfirmed response"}`);
	}
};

const sceneState = (st: any) => !st.on ? { on: false } : {
	on: true, bri: st.bri,
	...(st.colormode === "ct" ? { ct: st.ct } : st.colormode === "xy" ? { xy: st.xy } : { hue: st.hue, sat: st.sat }),
};
function matches(cur: any, a: any, brightnessTolerance = 2) {
	if (cur.on !== a.on) return false;
	if (!cur.on) return true;
	if (a.bri !== undefined && Math.abs(cur.bri - a.bri) > brightnessTolerance) return false;
	if (a.ct !== undefined) return cur.colormode === "ct" && Math.abs(cur.ct - a.ct) <= 2;
	if (a.xy !== undefined) return cur.colormode === "xy" && a.xy.every((v: number, i: number) => Math.abs(cur.xy?.[i] - v) < 0.005);
	return cur.colormode === "hs" && Math.min(Math.abs(cur.hue - a.hue), 65536 - Math.abs(cur.hue - a.hue)) <= 800 && Math.abs(cur.sat - a.sat) <= 40;
}

// 実機は66を送った後に71等を報告する。この差を基準の変更にすると減光が累積する。
// 自分の操作との比較だけ、普段の明るさの10%+2までの報告差を許容する。
const matchesApplied = (id: string, cur: any, a: any) => matches(cur, a, Math.ceil((saved.get(id)?.bri ?? a.bri ?? 0) * 0.1) + 2);

// 最後の送信値と違う応答は、呼吸を止めたまま再確認する。
// 遅れて届いた自分の状態をユーザー操作として記録しない。
async function confirmChange(id: string, cur: any, a: any) {
	if (!a || matchesApplied(id, cur, a)) return cur;
	// 古い状態が複数回返る場合も、次の呼吸を送らずに落ち着くまで待つ。
	for (let attempt = 0; attempt < 6; attempt++) {
		await new Promise((r) => setTimeout(r, 500));
		cur = await light(id);
		if (matchesApplied(id, cur, a)) break;
	}
	return cur;
}

async function refreshScene(id: string) {
	if (pending.has(id)) {
		if (suspended || isSleeping() || userScenePending()) return false;
		await applyState(id, pending.get(id));
		return false;
	}
	const readAt = Date.now();
	let cur = await light(id);
	const a = applied.get(id);
	if (a && readAt >= (settledAt.get(id) ?? 0)) cur = await confirmChange(id, cur, a);
	if (!saved.has(id) || (a && readAt >= (settledAt.get(id) ?? 0) && !matchesApplied(id, cur, a))) {
		amb(`scene ${id}: bri ${saved.get(id)?.bri} -> ${cur.bri}, expected=${a?.bri} color=${cur.colormode}`);
		saved.set(id, cur);
		applied.delete(id);
		persist();
		return true;
	}
	return !a;
}

async function applyMode(id: string, m: Exclude<Mode, "idle">, percent = 100, tt?: number) {
	if (suspended || isSleeping()) return;
	const before = saved.get(id);
	const body: Record<string, any> = before.on ? {
		...(m === "working" ? sceneState(before) : COLOR[m]),
		bri: Math.max(1, Math.min(254, Math.round(before.bri * percent / 100))),
		transitiontime: tt ?? COLOR[m].transitiontime,
	} : { on: false };
	await applyState(id, body);
}

async function applyState(id: string, body: Record<string, any>) {
	pending.set(id, body);
	persist();
	await setLight(id, body);
	applied.set(id, body);
	settledAt.set(id, Date.now() + Number(body.transitiontime ?? 0) * 100 + 100);
	pending.delete(id);
	persist();
}

export function loadCfg(force = false) {
	if (!force && Date.now() - cfgAt < 30_000) return;
	cfgAt = Date.now();
	try {
		cfg = { ...cfg, ...JSON.parse(readFileSync(`${CFG}/ambient.json`, "utf8")) };
	} catch {
		if (!existsSync(`${CFG}/ambient.json`)) writeFileSync(`${CFG}/ambient.json`, JSON.stringify(cfg, null, 2));
	}
}

let limitUntil = 0;
export const ambientLimitAlert = (seconds = 60) => { limitUntil = Date.now() + seconds * 1000; };
export const ambientEnabled = () => cfg.enabled;
export const ambientMode = () => mode;

export async function ambientToggle() {
	loadCfg(true);
	cfg.enabled = !cfg.enabled;
	writeFileSync(`${CFG}/ambient.json`, JSON.stringify(cfg, null, 2));
	if (!cfg.enabled) {
		stopPulse();
		while (busy) await new Promise((r) => setTimeout(r, 25));
		busy = true;
		try { await restore(); mode = "idle"; }
		finally { busy = false; }
	} // mode を戻さないと、再度有効にしたとき同じ色を付け直さない
}

// 戻す。ただし、私たちが付けた色から変わっていたら(=ユーザーが操作した)触らない
async function restore() {
	stopPulse();
	for (const id of cfg.lights) {
		const before = saved.get(id);
		if (!before) continue;
		try {
			const remaining = (settledAt.get(id) ?? 0) - Date.now();
			if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
			const previous = applied.get(id);
			const a = pending.get(id) ?? previous;
			const cur = await confirmChange(id, await light(id), a);
			amb(`restore ${id}: cur hue=${cur.hue} sat=${cur.sat} on=${cur.on} / applied hue=${a?.hue} sat=${a?.sat} / before=${JSON.stringify(before)}`);
			const touched = a && !matchesApplied(id, cur, a) && !(pending.has(id) && (matches(cur, sceneState(before)) || (previous && matchesApplied(id, cur, previous))));
			amb(`restore ${id}: touched=${touched}`);
			if (!touched) {
				await applyState(id, { ...sceneState(before), transitiontime: 0 });
			}
		} catch (e) { amb(`restore ${id} failed: ${e}`); continue; }
		saved.delete(id);
		applied.delete(id);
		pending.delete(id);
		settledAt.delete(id);
	}
	persist();
}

let recovered = false;
// プラグインが色を付けたまま止まった場合、起動直後に元の色へ戻す(ファイルに残した元の状態を使う)
async function recoverStale() {
	recovered = true;
	try {
		const data = JSON.parse(readFileSync(SAVED_FILE, "utf8")) as Record<string, any>;
		const raw = data.saved ?? data; // 以前の保存形式も回復する
		for (const [id, before] of Object.entries(raw)) saved.set(id, before);
		for (const [id, body] of Object.entries(data.pending ?? {})) pending.set(id, body);
		for (const id of Object.keys(raw)) {
			// 私たちの色(黄・紫など)のまま残っているなら戻す、ユーザーが別の色にしたなら触らない
			const cur = await light(id).catch(() => undefined);
			applied.set(id, data.applied?.[id] ?? (looksLikeOverlay(cur) ? sceneState(cur) : { on: true, hue: 9000, sat: 254 }));
		}
		amb(`起動時の回復: ${Object.keys(raw).join(",")}`);
		mode = "working"; // restore を通すための仮の状態
		await restore();
		mode = "idle";
	} catch { /* 残骸なし */ }
}

export async function ambientTick(snap: Snapshot) {
	if (suspended || isSleeping() || busy) return;
	busy = true;
	try { await tick(snap); }
	catch (e) { amb(`tick failed: ${e}`); }
	finally { busy = false; }
}

export async function ambientSuspend(sleeping: boolean) {
	suspended = sleeping;
	if (!sleeping) return;
	stopPulse();
	while (busy) await new Promise((r) => setTimeout(r, 25));
	busy = true;
	try {
		loadCfg();
		if (!recovered) await recoverStale();
		await restore();
		mode = "idle";
	} finally { busy = false; }
}

async function tick(snap: Snapshot) {
	loadCfg();
	if (!recovered) await recoverStale();
	const changedScene = userScenePending();
	if (changedScene) {
		if (Date.now() < userChangeAt) return;
		for (const id of cfg.lights) {
			if (mode !== "idle") saved.set(id, await light(id));
			applied.delete(id);
			pending.delete(id);
		}
		scenePending = false;
		persist();
	}
	if (!cfg.enabled && heat === 0 && mode !== "heat1" && mode !== "heat2") return; // 無効でも高温だけは光らせる(安全)
	const agents = snap.tabs.filter((t) => t.agent);
	let next: Mode = "idle";
	const doneIds = agents.filter((t) => t.status === "done").map((t) => t.id).sort().join(",");
	if (!doneIds) ackedDone = ""; // 完了が一度全部消えたら、次の完了はまた知らせる
	const freshDone = doneIds !== "" && doneIds !== ackedDone;
	if (heat > 0) next = heat === 2 ? "heat2" : "heat1"; // 高温は確認待ちより優先
	else if (!cfg.enabled) next = "idle";
	else if (Date.now() < limitUntil) next = "limit"; // 使用上限の知らせ。決めた秒数がたてば自然に次の状態へ移る
	else if (agents.some((t) => t.status === "blocked")) next = "blocked";
	else if (freshDone) next = "done";
	else if (cfg.working && agents.some((t) => t.status === "working")) next = "working";
	if (next === "done") {
		if (mode !== "done") doneSince = Date.now();
		if (Date.now() - doneSince > cfg.doneSeconds * 1000) { ackedDone = doneIds; next = cfg.working && agents.some((t) => t.status === "working") ? "working" : "idle"; }
	}
	if (next === mode && !changedScene) {
		if (mode === "idle" && saved.size) await restore();
		if (mode !== "idle") for (const id of cfg.lights) {
			if (await refreshScene(id)) await applyMode(id, mode, pulseHigh ? 100 : PULSE[mode]?.lo ?? 100);
		}
		if (mode !== "idle" && !pulseTimer) startPulse(mode);
		return;
	}
	if (mode === "idle" && saved.size) {
		await restore();
		if (saved.size) return;
	}
	amb(`mode ${mode} -> ${next}  done=[${doneIds}] acked=[${ackedDone}] agents=${agents.map((t) => t.id + ":" + t.status).join(" ")}`);
	stopPulse();
	if (!changedScene && mode !== "idle") for (const id of cfg.lights) await refreshScene(id);
	mode = next;
	try {
		if (next === "idle") return await restore();
		for (const id of cfg.lights) {
			if (!saved.has(id)) await refreshScene(id);
			if (userScenePending()) return;
			await applyMode(id, next);
		}
		startPulse(next);
	} catch { /* ブリッジに繋がらない等。次の変化で再試行 */ }
}
