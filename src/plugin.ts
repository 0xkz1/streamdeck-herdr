import streamDeck, { action, DidReceiveSettingsEvent, KeyDownEvent, KeyUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, type KeyAction as SdKeyAction } from "@elgato/streamdeck";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFile, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fetchDrive, type DriveInfo, fetchPatrol, type PatrolInfo, fetchLimit, type LimitInfo, fetchActivity, fetchUsage, fetchGpu, fetchCpu, fetchSys, fetchCron, fetchInfra, type CronInfo, type Infra, fetchBriefAudio, fetchNarrationAudio, fetchLastBriefText, fetchSnapshot, focusTab, focusWorkspace, type Snapshot, type Status } from "./herdr";
import { renderEmpty, renderKey, tile, toDataUri } from "./render";
import { ambientLimitAlert, ambientSuspend, ambientTick, setGpuTemp } from "./ambient";
import { duckSound, isMuted, registerDuckHook, spawnSound, stopSounds, tick as tickClock, toggleMute } from "./sound";
import { startPowerWatch } from "./power";
import { duckProcess, musicPause, musicTick } from "./music";
import { setActivities, stopThinking, thinking } from "./thinking";
import { COMMANDS, pairDirection, pairView, type Ctx } from "./commands";
import { focusedAgent, startHandoff } from "./herdr";

registerDuckHook((child) => void duckProcess(child));

type KeyAction = SdKeyAction<any>;
const TERMINAL_APP = "iTerm";
const POLL_MS = 1200;
const FRAME_MS = 300;

let snap: Snapshot = { workspaces: [], tabs: [] };
let selectedWorkspace: string | undefined;
let spacePage = 0;
let tabPage = 0;
let frame = 0;
const keys = new Map<string, KeyAction>(); // Herdr Slot
const urgentKeys = new Map<string, KeyAction>(); // Herdr Urgent
const lastImage = new Map<string, string>();
const cmdKeys = new Map<string, { action: KeyAction; cmd?: string; flip?: boolean; lastPane?: string; fired?: boolean; timer?: ReturnType<typeof setTimeout> }>(); // Herdr Cmd
const busyCmd = new Set<string>();
let patrolState: PatrolInfo | undefined;
let driveState: DriveInfo | undefined;
let limitState: LimitInfo | undefined;
let limitPolling = false;
const limitSeen = new Set<string>();
let limitBaselined = false;
let patrolPolling = false;
let cronState: Record<string, CronInfo> = {};
let infraState: Infra | undefined;
let usageState: Awaited<ReturnType<typeof fetchUsage>> | undefined;
let gpuState: Awaited<ReturnType<typeof fetchGpu>> | undefined;
let cpuState: Awaited<ReturnType<typeof fetchCpu>> | undefined;
let sysState: Awaited<ReturnType<typeof fetchSys>> | undefined;
let scribeState: "running" | "idle" | "off" = "off";
const ctx = (): Ctx => ({ drive: driveState, patrol: patrolState, limit: limitState, snap, cron: cronState, infra: infraState, usage: usageState, gpu: gpuState, cpu: cpuState, sys: sysState, scribe: scribeState });

async function pollLimit() {
    if (limitPolling) return;
    limitPolling = true;
    try {
        limitState = await fetchLimit();
        // 新しく見つかった上限停止を、音と光で知らせる。起動直後の1回目は、すでにあるものを覚えるだけで鳴らさない
        const fresh = limitState.events.filter((e) => !limitSeen.has(e.id));
        limitState.events.forEach((e) => limitSeen.add(e.id));
        if (limitBaselined && fresh.length) { chime("limit"); ambientLimitAlert(); }
        limitBaselined = true;
    }
    catch { /* 取れなければ前回の表示のまま */ }
    finally { limitPolling = false; }
}

async function pollPatrol() {
    if (patrolPolling) return;
    patrolPolling = true;
    const [patrol, drive] = await Promise.allSettled([fetchPatrol(), fetchDrive()]);
    patrolState = patrol.status === "fulfilled" ? patrol.value : { state: "offline", counts: {}, processed: 0, total: 0 };
    driveState = drive.status === "fulfilled" ? drive.value : undefined;
    patrolPolling = false;
    paint();
}

