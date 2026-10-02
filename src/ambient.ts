// エージェントの状態に合わせて Hue の電球の色を変える(環境光の通知)。
//   確認待ち=赤 / 完了=緑(数十秒で消える) / 作業中=暗めの黄 / それ以外=元の色に戻す
// 設定: ~/.config/herdr-hue/ambient.json  {"enabled":true,"lights":["6"],"working":true,"doneSeconds":30,"pulse":true}
import { CONFIG } from "./config";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { Snapshot } from "./herdr";

const CFG = `${process.env.HOME}/.config/herdr-hue`;
const IP = CONFIG.hueIp;

type Cfg = { enabled: boolean; lights: string[]; working: boolean; doneSeconds: number; pulse: boolean; neutral: Record<string, unknown> };
type Mode = "idle" | "blocked" | "done" | "working";

const COLOR: Record<Exclude<Mode, "idle">, Record<string, unknown>> = {
	blocked: { on: true, hue: 0, sat: 254, bri: 254, transitiontime: 3 },
	done: { on: true, hue: 25500, sat: 254, bri: 254, transitiontime: 4 },
	working: { on: true, hue: 9000, sat: 254, bri: 254, transitiontime: 6 }, // 9000 = 金色がかった黄(12750 は黄緑に見える)
};

// 点滅(明るさだけを上下させる)。hi/lo = 明るさ、ms = 周期、tt = 変化にかける時間(1=0.1秒)
const PULSE: Partial<Record<Mode, { hi: number; lo: number; ms: number; tt: number }>> = {
	working: { hi: 254, lo: 130, ms: 1500, tt: 12 }, // ゆっくり呼吸するように
	blocked: { hi: 254, lo: 25, ms: 800, tt: 3 }, // 速く点滅して目を引く
};
let pulseTimer: ReturnType<typeof setInterval> | undefined;
let pulseHigh = true;
const stopPulse = () => { if (pulseTimer) clearInterval(pulseTimer); pulseTimer = undefined; };
function startPulse(m: Mode) {
	stopPulse();
	const spec = PULSE[m];
	if (!spec || !cfg.pulse) return;
	pulseHigh = true;
	pulseTimer = setInterval(() => {
		pulseHigh = !pulseHigh;
		for (const id of cfg.lights) setLight(id, { bri: pulseHigh ? spec.hi : spec.lo, transitiontime: spec.tt }).catch(() => {});
	}, spec.ms);
}

const amb = (msg: string) => { try { appendFileSync(`${process.env.HOME}/Library/Caches/herdr-ambient.log`, `${new Date().toISOString().slice(11, 19)} ${msg}\n`); } catch { /* ログは無くても動く */ } };

let cfg: Cfg = { enabled: true, lights: ["6"], working: true, doneSeconds: 15, pulse: true, neutral: { on: true, bri: 130, ct: 340 } };
let cfgAt = 0;
let mode: Mode = "idle";
let doneSince = 0;
let ackedDone = ""; // すでに緑で知らせた「完了」の組(同じものを繰り返し光らせない)
const SAVED_FILE = `${CFG}/ambient-saved.json`; // 元の状態をディスクにも残す(プラグインが途中で止まっても戻せる)
const saved = new Map<string, any>(); // 点ける前の状態
const applied = new Map<string, any>(); // 最後に私たちが設定した状態(ユーザーが変えたか判定する用)

const curl = (args: string[]) => new Promise<string>((res, rej) => execFile("/usr/bin/curl", ["-sk", "-m", "6", ...args], (e, o) => (e ? rej(e) : res(o))));
const base = () => `https://${IP}/api/${JSON.parse(readFileSync(`${CFG}/bridge.json`, "utf8"))[0].success.username}`;
const persist = () => { try { if (saved.size) writeFileSync(SAVED_FILE, JSON.stringify(Object.fromEntries(saved))); else if (existsSync(SAVED_FILE)) unlinkSync(SAVED_FILE); } catch { /* 無くても動く */ } };
// 私たちの色(黄・緑・赤)に見えるか。元の色として覚えてはいけない
const looksLikeOverlay = (st: any) => st?.on && st.colormode === "hs" && st.sat >= 240 && [0, 9000, 12750, 25500].some((h) => Math.abs((st.hue ?? -9999) - h) < 600);
const light = async (id: string) => JSON.parse(await curl([`${base()}/lights/${id}`])).state;
const setLight = (id: string, body: object) => curl(["-X", "PUT", `${base()}/lights/${id}/state`, "-d", JSON.stringify(body)]);

export function loadCfg(force = false) {
	if (!force && Date.now() - cfgAt < 30_000) return;
	cfgAt = Date.now();
	try {
		cfg = { ...cfg, ...JSON.parse(readFileSync(`${CFG}/ambient.json`, "utf8")) };
	} catch {
		if (!existsSync(`${CFG}/ambient.json`)) writeFileSync(`${CFG}/ambient.json`, JSON.stringify(cfg, null, 2));
	}
}

