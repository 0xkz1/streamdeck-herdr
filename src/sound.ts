// 作業中の時計(輪を切れ目なく繰り返す)と、通知音の抑制。
// 設定: ~/.config/herdr-sound.json  {"muted":false,"think":true,"thinkVolume":0.35,"tick":false,"clock":"grandfather","volume":0.3}
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isSleeping } from "./power";

const FILE = `${process.env.HOME}/.config/herdr-sound.json`;
const DIR = `${process.env.HOME}/streamdeck-herdr/sounds`;
export const CLOCKS = ["grandfather", "clock"] as const; // 台所の時計は環境音が混じるため除外(ファイルは残す)
export const CLOCK_JP: Record<string, string> = { grandfather: "柱時計", clock: "置き時計", kitchen: "台所の時計" };
type S = { muted: boolean; tick: boolean; clock: (typeof CLOCKS)[number]; volume: number; think: boolean; thinkVolume: number };

let s: S = { muted: false, tick: false, clock: "grandfather", volume: 0.3, think: true, thinkVolume: 0.35 };
let at = 0;
let proc: ChildProcess | undefined;
let playing = "";
const sounds = new Set<ChildProcess>();

export function loadSound(force = false): S {
	if (!force && Date.now() - at < 15_000) return s;
	at = Date.now();
	try {
		s = { ...s, ...JSON.parse(readFileSync(FILE, "utf8")) };
	} catch {
		if (!existsSync(FILE)) writeFileSync(FILE, JSON.stringify(s, null, 2));
	}
	return s;
}
const save = () => writeFileSync(FILE, JSON.stringify(s, null, 2));
export const isMuted = () => isSleeping() || loadSound().muted;
export function spawnSound(command: string, args: string[]): ChildProcess | undefined {
	if (isMuted()) return;
	const child = spawn(command, args, { stdio: "ignore" });
	sounds.add(child);
	child.once("close", () => sounds.delete(child));
	child.once("error", () => sounds.delete(child));
	return child;
}
export function toggleMute(): boolean {
	loadSound(true);
	s.muted = !s.muted;
	save();
	if (s.muted) {
		stopTick();
		for (const child of sounds) child.kill();
	}
	return s.muted;
}

export function stopSounds() {
	stopTick();
	for (const child of sounds) child.kill();
	// モデル開始音は SSH の別プロセスから起動するため、Herdr の音源だけを指定して止める。
	const directory = DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	execFile("/usr/bin/pkill", ["-f", `^/usr/bin/afplay .*${directory}/chime-`], () => {});
}
export const tickOn = () => loadSound().tick;
export const clockName = () => loadSound().clock;

export const thinkOn = () => loadSound().think;
export function toggleThink() {
	loadSound(true);
	s.think = !s.think;
	save();
}

export function toggleTick() {
	loadSound(true);
	s.tick = !s.tick;
	save();
	if (!s.tick) stopTick();
}
export function nextClock() {
	loadSound(true);
	s.clock = CLOCKS[(CLOCKS.indexOf(s.clock) + 1) % CLOCKS.length];
	save();
	if (proc) { stopTick(); } // 次の tick() で新しい時計から再開する
}

export function stopTick() {
	if (proc) proc.kill("SIGTERM");
	proc = undefined;
	playing = "";
}

// want = 鳴らすべきか。sox の repeat は切れ目のない繰り返し(拍がずれない)
export function tick(want: boolean) {
	const c = loadSound();
	if (!want || !c.tick || isMuted()) return stopTick();
	if (proc && playing === c.clock) return;
	stopTick();
	// 再起動前の子プロセスが残っていても、時計は1つだけにする。
	const directory = DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	try { execFileSync("/usr/bin/pkill", ["-f", `^/opt/homebrew/bin/play -q -v [^ ]+ ${directory}/tick-(grandfather|clock)\\.wav repeat 100000$`], { stdio: "ignore" }); } catch { /* 残っている時計が無い */ }
	playing = c.clock;
	const child = spawnSound("/opt/homebrew/bin/play", ["-q", "-v", String(c.volume), `${DIR}/tick-${c.clock}.wav`, "repeat", "100000"]);
	proc = child;
	child?.on("exit", () => { if (proc === child) { proc = undefined; playing = ""; } });
	child?.on("error", () => { if (proc === child) { proc = undefined; playing = ""; } });
}