async function pollGpu() {
	try {
		gpuState = await fetchGpu();
		setGpuTemp(gpuState.temp);
	} catch (e) {
		gpuState = undefined; // 取れないときは古い温度を出さない(「確認中」表示)
		streamDeck.logger.warn(`gpu poll failed: ${e}`);
	}
	paint();
}

async function pollCpu() {
	try {
		cpuState = await fetchCpu();
	} catch (e) {
		cpuState = undefined;
		streamDeck.logger.warn(`cpu poll failed: ${e}`);
	}
	paint();
}

async function pollSys() {
	try {
		sysState = await fetchSys();
	} catch (e) {
		sysState = undefined;
		streamDeck.logger.warn(`sys poll failed: ${e}`);
	}
	paint();
}

// 使用率は 5 分ごと(取得に約 6 秒かかるので頻繁には取らない)
async function pollUsage() {
	try {
		usageState = await fetchUsage();
	} catch (e) {
		streamDeck.logger.warn(`usage poll failed: ${e}`);
	}
	paint();
}

// HerdrScribe の状態(ローカル HTTP なので軽い)。アプリが動いていなければ "off"。起こさない
// 作業中のエージェントが何をしているか(読む/書く/実行/検索…)。作業中の間だけ2.5秒ごと。音の素材を変えるのに使う
let activityBusy = false;
async function pollActivity() {
	if (activityBusy || !snap.tabs.some((t) => t.agent && t.status === "working")) return setActivities([]);
	activityBusy = true;
	try {
		setActivities(Object.values(await fetchActivity()));
	} catch { /* 取れなければ、従来のランダムのまま */ } finally {
		activityBusy = false;
	}
}

async function pollScribe() {
	try {
		scribeState = (await (await fetch("http://127.0.0.1:18868/status", { signal: AbortSignal.timeout(1500) })).text()) as "running" | "idle";
	} catch {
		scribeState = "off";
	}
	paint();
}

// 重くない範囲で、cron の最終状態と基盤の死活を定期的に取る
async function pollAux() {
	try {
		[cronState, infraState] = await Promise.all([fetchCron(), fetchInfra()]);
	} catch (e) {
		streamDeck.logger.warn(`aux poll failed: ${e}`);
	}
	paint();
}

const RANK: Record<Status, number> = { blocked: 0, done: 1, working: 2, idle: 3, none: 4 };

const workspaceId = () => selectedWorkspace ?? snap.focusedWorkspaceId ?? snap.workspaces[0]?.id;
const tabsOf = (ws: string | undefined) => snap.tabs.filter((t) => t.workspaceId === ws);
// キーの位置は動かさない(押し間違いを防ぐ)。確認待ちは Urgent ボタンが知らせる。
const orderedWorkspaces = () => snap.workspaces;

function openTerminal() {
	execFile("/usr/bin/open", ["-a", TERMINAL_APP], () => {});
}

// ---- レイアウト: 置かれた Herdr Slot の位置から役割を決める(デバイスごと) ----
// 上段(row 0)=スペース / それ以外=タブ。他のアクションが置かれた位置は、そもそも keys に無いので自然に飛ばされる。
type Layout = { spaceKeys: KeyAction[]; tabKeys: KeyAction[] };
function layoutOf(a: KeyAction): Layout {
	const mine = [...keys.values()].filter((k) => k.device.id === a.device.id);
	const pos = (k: KeyAction) => k.coordinates!;
	return {
		spaceKeys: mine.filter((k) => pos(k).row === 0).sort((x, y) => pos(x).column - pos(y).column),
		tabKeys: mine.filter((k) => pos(k).row > 0).sort((x, y) => pos(x).row - pos(y).row || pos(x).column - pos(y).column),
	};
}
// スペースが置けるキー数を超えたら、最後のキーをページ送りにする
const hasPager = (l: Layout) => snap.workspaces.length > l.spaceKeys.length && l.spaceKeys.length > 1;
const perSpacePage = (l: Layout) => (hasPager(l) ? l.spaceKeys.length - 1 : l.spaceKeys.length);
const spacePages = (l: Layout) => Math.max(1, Math.ceil(snap.workspaces.length / Math.max(1, perSpacePage(l))));