export const ambientEnabled = () => cfg.enabled;
export const ambientMode = () => mode;

export async function ambientToggle() {
	loadCfg(true);
	cfg.enabled = !cfg.enabled;
	writeFileSync(`${CFG}/ambient.json`, JSON.stringify(cfg, null, 2));
	if (!cfg.enabled) await restore();
}

// 戻す。ただし、私たちが付けた色から変わっていたら(=ユーザーが操作した)触らない
async function restore() {
	stopPulse();
	for (const id of cfg.lights) {
		const before = saved.get(id);
		if (!before) continue;
		try {
			const cur = await light(id);
			const a = applied.get(id);
			amb(`restore ${id}: cur hue=${cur.hue} sat=${cur.sat} on=${cur.on} / applied hue=${a?.hue} sat=${a?.sat} / before=${JSON.stringify(before)}`);
			const touched = a && cur.on && (Math.abs((cur.hue ?? 0) - (a.hue ?? 0)) > 800 || Math.abs((cur.sat ?? 0) - (a.sat ?? 0)) > 40);
			amb(`restore ${id}: touched=${touched}`);
			if (!touched) {
				if (!before.on) await setLight(id, { on: false, transitiontime: 10 });
				else if (before.colormode === "ct") await setLight(id, { on: true, bri: before.bri, ct: before.ct, transitiontime: 10 });
				else if (before.colormode === "xy") await setLight(id, { on: true, bri: before.bri, xy: before.xy, transitiontime: 10 });
				else await setLight(id, { on: true, bri: before.bri, hue: before.hue, sat: before.sat, transitiontime: 10 });
			}
		} catch (e) { amb(`restore ${id} failed: ${e}`); }
		saved.delete(id);
		applied.delete(id);
	}
	persist();
}

let recovered = false;
// プラグインが色を付けたまま止まった場合、起動直後に元の色へ戻す(ファイルに残した元の状態を使う)
async function recoverStale() {
	recovered = true;
	try {
		const raw = JSON.parse(readFileSync(SAVED_FILE, "utf8")) as Record<string, any>;
		for (const [id, before] of Object.entries(raw)) saved.set(id, before);
		for (const id of Object.keys(raw)) applied.set(id, { hue: 9000, sat: 254 }); // 黄色のまま残っているなら戻す、別の色なら触らない
		amb(`起動時の回復: ${Object.keys(raw).join(",")}`);
		mode = "working"; // restore を通すための仮の状態
		await restore();
		mode = "idle";
	} catch { /* 残骸なし */ }
}

export async function ambientTick(snap: Snapshot) {
	loadCfg();
	if (!recovered) await recoverStale();
	if (!cfg.enabled) return;
	const agents = snap.tabs.filter((t) => t.agent);
	let next: Mode = "idle";
	const doneIds = agents.filter((t) => t.status === "done").map((t) => t.id).sort().join(",");
	if (!doneIds) ackedDone = ""; // 完了が一度全部消えたら、次の完了はまた知らせる
	const freshDone = doneIds !== "" && doneIds !== ackedDone;
	if (agents.some((t) => t.status === "blocked")) next = "blocked";
	else if (freshDone) next = "done";
	else if (cfg.working && agents.some((t) => t.status === "working")) next = "working";
	if (next === "done") {
		if (mode !== "done") doneSince = Date.now();
		if (Date.now() - doneSince > cfg.doneSeconds * 1000) { ackedDone = doneIds; next = cfg.working && agents.some((t) => t.status === "working") ? "working" : "idle"; }
	}
	if (next === mode) return;
	amb(`mode ${mode} -> ${next}  done=[${doneIds}] acked=[${ackedDone}] agents=${agents.map((t) => t.id + ":" + t.status).join(" ")}`);
	const prev = mode;
	mode = next;
	try {
		if (next === "idle") return await restore();
		for (const id of cfg.lights) {
			if (prev === "idle" && !saved.has(id)) {
				const cur = await light(id);
				// すでに私たちの色なら(前回の停止で残った色)、それは元の色ではない → 標準の色に戻す
				saved.set(id, looksLikeOverlay(cur) ? { ...cfg.neutral, colormode: "ct", ct: cfg.neutral.ct, bri: cfg.neutral.bri, on: true } : cur);
				if (looksLikeOverlay(cur)) amb(`light ${id} は私たちの色が残っていたので、標準の色を元として扱う`);
				persist();
			}
			applied.set(id, COLOR[next]);
			await setLight(id, COLOR[next]);
		}
		startPulse(next);
	} catch { /* ブリッジに繋がらない等。次の変化で再試行 */ }
}
