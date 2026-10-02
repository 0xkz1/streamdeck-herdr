import { CONFIG } from "./config";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { CLOCK_JP, clockName, nextClock, thinkOn, tickOn, toggleThink, toggleTick } from "./sound";
import { ambientEnabled, ambientMode, ambientToggle, loadCfg } from "./ambient";
import { ssh, startHandoff, cronRun, type Usage, focusedAgent, keysAgent, paneCmd, promptAgent, typeAgent, repairInfra, uploadShot, type CronInfo, type Infra, type Snapshot } from "./herdr";

export type Ctx = { snap: Snapshot; cron: Record<string, CronInfo>; infra?: Infra; usage?: Usage; scribe?: "running" | "idle" | "off" };
export type View = { color: string; emoji: string; word: string; label: string };
// run: 押したとき1回 / hold: 押している間(押す=down、離す=up)
export type Cmd = {
	pair?: [string, string]; // 引き継ぎの組(長押しで実行 / 短押しで向きを反転)
	view: (c: Ctx, busy: boolean) => View;
	run?: (c: Ctx) => Promise<void>;
	hold?: { down: (c: Ctx) => Promise<void>; up: (c: Ctx) => Promise<void> };
};

const BASE = "#3a3358";
const BUSY = "#8a6d1f";
const OK = "#2f9e6f";
const NG = "#e5484d";

function agoJa(iso?: string): string {
	if (!iso) return "未実行";
	const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
	if (m < 1) return "たった今";
	if (m < 60) return `${m}分前`;
	if (m < 60 * 24) return `${Math.floor(m / 60)}時間前`;
	return `${Math.floor(m / 1440)}日前`;
}

const run = (file: string, args: string[]) =>
	new Promise<string>((resolve, reject) => execFile(file, args, (e, out) => (e ? reject(e) : resolve(out))));

// 選択中のエージェントへ定型文を送る。取り返しのつく操作だけ(push・削除は入れない)
const quick = (emoji: string, label: string, text: string): Cmd => ({
	view: (_c, busy) => ({ color: busy ? BUSY : BASE, emoji, word: busy ? "送信中" : "送る", label }),
	run: async (c) => void (await promptAgent(focusedAgent(c.snap), text)),
});

const cron = (id: string, label: string): Cmd => ({
	view: (c, busy) => {
		const i = c.cron[id];
		if (busy) return { color: BUSY, emoji: "🔄", word: "実行中", label };
		if (!i?.status) return { color: BASE, emoji: "▶️", word: "未実行", label };
		return { color: i.status === "ok" ? OK : NG, emoji: i.status === "ok" ? "▶️" : "❌", word: agoJa(i.at), label };
	},
	run: async () => void (await cronRun(id)),
});

// ---- 音声入力: 押している間だけ録音 → 文字起こし → 入力欄に打つ(Enter は押さない) ----
// 通常は Ubuntu の Whisper(GPU の large-v3)。繋がらなければ Mac 内の whisper.cpp に自動で切り替える。
const WAV = `${process.env.HOME}/Library/Caches/herdr-voice-in.wav`;
const MIC = "http://127.0.0.1:18867";
const MIC_APP = `${process.env.HOME}/Applications/HerdrMic.app`;

// Stream Deck 本体はマイクを使えない(entitlement なし)ので、許可を持つ HerdrMic に録音を頼む
async function mic(path: string): Promise<string> {
	const call = async () => (await fetch(`${MIC}${path}`, { signal: AbortSignal.timeout(3000) })).text();
	try {
		return await call();
	} catch {
		await run("/usr/bin/open", ["-g", MIC_APP]); // 起動していなければ起こして、もう一度
		await new Promise((r) => setTimeout(r, 1500));
		return call();
	}
}
const WHISPER_URL = CONFIG.whisperUrl;
const LOCAL_MODEL = `${process.env.HOME}/.cache/whisper-cpp/ggml-medium.bin`;
let voiceState: "idle" | "rec" | "proc" = "idle";
let voiceOwner = ""; // いま録音/変換しているのはどの機能か(表示をその機能のキーだけ変えるため)
let voiceLocal = false;

async function transcribe(file: string): Promise<string> {
	try {
		voiceLocal = false;
		return (
			await run("/usr/bin/curl", ["-sf", "-m", "20", "-F", `file=@${file}`, "-F", "model=Systran/faster-whisper-large-v3", "-F", "language=ja", "-F", "response_format=text", WHISPER_URL])
		).trim();
	} catch {
		voiceLocal = true; // Ubuntu に繋がらない → Mac 内で
		return (await run("/opt/homebrew/bin/whisper-cli", ["-m", LOCAL_MODEL, "-l", "ja", "-nt", "-np", "-f", file])).trim();
	}
}

