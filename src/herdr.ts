import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { CONFIG } from "./config";

// Mac から Ubuntu の herdr を ssh 経由で叩く。非対話 ssh では PATH に ~/.local/bin が無いのでフルパス。
const HOST = CONFIG.sshHost;
const HERDR = "~/.local/bin/herdr";
const SSH_OPTS = [
	"-o", "BatchMode=yes",
	"-o", "ConnectTimeout=3",
	"-o", "ControlMaster=auto",
	"-o", "ControlPath=~/.ssh/cm-sd-%r@%h:%p",
	"-o", "ControlPersist=10m",
];

export type Status = "blocked" | "working" | "done" | "idle" | "none";

export type Workspace = { id: string; label: string; status: Status };
export type Tab = { id: string; workspaceId: string; label: string; status: Status; agent?: string; paneId?: string };
export type Snapshot = {
	workspaces: Workspace[];
	tabs: Tab[];
	focusedWorkspaceId?: string;
	focusedTabId?: string;
	focusedPaneId?: string;
	agentPaneIds?: string[];
	paneAgents?: Record<string, string>;
};

const toStatus = (s: string | undefined): Status =>
	s === "blocked" || s === "working" || s === "done" || s === "idle" ? s : "none";

function herdr(args: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("/usr/bin/ssh", [...SSH_OPTS, HOST, `${HERDR} ${args}`], { timeout: 5000 }, (err, stdout) =>
			err ? reject(err) : resolve(stdout),
		);
	});
}

export async function fetchSnapshot(): Promise<Snapshot> {
	const s = JSON.parse(await herdr("api snapshot")).result.snapshot;
	return {
		workspaces: s.workspaces.map((w: any) => ({ id: w.workspace_id, label: w.label, status: toStatus(w.agent_status) })),
		tabs: s.tabs.map((t: any) => ({
			id: t.tab_id,
			workspaceId: t.workspace_id,
			label: t.label,
			status: toStatus(t.agent_status),
			agent: s.agents.find((a: any) => a.tab_id === t.tab_id)?.agent,
			paneId: s.agents.find((a: any) => a.tab_id === t.tab_id)?.pane_id,
		})),
		focusedWorkspaceId: s.focused_workspace_id,
		focusedTabId: s.focused_tab_id,
		focusedPaneId: s.focused_pane_id,
		agentPaneIds: s.agents.map((a: any) => a.pane_id),
		paneAgents: Object.fromEntries(s.agents.map((a: any) => [a.pane_id, a.agent])),
	};
}

export const focusWorkspace = (id: string) => herdr(`workspace focus ${id}`);
export const focusTab = (id: string) => herdr(`tab focus ${id}`);