function imageFor(a: KeyAction): string {
	const l = layoutOf(a);
	if (a.coordinates!.row === 0) {
		const i = l.spaceKeys.indexOf(a);
		if (hasPager(l) && i === l.spaceKeys.length - 1)
			return tile("#3a3358", "▶", "次のスペース", `${(spacePage % spacePages(l)) + 1}/${spacePages(l)}`);
		const w = orderedWorkspaces()[(spacePage % spacePages(l)) * perSpacePage(l) + i];
		return w ? renderKey({ label: w.label, status: w.status, selected: w.id === workspaceId(), kind: "space", frame }) : renderEmpty();
	}
	const t = tabsOf(workspaceId())[tabPage * l.tabKeys.length + l.tabKeys.indexOf(a)];
	return t ? renderKey({ label: t.agent ?? t.label, agent: t.agent, status: t.status, selected: t.id === snap.focusedTabId, kind: "tab", frame }) : renderEmpty();
}

// 一番優先度の高いタブ(確認待ち > 完了待ち)
function urgentTab() {
	return snap.tabs
		.filter((t) => t.agent && (t.status === "blocked" || t.status === "done"))
		.sort((x, y) => RANK[x.status] - RANK[y.status])[0];
}

function urgentImage(): string {
	const b = snap.tabs.filter((t) => t.agent && t.status === "blocked").length;
	const d = snap.tabs.filter((t) => t.agent && t.status === "done").length;
	if (b > 0) return tile(frame % 4 < 2 ? "#e5484d" : "#b83a3f", "🚨", `確認待ち ${b}`, "要対応へ");
	if (d > 0) return tile("#2f9e6f", "✅", `完了待ち ${d}`, "要対応へ");
	return tile("#2b2b33", "😌", "対応なし", "要対応へ");
}

function paint() {
	for (const [id, a] of keys) set(id, a, imageFor(a));
	for (const [id, a] of urgentKeys) set(id, a, urgentImage());
	for (const [id, k] of cmdKeys) {
		const c = k.cmd ? COMMANDS[k.cmd] : undefined;
		if (c?.pair && k.lastPane !== snap.focusedPaneId) { k.lastPane = snap.focusedPaneId; k.flip = false; } // 選択が変われば反転は解除
		if (c?.image) {
			set(id, k.action, c.image(ctx(), busyCmd.has(id)));
		} else {
			const v = c?.pair ? pairView(ctx(), c.pair, !!k.flip, busyCmd.has(id)) : c ? c.view(ctx(), busyCmd.has(id)) : { color: "#2b2b33", emoji: "⚙️", word: "未設定", label: "機能を選ぶ" };
			set(id, k.action, tile(v.color, v.emoji, v.word, v.label));
		}
	}
}

function set(id: string, a: KeyAction, svgOrUri: string) {
	if (lastImage.get(id) === svgOrUri) return;
	lastImage.set(id, svgOrUri);
	a.setImage(svgOrUri.startsWith("data:") ? svgOrUri : toDataUri(svgOrUri));
}

async function poll() {
	try {
		snap = await fetchSnapshot();
		detect(snap);
		void ambientTick(snap);
		// 作業中の時計: いずれかのエージェントが作業中で、自動読み上げが ON、消音中・会議の録音中でないとき
		const working = snap.tabs.filter((t) => t.agent && t.status === "working").length;
		void musicTick(scribeState === "running");
		const quiet = !autoOn || isMuted() || scribeState === "running"; // 自動読み上げ OFF・消音中・会議の録音中は鳴らさない
		tickClock(!quiet && working > 0);
		thinking(!quiet && working > 0, working);
	} catch (e) {
		streamDeck.logger.warn(`snapshot failed: ${e}`);
	}
	paint();
}

@action({ UUID: "com.kz003.herdr.slot" })
class Slot extends SingletonAction {
	override onWillAppear(ev: WillAppearEvent) {
		if (!ev.action.isKey()) return;
		keys.set(ev.action.id, ev.action);
		paint();
	}