const timing = (who: string, msg: string) => {
	try { appendFileSync(`${process.env.HOME}/Library/Caches/herdr-voice-timing.log`, `${new Date().toISOString()} [${who}] ${msg}\n`); } catch { /* ログは無くても動く */ }
};

// 押している間だけ録音 → 文字にして sink に渡す(音声入力と Hue 音声で共通)
function holdToTalk(label: string, color: string, sink: (text: string, c: Ctx) => Promise<void>, needAgent: boolean): Cmd {
	return {
		view: () =>
			voiceOwner === label && voiceState === "rec"
				? { color: NG, emoji: "🔴", word: "録音中", label: "離すと実行" }
				: voiceOwner === label && voiceState === "proc"
					? { color: BUSY, emoji: "🤔", word: voiceLocal ? "Mac内で変換" : "変換中", label }
					: { color, emoji: label.startsWith("Hue") ? "💡" : "🎤", word: "押して話す", label },
		hold: {
			down: async (c) => {
				if (voiceState !== "idle") return;
				if (needAgent) focusedAgent(c.snap); // 送り先がなければここで注意マーク
				const r = await mic("/start");
				if (r !== "recording") throw new Error(`録音を開始できない: ${r}`);
				voiceState = "rec";
				voiceOwner = label;
			},
			up: async (c) => {
				if (voiceState !== "rec" || voiceOwner !== label) return;
				const t0 = Date.now();
				await mic("/stop");
				await new Promise((r) => setTimeout(r, 120)); // WAV の書き込み完了待ち
				voiceState = "proc";
				try {
					if (!existsSync(WAV)) throw new Error("録音ファイルがない(マイクの許可を確認)");
					// ほぼ無音のまま Whisper に渡すと「ご視聴ありがとうございました」等の幻覚が返る。先に弾く
					const stat = await new Promise<string>((r) => execFile("/opt/homebrew/bin/sox", [WAV, "-n", "stat"], (_e, _o, err) => r(err)));
					const peak = Number(/Maximum amplitude:\s+([0-9.]+)/.exec(stat)?.[1] ?? 0);
					if (peak < 0.01) throw new Error(`音が入っていない(最大振幅 ${peak}): マイクの許可を確認`);
					const t1 = Date.now();
					const text = await transcribe(WAV);
					if (!text) throw new Error("聞き取れなかった");
					const t2 = Date.now();
					await sink(text, c);
					timing(label, `録音停止→文字 ${t2 - t1}ms / 実行 ${Date.now() - t2}ms / 合計 ${Date.now() - t0}ms (${voiceLocal ? "Mac内" : "Ubuntu"}) 「${text}」`);
				} finally {
					voiceState = "idle";
					voiceOwner = "";
				}
			},
		},
	};
}

const voice = holdToTalk("音声入力", "#2d6a8f", async (text, c) => void (await typeAgent(focusedAgent(c.snap), text)), true);

// ---- Hue: 声で操作(対象は「コンピュータールーム」) ----
const HUE_FILE = `${process.env.HOME}/.config/herdr-hue/bridge.json`;
const HUE_IP = CONFIG.hueIp;
const HUE_GROUP = "81"; // コンピュータールーム
const curl = (args: string[]) => run("/usr/bin/curl", ["-sk", "-m", "8", ...args]);

// 短くて決まった言い方は、LLM を通さずその場で判断する(待ちゼロ)。複雑なものだけ LLM へ
type Preset = { label: string; emoji?: string; keywords?: string[]; scene?: string; action?: Record<string, unknown> };
const loadPresets = (): Record<string, Preset> => {
	try { return JSON.parse(readFileSync(`${process.env.HOME}/.config/herdr-hue/presets.json`, "utf8")); } catch { return {}; }
};

function hueQuick(text: string): { scene: string } | Record<string, unknown> | undefined {
	const t = text.replace(/[\s、。，．,.!！?？]/g, "");
	if (t.length > 14) return undefined;
	// 事前登録の言葉(presets.json の keywords)が入っていれば、LLM を通さず即実行
	for (const p of Object.values(loadPresets())) {
		if (p.keywords?.some((k) => t.includes(k))) return p.scene ? { scene: p.scene } : p.action;
	}
	if (/(消して|けして|消す|オフ|消灯)/.test(t)) return { on: false };
	if (/(つけて|点けて|つける|点灯|オン)/.test(t)) return { on: true };
	if (/(最大|全開|マックス)/.test(t)) return { on: true, bri: 254 };
	if (/(最小|いちばん暗|一番暗)/.test(t)) return { on: true, bri: 1 };
	const big = /(かなり|すごく|めっちゃ|もっと|だいぶ|ぐっと)/.test(t);
	if (/暗/.test(t) && !/明/.test(t)) return { bri_inc: big ? -90 : -40 };
	if (/明る/.test(t) && !/暗/.test(t)) return { bri_inc: big ? 90 : 40 };
	return undefined;
}