// 全セッションを俯瞰した優先順の読み上げ音声(WAV)。文章化も音声合成も Ubuntu 側で行い、Mac は再生するだけ。
const DIR = "~/atelier/forge/streamdeck-herdr";
export const fetchBriefAudio = () =>
	new Promise<Buffer>((resolve, reject) => {
		execFile(
			"/usr/bin/ssh",
			[...SSH_OPTS, HOST, `${DIR}/brief.sh`],
			{ timeout: 120000, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
			(err, stdout) => (err ? reject(err) : resolve(stdout)),
		);
	});

// 直近に読み上げた文章(画面表示用)
export const fetchLastBriefText = () =>
	new Promise<string>((resolve, reject) => {
		execFile("/usr/bin/ssh", [...SSH_OPTS, HOST, `cat ${DIR}/last-brief.txt`], { timeout: 8000 }, (err, stdout) =>
			err ? reject(err) : resolve(stdout.trim()),
		);
	});

// 1タブ分の読み上げ音声(確認待ち/完了を検知したとき用)
export const fetchNarrationAudio = (paneId: string, kind: "blocked" | "done", where: string) =>
	new Promise<Buffer>((resolve, reject) => {
		const safe = where.replace(/[^\p{L}\p{N}_ -]/gu, "");
		execFile(
			"/usr/bin/ssh",
			[...SSH_OPTS, HOST, `${DIR}/narrate.sh ${paneId} ${kind} '${safe}'`],
			{ timeout: 120000, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
			(err, stdout) => (err ? reject(err) : resolve(stdout)),
		);
	});

// ---- 汎用 ----
const DIR_ = "~/atelier/forge/streamdeck-herdr";
export function ssh(cmd: string, input?: string, timeout = 15000): Promise<string> {
	return new Promise((resolve, reject) => {
		const p = execFile("/usr/bin/ssh", [...SSH_OPTS, HOST, cmd], { timeout }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
		if (input !== undefined) p.stdin!.end(input);
	});
}
const b64 = (t: string) => Buffer.from(t).toString("base64");

// いま選んでいるペインのエージェントに、文章を送信/キーを送る。エージェントがいなければ例外
export function focusedAgent(snap: Snapshot): string {
	const p = snap.focusedPaneId;
	if (!p || !snap.agentPaneIds?.includes(p)) throw new Error("選択中のペインにエージェントがいない");
	return p;
}
export const promptAgent = (pane: string, text: string) => ssh(`${HERDR} agent prompt ${pane} "$(base64 -d)"`, b64(text));
export const keysAgent = (pane: string, keys: string) => ssh(`${HERDR} agent send-keys ${pane} ${keys}`);

// Hermes cron
export const cronRun = (id: string) => ssh(`${CONFIG.remoteHome}/.local/bin/hermes cron run ${id}`, undefined, 30000);
export type CronInfo = { status?: string; at?: string; state?: string };
export async function fetchCron(): Promise<Record<string, CronInfo>> {
	const raw = JSON.parse(await ssh(`/usr/bin/python3 ${DIR_}/cron-status.py`));
	return Object.fromEntries(Object.entries(raw).map(([k, v]: any) => [k, { status: v[0], at: v[1], state: v[2] }]));
}

// GPU の温度・使用率・電力(nvidia-smi。軽いので 10 秒ごと)
export type Gpu = { temp: number; util: number; power: number };
export async function fetchGpu(): Promise<Gpu> {
	const [temp, util, power] = (await ssh(`${DIR_}/gpu.sh`)).trim().split(/\s+/).map(Number);
	if ([temp, util, power].some(Number.isNaN)) throw new Error("gpu parse");
	return { temp, util, power };
}

// CPU の温度(Tctl)と使用率
export type Cpu = { temp: number; util: number };
export async function fetchCpu(): Promise<Cpu> {
	const [temp, util] = (await ssh(`${DIR_}/cpu.sh`)).trim().split(/\s+/).map(Number);
	if ([temp, util].some(Number.isNaN)) throw new Error("cpu parse");
	return { temp, util };
}

// メモリ/VRAM/ディスク/NVMe/電力制限/発火中アラート(sys.py が 1 回で返す)
export type Sys = {
	mem: { pct: number; usedG: number; totalG: number };
	vram: { usedMiB: number; totalMiB: number };
	plimit: number;
	disk: { availG: number; pct: number };
	nvme: number;
	alerts: { name: string; summary: string }[] | null; // null = Prometheus に届かない
};
export const fetchSys = async (): Promise<Sys> => JSON.parse(await ssh(`/usr/bin/python3 ${DIR_}/sys.py`));
export const togglePowerLimit = () => ssh(`${DIR_}/plimit.sh`, undefined, 15000);

// 基盤サービスの死活
export type Infra = Record<string, boolean>;
export async function fetchInfra(): Promise<Infra> {
	const out = await ssh(`${DIR_}/infra.sh`);
	return Object.fromEntries(out.trim().split(/\s+/).map((kv) => kv.split("=")).map(([k, v]) => [k, v === "200"]));
}
export const repairInfra = () => ssh("~/.hermes/scripts/open-design-health-check.sh", undefined, 120000).catch(() => "");
export const uploadShot = (localPath: string) => {
	const name = `shot-${Date.now()}.png`;
	return new Promise<string>((resolve, reject) => {
		execFile("/usr/bin/scp", ["-q", "-o", "BatchMode=yes", localPath, `${HOST}:${DIR_.replace("~", CONFIG.remoteHome)}/shots/${name}`], (err) =>
			err ? reject(err) : resolve(`${CONFIG.remoteHome}/atelier/forge/streamdeck-herdr/shots/${name}`),
		);
	});
};
export const readClipboardFile = (p: string) => readFileSync(p, "utf8");

// 文字を入力欄に打つだけ(Enter は送らない。誤認識をそのまま実行しないため)
export const typeAgent = (pane: string, text: string) => ssh(`${HERDR} pane send-text ${pane} "$(base64 -d)"`, b64(text));
// ペイン操作(分割・移動・ズーム)。キーボードの prefix を使わずに済む
export const paneCmd = (args: string) => ssh(`${HERDR} pane ${args}`);

// Claude のプラン使用率(`claude -p /usage`。モデルを呼ばない)
export type Usage = { session?: { pct: number; resets: string }; week?: { pct: number; resets: string } };
export const fetchUsage = async (): Promise<Usage> => JSON.parse(await ssh(`/usr/bin/python3 ${DIR_}/usage.py`, undefined, 60000));

// 選択中のエージェントの続きを、別のエージェントに引き継ぐ(Ubuntu 側で非同期に進む。完了まで数分)
export const startHandoff = (pane: string, kind: string) =>
	ssh(`nohup /usr/bin/python3 ${DIR_}/handoff.py ${pane} ${kind} > ~/handoffs/last.log 2>&1 < /dev/null & echo started`);

// 作業中の Claude Code が「いま何をしているか」(read/write/run/search/web/agent/think)。画面の文字から判定
export const fetchActivity = async (): Promise<Record<string, string>> => JSON.parse(await ssh(`/usr/bin/python3 ${DIR_}/activity.py`, undefined, 12000));

export type PatrolInfo = {
    state: "idle" | "running" | "done" | "interrupted" | "offline";
    processed: number;
    total: number;
    counts: { sent?: number; hold?: number; complete?: number; failed?: number; uncertain?: number };
};
// Claude/Codex が使用上限で止まったペイン(limit_watch.py が2分ごとに記録)
export type LimitEvent = { id: string; agent: string; target: string; label: string; reset: string };
export type LimitInfo = { pending: number; events: LimitEvent[] };
export const fetchLimit = async (): Promise<LimitInfo> => JSON.parse(await ssh(`/usr/bin/python3 ${DIR_}/limit_watch.py status`));
export const startLimitHandoff = (id: string) => {
	if (!/^[0-9a-f]{8}$/.test(id)) throw new Error(`bad limit id: ${id}`);
	return ssh(`nohup /usr/bin/python3 ${DIR_}/limit_watch.py go ${id} > ~/handoffs/last.log 2>&1 < /dev/null & echo started`);
};

export async function fetchPatrol(): Promise<PatrolInfo> {
    return JSON.parse(await ssh("/usr/bin/python3 ~/atelier/forge/herdr/patrol_trigger.py summary"));
}