	override onWillDisappear(ev: WillDisappearEvent) {
		keys.delete(ev.action.id);
		lastImage.delete(ev.action.id);
	}

	override async onKeyDown(ev: KeyDownEvent) {
		const a = ev.action as unknown as KeyAction;
		const l = layoutOf(a);
		try {
			if (a.coordinates!.row === 0) {
				const i = l.spaceKeys.indexOf(a);
				if (hasPager(l) && i === l.spaceKeys.length - 1) {
					spacePage = (spacePage + 1) % spacePages(l);
					paint();
					return;
				}
				const w = orderedWorkspaces()[(spacePage % spacePages(l)) * perSpacePage(l) + i];
				if (!w) return;
				if (w.id === workspaceId()) {
					// 選択中をもう一度 → タブの次のページ
					tabPage = (tabPage + 1) % Math.max(1, Math.ceil(tabsOf(w.id).length / Math.max(1, l.tabKeys.length)));
				} else {
					selectedWorkspace = w.id;
					tabPage = 0;
				}
				await focusWorkspace(w.id);
			} else {
				const t = tabsOf(workspaceId())[tabPage * l.tabKeys.length + l.tabKeys.indexOf(a)];
				if (!t) return;
				await focusTab(t.id);
			}
			openTerminal();
			await poll();
		} catch (e) {
			streamDeck.logger.error(`keyDown failed: ${e}`);
			await ev.action.showAlert();
		}
	}
}

// 一番優先度の高い(確認待ち > 完了待ち)タブへ一発で飛ぶ。読み上げは待たない
@action({ UUID: "com.kz003.herdr.urgent" })
class Urgent extends SingletonAction {
	override onWillAppear(ev: WillAppearEvent) {
		if (!ev.action.isKey()) return;
		urgentKeys.set(ev.action.id, ev.action);
		paint();
	}

	override onWillDisappear(ev: WillDisappearEvent) {
		urgentKeys.delete(ev.action.id);
		lastImage.delete(ev.action.id);
	}

	override async onKeyDown(ev: KeyDownEvent) {
		const t = urgentTab();
		if (!t) {
			await ev.action.showAlert();
			return;
		}
		try {
			selectedWorkspace = t.workspaceId;
			const anySlot = [...keys.values()][0];
			const size = anySlot ? Math.max(1, layoutOf(anySlot).tabKeys.length) : 1;
			tabPage = Math.floor(tabsOf(t.workspaceId).findIndex((x) => x.id === t.id) / size);
			await focusWorkspace(t.workspaceId);
			await focusTab(t.id);
			openTerminal();
			await poll();
		} catch (e) {
			streamDeck.logger.error(`urgent failed: ${e}`);
			await ev.action.showAlert();
		}
	}
}

@action({ UUID: "com.kz003.herdr.cmd" })
class CmdAction extends SingletonAction<{ cmd?: string }> {
	override onWillAppear(ev: WillAppearEvent<{ cmd?: string }>) {
		if (!ev.action.isKey()) return;
		cmdKeys.set(ev.action.id, { action: ev.action, cmd: ev.payload.settings.cmd });
		paint();
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<{ cmd?: string }>) {
		const k = cmdKeys.get(ev.action.id);
		if (k) k.cmd = ev.payload.settings.cmd;
		paint();
	}

	override onWillDisappear(ev: WillDisappearEvent<{ cmd?: string }>) {
		cmdKeys.delete(ev.action.id);
		busyCmd.delete(ev.action.id);
		lastImage.delete(ev.action.id);
	}

	override async onKeyUp(ev: KeyUpEvent<{ cmd?: string }>) {
		const id = ev.action.id;
		const k = cmdKeys.get(id);
		const c = k?.cmd ? COMMANDS[k.cmd] : undefined;
		if (c?.pair && k) {
			// 長押しが発火済みなら何もしない。短押しなら向きを反転
			if (k.timer) clearTimeout(k.timer);
			if (!k.fired) { k.flip = !k.flip; paint(); }
			return;
		}
		if (!c?.hold) return;
		try {
			await c.hold.up(ctx());
			await ev.action.showOk();
		} catch (e) {
			streamDeck.logger.warn(`hold up failed: ${e}`);
			await ev.action.showAlert();
		}
	}

