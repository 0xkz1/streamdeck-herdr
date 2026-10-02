// 「考え中」の音: 頭の中を何かが転がるような音を、素材と間隔をランダムに変えて鳴らす(飽きないように)。
// バンク: sounds/think/<素材>-<番号>.wav (make_sounds.py で作る)。拍を作らない(間隔は不規則)。
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { loadSound } from "./sound";

const DIR = `${process.env.HOME}/streamdeck-herdr/sounds/think`;
// 出やすさ(大きいほど多い)。サラサラや金属は控えめに
const WEIGHT: Record<string, number> = { wood: 3, ceramic: 2.5, bamboo: 2.2, glass: 2, stone: 1.5, bowl: 1.5, shell: 1.3, seeds: 1, metal: 1, coin: 0.8 };

let timer: ReturnType<typeof setTimeout> | undefined;
let level = 1; // 作業中のエージェント数(多いほど間隔が詰まる)
let lastKind = "";
let bank: Record<string, string[]> | undefined;

function loadBank() {
	if (bank) return bank;
	bank = {};
	if (!existsSync(DIR)) return bank;
	for (const f of readdirSync(DIR)) {
		const k = f.split("-")[0];
		(bank[k] ??= []).push(`${DIR}/${f}`);
	}
	return bank;
}

function pick(): string | undefined {
	const b = loadBank();
	const kinds = Object.keys(b).filter((k) => k !== lastKind); // 同じ素材を続けて選ばない
	const total = kinds.reduce((s, k) => s + (WEIGHT[k] ?? 1), 0);
	let x = Math.random() * total;
	for (const k of kinds) {
		x -= WEIGHT[k] ?? 1;
		if (x <= 0) {
			lastKind = k;
			return b[k][Math.floor(Math.random() * b[k].length)];
		}
	}
}

function next() {
	const c = loadSound();
	const f = pick();
	if (f) {
		const vol = Math.max(0.05, c.thinkVolume * (0.7 + Math.random() * 0.5)); // 強さも毎回少し変える
		spawn("/usr/bin/afplay", ["-v", String(vol), f], { stdio: "ignore" }).on("error", () => {});
	}
	const gap = (2.2 + Math.random() * 5.5) / (0.75 + 0.25 * Math.min(level, 3)); // 2〜8秒。エージェントが多いほど詰める
	timer = setTimeout(next, gap * 1000);
}

export function stopThinking() {
	if (timer) clearTimeout(timer);
	timer = undefined;
}

// want=鳴らすべきか、working=作業中のエージェント数
export function thinking(want: boolean, working: number) {
	level = Math.max(1, working);
	if (!want || !loadSound().think) return stopThinking();
	if (!timer) timer = setTimeout(next, 800 + Math.random() * 1500);
}