// 名前でシーンを呼ぶ(一覧は10分キャッシュ)
async function hueScene(base: string, name: string) {
	if (!sceneCache || Date.now() - sceneCache.at > 10 * 60_000) {
		const all = JSON.parse(await curl([`${base}/scenes`])) as Record<string, any>;
		sceneCache = { at: Date.now(), list: Object.entries(all).filter(([, v]) => String(v.group) === HUE_GROUP) };
	}
	const hit = sceneCache.list.find(([, v]) => v.name === name);
	if (!hit) throw new Error(`シーンが見つからない: ${name}`);
	await curl(["-X", "PUT", `${base}/groups/${HUE_GROUP}/action`, "-d", JSON.stringify({ on: true, scene: hit[0] })]);
}

let sceneCache: { at: number; list: [string, any][] } | undefined;
async function hueFromText(text: string) {
	const key = JSON.parse(readFileSync(HUE_FILE, "utf8"))[0].success.username as string;
	const base = `https://${HUE_IP}/api/${key}`;
	const put = (action: object) => curl(["-X", "PUT", `${base}/groups/${HUE_GROUP}/action`, "-d", JSON.stringify(action)]);
	const quick = hueQuick(text);
	if (quick && "scene" in quick) return void (await hueScene(base, String(quick.scene)));
	if (quick) return void (await put(quick));
	if (!sceneCache || Date.now() - sceneCache.at > 10 * 60_000) {
		const all = JSON.parse(await curl([`${base}/scenes`])) as Record<string, any>;
		sceneCache = { at: Date.now(), list: Object.entries(all).filter(([, v]) => String(v.group) === HUE_GROUP) };
	}
	const scenes = sceneCache.list;
	const intent = JSON.parse(await ssh("/usr/bin/python3 ~/atelier/forge/streamdeck-herdr/hue_intent.py", JSON.stringify({ text, scenes: scenes.map(([, v]) => v.name), state: {} }), 60000));
	if (intent.type === "scene") {
		const hit = scenes.find(([, v]) => v.name === intent.name);
		if (!hit) throw new Error(`シーンが見つからない: ${intent.name}`);
		await put({ on: true, scene: hit[0] });
	} else if (intent.type === "state") {
		const { type: _t, ...action } = intent;
		await put(action);
	} else {
		throw new Error(`指示を理解できなかった: ${text}`);
	}
}
// ワンタッチ(声なし)のプリセットキー
const huePreset = (name: string): Cmd => {
	const info = () => loadPresets()[name];
	return {
		view: (_c, busy) => ({ color: busy ? BUSY : "#c2410c", emoji: info()?.emoji ?? "💡", word: busy ? "反映中" : "Hue", label: info()?.label ?? name }),
		run: async () => void (await run("/usr/bin/python3", [`${process.env.HOME}/streamdeck-herdr/hue.py`, "preset", name])),
	};
};
const hueVoice = holdToTalk("Hue 音声", "#c2410c", async (text) => hueFromText(text), false);

// ペイン操作: キーボードの prefix(Ctrl+B)を押さずに、分割・移動・ズームができる
const pane = (emoji: string, word: string, label: string, args: (p: string) => string): Cmd => ({
	view: (_c, busy) => ({ color: busy ? BUSY : "#3a5a4a", emoji, word, label }),
	run: async (c) => {
		const p = c.snap.focusedPaneId;
		if (!p) throw new Error("ペインが選ばれていない");
		await paneCmd(args(p));
	},
});

// 会議の文字起こし(HerdrScribe)の開始/停止。アプリは 127.0.0.1:18868 で待ち受ける
export async function scribeCall(path: string): Promise<"running" | "idle"> {
	const call = async () => (await (await fetch(`http://127.0.0.1:18868${path}`, { signal: AbortSignal.timeout(3000) })).text()) as "running" | "idle";
	try {
		return await call();
	} catch {
		await run("/usr/bin/open", ["-g", `${process.env.HOME}/Applications/HerdrScribe.app`]); // 起動していなければ起こす
		await new Promise((r) => setTimeout(r, 2500));
		return call();
	}
}