	override async onKeyDown(ev: KeyDownEvent<{ cmd?: string }>) {
		const id = ev.action.id;
		if (cmdKeys.get(id)?.cmd === "mute-toggle") return toggleAllSound();
		const c = cmdKeys.get(id)?.cmd ? COMMANDS[cmdKeys.get(id)!.cmd!] : undefined;
		if (!c || busyCmd.has(id)) return;
		const k = cmdKeys.get(id)!;
		if (c.pair) {
			// 約0.7秒の長押しで、表示されている向きで引き継ぎを実行する
			k.fired = false;
			k.timer = setTimeout(async () => {
				k.fired = true;
				busyCmd.add(id);
				paint();
				try {
					const d = pairDirection(ctx(), c.pair!, !!k.flip);
					await startHandoff(focusedAgent(snap), d.to);
					k.flip = false;
					await ev.action.showOk();
				} catch (e) {
					streamDeck.logger.warn(`pair handoff failed: ${e}`);
					await ev.action.showAlert();
				} finally {
					busyCmd.delete(id);
			if (cmdKeys.get(id)?.cmd === "patrol-now" || cmdKeys.get(id)?.cmd?.startsWith("drive-")) void pollPatrol();
					paint();
				}
			}, 700);
			return;
		}
		if (c.hold) {
			// 押している間タイプ: down で開始(録音など)。終了処理は onKeyUp
			try {
				await c.hold.down(ctx());
			} catch (e) {
				streamDeck.logger.warn(`hold down failed: ${e}`);
				await ev.action.showAlert();
			}
			return;
		}
		busyCmd.add(id);
		paint();
		try {
			await c.run!(ctx());
			await ev.action.showOk();
		} catch (e) {
			streamDeck.logger.warn(`cmd failed: ${e}`);
			await ev.action.showAlert();
		} finally {
			busyCmd.delete(id);
			if (cmdKeys.get(id)?.cmd === "patrol-now" || cmdKeys.get(id)?.cmd?.startsWith("drive-")) void pollPatrol();
			void pollAux();
			void poll();
			void pollScribe();
			if (cmdKeys.get(id)?.cmd === "limit-handoff") void pollLimit();
			if (cmdKeys.get(id)?.cmd === "usage") void pollUsage();
			if (cmdKeys.get(id)?.cmd === "gpu") void pollGpu();
			if (cmdKeys.get(id)?.cmd === "cpu") void pollCpu();
			if (["alerts", "mem", "disk", "plimit"].includes(cmdKeys.get(id)?.cmd ?? "")) void pollSys();
		}
	}
}

// 読み上げた文章をダイアログで見せる(90秒で自動的に消える)
function showText(text: string) {
	execFile(
		"/usr/bin/osascript",
		[
			"-e", "on run argv",
			"-e", 'display dialog (item 1 of argv) with title "優先度" buttons {"閉じる"} default button 1 giving up after 90',
			"-e", "end run",
			text,
		],
		() => {},
	);
}

// ---- 読み上げの共通部 ----
let speaking: ChildProcess | undefined;
let briefing = false;
let seq = 0;
let muteEpoch = 0;

function play(wav: Buffer): Promise<void> {
	if (isMuted()) return Promise.resolve();
	const file = `${tmpdir()}/herdr-voice-${seq++ % 4}.wav`;
	writeFileSync(file, wav);
	return new Promise((done) => {
		const child = duckSound(spawnSound("/usr/bin/afplay", [file]));
		if (!child) return done();
		speaking = child;
		const finish = () => { if (speaking === child) speaking = undefined; done(); };
		child.once("close", finish);
		child.once("error", finish);
	});
}

const briefImage = (emoji: string, word: string) => tile("#7c5cff", emoji, word, "優先度");

