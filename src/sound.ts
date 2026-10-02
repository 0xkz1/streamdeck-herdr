// 作業中の時計(輪を切れ目なく繰り返す)と、通知音の抑制。
// 設定: ~/.config/herdr-sound.json  {"think":true,"thinkVolume":0.35,"tick":false,"clock":"grandfather","volume":0.3}
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const FILE = `${process.env.HOME}/.config/herdr-sound.json`;
const DIR = `${process.env.HOME}/streamdeck-herdr/sounds`;
export const CLOCKS = ["grandfather", "clock"] as const; // 台所の時計は環境音が混じるため除外(ファイルは残す)
export const CLOCK_JP: Record<string, string> = { grandfather: "柱時計", clock: "置き時計", kitchen: "台所の時計" };
type S = { tick: boolean; clock: (typeof CLOCKS)[number]; volume: number; think: boolean; thinkVolume: number };

let s: S = { tick: false, clock: "grandfather", volume: 0.3, think: true, thinkVolume: 0.35 };
let at = 0;
let proc: ChildProcess | undefined;
let playing = "";

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
	if (!want || !c.tick) return stopTick();
	if (proc && playing === c.clock) return;
	stopTick();
	playing = c.clock;
	proc = spawn("/opt/homebrew/bin/play", ["-q", "-v", String(c.volume), `${DIR}/tick-${c.clock}.wav`, "repeat", "100000"], { stdio: "ignore" });
	proc.on("exit", () => { proc = undefined; playing = ""; });
	proc.on("error", () => { proc = undefined; playing = ""; });
}