const KIND_JP: Record<string, string> = { claude: "Claude", codex: "Codex", hermes: "Hermes", opencode: "OpenCode" };

// 引き継ぎの組キー。向きは「いま選んでいるエージェント」で自動決定し、flip=true なら反転する
export function pairDirection(c: Ctx, [a, b]: [string, string], flip: boolean): { from: string; to: string } {
	const src = c.snap.focusedPaneId ? c.snap.paneAgents?.[c.snap.focusedPaneId] : undefined;
	let from = src === b ? b : a;
	let to = from === a ? b : a;
	if (flip) [from, to] = [to, from];
	return { from, to };
}
export function pairView(c: Ctx, pair: [string, string], flip: boolean, busy: boolean): View {
	const d = pairDirection(c, pair, flip);
	return { color: busy ? BUSY : "#6a4a8f", emoji: "🔀", word: busy ? "開始" : "長押しで実行", label: `${KIND_JP[d.from]}→${KIND_JP[d.to]}` };
}
const pairCmd = (pair: [string, string]): Cmd => ({ pair, view: (c, busy) => pairView(c, pair, false, busy) });

// 引き継ぎ: 元のエージェント本人にメモを書かせ、新しいタブで別のエージェントを起動して続きをやらせる
const handoff = (kind: string, label: string): Cmd => ({
	view: (_c, busy) => ({ color: busy ? BUSY : "#6a4a8f", emoji: "🔀", word: busy ? "開始" : "引き継ぎ", label: `→ ${label}` }),
	run: async (c) => void (await startHandoff(focusedAgent(c.snap), kind)),
});