// ---- 自動読み上げ: 確認待ちになった/長い作業が終わった瞬間に、そのタブの内容を読む ----
const AUTO_DONE_MIN_MS = 30_000;
const AGENT_JP: Record<string, string> = { claude: "クロード", codex: "コーデックス", opencode: "オープンコード", hermes: "ヘルメス" };
let autoOn = true;
let baselined = false;
const prev = new Map<string, { status: Status; since: number }>();
const queue: { paneId: string; kind: "blocked" | "done"; where: string }[] = [];
let draining = false;

function toggleAllSound() {
	muteEpoch++;
	if (toggleMute()) {
		queue.length = 0;
		stopThinking();
		void musicPause().catch((e) => streamDeck.logger.warn(`music pause failed: ${e}`));
	}
	paint();
}

// ---- 通知音: 出来事の大きさに合わせる(普通の完了=done、確認待ち=ask、長い作業の完了=big、特に長い作業の完了=huge) ----
const SOUND_DIR = `${process.env.HOME}/streamdeck-herdr/sounds`;
const BIG_WORK_MS = 20 * 60_000; // これ以上働いた後の完了は「大きな達成」
const HUGE_WORK_MS = 30 * 60_000; // これ以上は「特大」
const lastChime = new Map<string, number>();
const lastPick = new Map<string, string>();
function chime(kind: "ask" | "done" | "big" | "huge" | "limit") {
	if (isMuted() || scribeState === "running") return; // 消音中または会議の録音中は鳴らさない
	const now = Date.now();
	if (now - (lastChime.get(kind) ?? 0) < 20_000) return; // 同じ音は20秒に1回まで
	lastChime.set(kind, now);
	// バンク(sounds/<kind>/*.wav)からランダムに1つ。直前と同じものは避ける。無ければ従来の1ファイル
	const bank = kind === "limit" ? "ask" : kind; // 上限の知らせは「ask」の音(赤い光で確認待ち=紫と見分ける)
	let file = `${SOUND_DIR}/${bank}.wav`;
	try {
		const dir = `${SOUND_DIR}/${bank}`;
		const all = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".wav")) : [];
		const pool = all.length > 1 ? all.filter((f) => f !== lastPick.get(kind)) : all;
		if (pool.length) {
			const f = pool[Math.floor(Math.random() * pool.length)];
			lastPick.set(kind, f);
			file = `${dir}/${f}`;
		}
	} catch { /* 従来の音で鳴らす */ }
	duckSound(spawnSound("/usr/bin/afplay", ["-v", "0.6", file]));
}

function detect(next: Snapshot) {
	const now = Date.now();
	for (const t of next.tabs) {
		// 起動後に現れた新しいタブは「状態なし」からの変化として扱う(最初から確認待ちでも読む)
		const p = prev.get(t.id) ?? (baselined ? { status: "none" as Status, since: now } : undefined);
		if (baselined && autoOn && !isMuted() && p && p.status !== t.status && t.agent) {
			if (t.status === "blocked") chime("ask");
			else if (t.status === "done" && p.status === "working" && now - p.since >= AUTO_DONE_MIN_MS) {
				const elapsed = now - p.since;
				chime(elapsed >= HUGE_WORK_MS ? "huge" : elapsed >= BIG_WORK_MS ? "big" : "done");
			}
		}
		if (baselined && autoOn && !isMuted() && p && p.status !== t.status && t.paneId && t.agent) {
			const ws = next.workspaces.find((w) => w.id === t.workspaceId)?.label ?? "";
			const where = `${ws}の${AGENT_JP[t.agent] ?? t.agent}`;
			if (t.status === "blocked") enqueue({ paneId: t.paneId, kind: "blocked", where });
			else if (t.status === "done" && p.status === "working" && now - p.since >= AUTO_DONE_MIN_MS)
				enqueue({ paneId: t.paneId, kind: "done", where });
		}
		if (!p || p.status !== t.status) prev.set(t.id, { status: t.status, since: now });
	}
	baselined = true;
}

function enqueue(job: (typeof queue)[number]) {
	if (queue.some((q) => q.paneId === job.paneId && q.kind === job.kind)) return;
	queue.push(job);
	void drain();
}

async function drain() {
	if (draining) return;
	draining = true;
	try {
		while (queue.length) {
			while (speaking || briefing) await new Promise((r) => setTimeout(r, 1000));
			if (!queue.length) break;
			const job = queue.shift()!;
			const epoch = muteEpoch;
			try {
				const wav = await fetchNarrationAudio(job.paneId, job.kind, job.where);
				if (epoch === muteEpoch) await play(wav);
			} catch (e) {
				streamDeck.logger.warn(`narration failed: ${e}`);
			}
		}
	} finally {
		draining = false;
	}
}

const autoImage = () => (autoOn ? tile("#2f9e6f", "🔔", "自動読み上げ", "ON") : tile("#555", "🔕", "自動読み上げ", "OFF"));

@action({ UUID: "com.kz003.herdr.auto" })
class Auto extends SingletonAction {
	override async onWillAppear(ev: WillAppearEvent) {
		if (!ev.action.isKey()) return;
		const g = (await streamDeck.settings.getGlobalSettings()) as { autoOn?: boolean };
		autoOn = g.autoOn ?? true;
		await ev.action.setImage(autoImage());
	}

	override async onKeyDown(ev: KeyDownEvent) {
		autoOn = !autoOn;
		if (!autoOn) queue.length = 0;
		await streamDeck.settings.setGlobalSettings({ autoOn });
		await ev.action.setImage(autoImage());
	}
}

// 押すと優先順を読み上げ、読み上げ中にもう一度押すと止める
@action({ UUID: "com.kz003.herdr.brief" })
class Brief extends SingletonAction {
	override onWillAppear(ev: WillAppearEvent) {
		if (ev.action.isKey()) return ev.action.setImage(briefImage("📋", "読む"));
	}

	override async onKeyDown(ev: KeyDownEvent) {
		if (isMuted()) return;
		if (speaking) {
			speaking.kill();
			queue.length = 0;
			return;
		}
		if (briefing) return;
		briefing = true;
		try {
			await ev.action.setImage(briefImage("🤔", "集計中"));
			const epoch = muteEpoch;
			const wav = await fetchBriefAudio();
			if (epoch !== muteEpoch) return;
			fetchLastBriefText().then(showText).catch((e) => streamDeck.logger.warn(`show text failed: ${e}`));
			await ev.action.setImage(briefImage("🔊", "再生中"));
			await play(wav);
		} catch (e) {
			streamDeck.logger.error(`brief failed: ${e}`);
			await ev.action.showAlert();
		} finally {
			briefing = false;
			await ev.action.setImage(briefImage("📋", "読む"));
		}
	}
}

streamDeck.actions.registerAction(new Slot());
streamDeck.actions.registerAction(new Brief());
streamDeck.actions.registerAction(new Urgent());
streamDeck.actions.registerAction(new CmdAction());
streamDeck.actions.registerAction(new Auto());
streamDeck.connect();
startPowerWatch(async (sleeping) => {
	muteEpoch++;
	queue.length = 0;
	stopThinking();
	if (sleeping) {
		stopSounds();
		await musicPause().catch((e) => streamDeck.logger.warn(`music pause failed: ${e}`));
	}
	else { baselined = false; prev.clear(); }
	await ambientSuspend(sleeping);
	streamDeck.logger.info(sleeping ? "Mac sleep: sound and Hue paused" : "Mac awake: sound and Hue resumed");
}, (message) => streamDeck.logger.warn(message));
setInterval(pollPatrol, 5_000);
void pollPatrol();
setInterval(pollLimit, 10_000);
void pollLimit();
setInterval(poll, POLL_MS);
setInterval(pollAux, 30_000);
void pollAux();
setInterval(pollUsage, 300_000);
void pollUsage();
setInterval(pollGpu, 10_000);
void pollGpu();
setInterval(pollCpu, 10_000);
void pollCpu();
setInterval(pollSys, 10_000);
void pollSys();
setInterval(pollScribe, 3_000);
setInterval(pollActivity, 2_500);
void pollScribe();
setInterval(() => {
	frame++;
	paint();
}, FRAME_MS);
poll();