export const COMMANDS: Record<string, Cmd> = {
	"think-toggle": {
		view: (_c, busy) => (busy ? { color: BUSY, emoji: "🎲", word: "切替中", label: "考え中の音" } : thinkOn() ? { color: "#4a3a6b", emoji: "🎲", word: "考え中の音 ON", label: "コロコロ" } : { color: "#555", emoji: "🎲", word: "考え中の音 OFF", label: "コロコロ" }),
		run: async () => void toggleThink(),
	},
	"tick-toggle": {
		view: (_c, busy) => (busy ? { color: BUSY, emoji: "🕰", word: "切替中", label: "作業中の時計" } : tickOn() ? { color: "#6b4f2a", emoji: "🕰", word: "時計 ON", label: CLOCK_JP[clockName()] } : { color: "#555", emoji: "🕰", word: "時計 OFF", label: "作業中の時計" }),
		run: async () => void toggleTick(),
	},
	"tick-switch": {
		view: () => ({ color: "#6b4f2a", emoji: "🔁", word: "時計を替える", label: CLOCK_JP[clockName()] }),
		run: async () => void nextClock(),
	},
	"hue-ambient": {
		view: (_c, busy) => {
			loadCfg();
			const m = ambientMode();
			const c = { idle: "#555", blocked: NG, done: OK, working: "#b8860b" }[m];
			return busy ? { color: BUSY, emoji: "💡", word: "切替中", label: "状態ライト" } : ambientEnabled() ? { color: m === "idle" ? "#3a5a4a" : c, emoji: "💡", word: "連動 ON", label: "状態ライト" } : { color: "#555", emoji: "💡", word: "連動 OFF", label: "状態ライト" };
		},
		run: async () => void (await ambientToggle()),
	},
	"hue-voice": hueVoice,
	"hue-p-focus": huePreset("focus"),
	"hue-p-relax": huePreset("relax"),
	"hue-p-warm": huePreset("warm"),
	"hue-p-cool": huePreset("cool"),
	"hue-p-read": huePreset("read"),
	"hue-p-night": huePreset("night"),
	"hue-p-energize": huePreset("energize"),
	"pair-claude-codex": pairCmd(["claude", "codex"]),
	"pair-claude-hermes": pairCmd(["claude", "hermes"]),
	"pair-claude-opencode": pairCmd(["claude", "opencode"]),
	"handoff-claude": handoff("claude", "Claude"),
	"handoff-codex": handoff("codex", "Codex"),
	"handoff-hermes": handoff("hermes", "Hermes"),
	"handoff-opencode": handoff("opencode", "OpenCode"),
	scribe: {
		view: (c, busy) =>
			c.scribe === "running"
				? { color: NG, emoji: "🔴", word: "録音中", label: "押して停止" }
				: { color: busy ? BUSY : "#4a3a8f", emoji: "🎙", word: busy ? "起動中" : "会議の字幕", label: "押して開始" },
		run: async () => void (await scribeCall("/toggle")),
	},
	usage: {
		view: (c, busy) => {
			const w = c.usage?.week?.pct, s = c.usage?.session?.pct;
			if (busy) return { color: BUSY, emoji: "🔄", word: "取得中", label: "使用量" };
			if (w === undefined) return { color: BASE, emoji: "📊", word: "確認中", label: "使用量" };
			const worst = Math.max(w, s ?? 0);
			return { color: worst >= 85 ? NG : worst >= 60 ? "#b8860b" : OK, emoji: "📊", word: `週 ${w}%`, label: `5h ${s ?? "?"}%` };
		},
		run: async () => void 0, // 押すと再取得(plugin 側の finally で pollUsage)
	},
	voice,
	enter: {
		view: (_c, busy) => ({ color: busy ? BUSY : "#2f9e6f", emoji: "⏎", word: "送信", label: "Enter" }),
		run: async (c) => void (await keysAgent(focusedAgent(c.snap), "Enter")),
	},
	"split-right": pane("◧", "右に分割", "split", (p) => `split --pane ${p} --direction right`),
	"split-down": pane("⬓", "下に分割", "split", (p) => `split --pane ${p} --direction down`),
	zoom: pane("🔍", "ズーム", "zoom", (p) => `zoom ${p}`),
	"focus-left": pane("◀", "左へ", "pane", (p) => `focus --pane ${p} --direction left`),
	"focus-right": pane("▶", "右へ", "pane", (p) => `focus --pane ${p} --direction right`),
	"focus-up": pane("🔼", "上へ", "pane", (p) => `focus --pane ${p} --direction up`),
	"focus-down": pane("🔽", "下へ", "pane", (p) => `focus --pane ${p} --direction down`),
	"q-continue": quick("⏩", "続けて", "続けて"),
	"q-diff": quick("🔍", "diff", "git diff を見せて、変更点を要約して"),
	"q-test": quick("🧪", "テスト", "テストを実行して、結果を要約して"),
	"q-commit": quick("💾", "commit", "変更をコミットして。push はしないで"),
	"q-esc": {
		view: (_c, busy) => ({ color: busy ? BUSY : "#7a3a3a", emoji: "⏹", word: "中断", label: "Esc" }),
		run: async (c) => void (await keysAgent(focusedAgent(c.snap), "Escape")),
	},
	clip: {
		view: (_c, busy) => ({ color: busy ? BUSY : BASE, emoji: "📋", word: busy ? "送信中" : "送る", label: "クリップボード" }),
		run: async (c) => {
			const pane = focusedAgent(c.snap);
			const text = (await run("/usr/bin/pbpaste", [])).trim();
			if (!text) throw new Error("クリップボードが空");
			await promptAgent(pane, text);
		},
	},
	shot: {
		view: (_c, busy) => ({ color: busy ? BUSY : BASE, emoji: "📸", word: busy ? "撮影中" : "画面を", label: "送る" }),
		run: async (c) => {
			const pane = focusedAgent(c.snap);
			const file = `${tmpdir()}/herdr-shot.png`;
			if (existsSync(file)) unlinkSync(file);
			await run("/usr/sbin/screencapture", ["-i", "-x", file]); // 範囲を選ぶ。Esc で取り消すとファイルができない
			if (!existsSync(file)) throw new Error("撮影が取り消された");
			const remote = await uploadShot(file);
			await promptAgent(pane, `このスクリーンショットを見て: ${remote}`);
		},
	},
	"cron-taifunome-daily": cron("b0a6385fdd6e", "台風 daily"),
	"cron-taifunome-weekly": cron("78de250e42f5", "台風 weekly"),
	"cron-taifunome-ig": cron("88351ab5cf17", "台風 IG"),
	"cron-taifunome-saved": cron("092a977b3c63", "台風 saved"),
	"cron-morning-brief": cron("b1f9f269ee08", "朝ブリーフ"),
	infra: {
		view: (c, busy) => {
			if (busy) return { color: BUSY, emoji: "🔧", word: "修復中", label: "基盤" };
			if (!c.infra) return { color: BASE, emoji: "🏥", word: "確認中", label: "基盤" };
			const down = Object.entries(c.infra).filter(([, ok]) => !ok).map(([k]) => k);
			return down.length
				? { color: NG, emoji: "🚑", word: down[0], label: "押して修復" }
				: { color: OK, emoji: "🏥", word: "正常", label: "基盤" };
		},
		run: async () => void (await repairInfra()),
	},
};
