// 「考え中」の音: 頭の中を何かが転がるような音を、素材と間隔をランダムに変えて鳴らす(飽きないように)。
// バンク: sounds/think/<素材>-<番号>.wav (make_sounds.py で作る)。拍を作らない(間隔は不規則)。
import { existsSync, readdirSync } from "node:fs";
import { isMuted, loadSound, spawnSound } from "./sound";

const DIR = `${process.env.HOME}/streamdeck-herdr/sounds/think`;
const WHISPERS = `${process.env.HOME}/streamdeck-herdr/sounds/whisper`;
const PITCHES = [-1200, -900, -700, -500, -300, 0, 200, 400, 700, 900, 1200]; // セント。上下1オクターブ、テンポはそのまま
// 出やすさ(大きいほど多い)。サラサラや金属は控えめに
const WEIGHT: Record<string, number> = {
	wood: 3, ceramic: 2.5, bamboo: 2.2, glass: 2, stone: 1.5, bowl: 1.5, shell: 1.3, seeds: 1, metal: 1, coin: 0.8,
	marble: 1.6, porcelain: 1.4, jade: 1.3, slate: 1.3, basalt: 1.2, bone: 1.3, pearl: 1.2, copper: 1, brass: 1, plastic: 1, gravel: 0.9, ice: 0.9, iron: 0.8, steel: 0.8, tin: 0.8, crystal: 0.8,
};

// 動作 → 素材の出やすさ。音を聞くだけで、読んでいるのか/書いているのか/実行しているのかが分かる
const BY_ACTIVITY: Record<string, Record<string, number>> = {
	read: { seeds: 3, shell: 3, bamboo: 0.5, gravel: 2, ice: 1.5, plastic: 1 }, // 軽くサラサラ
	write: { wood: 3, bamboo: 3, ceramic: 0.8, bone: 2.5, plastic: 1.5 }, // 木のコロコロ
	run: { metal: 3, ceramic: 2, coin: 1.5, iron: 2.5, tin: 2.5, steel: 2, copper: 2, brass: 2 }, // 金属・陶器
	search: { glass: 3, coin: 2.5, metal: 0.5, crystal: 2.5, porcelain: 2, pearl: 2, ice: 1.5 }, // 澄んだ音
	web: { bowl: 4, glass: 1, seeds: 0.5, marble: 2, jade: 1.5 }, // 遠くから転がってくる
	agent: { bowl: 2.5, metal: 1.5, ceramic: 1.5, jade: 1, brass: 1, porcelain: 1 },
	think: { stone: 3, bowl: 2, wood: 1, basalt: 3, slate: 2.5, marble: 1.5 }, // 低く静か
};
let activities: string[] = [];
export const setActivities = (a: string[]) => { activities = a; };

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
	// ヒソヒソも素材の1つとして同じ束に入れる(言葉のない囁き。男女・高低の8本)
	if (existsSync(WHISPERS)) bank.whisper = readdirSync(WHISPERS).filter((f) => f.endsWith(".wav")).map((f) => `${WHISPERS}/${f}`);
	return bank;
}

function pick(): string | undefined {
	const b = loadBank();
	// 動作が分かっていれば、その動作に対応する素材の出やすさを使う(複数のエージェントが動いていれば、ランダムに1つ)
	const act = activities.length ? activities[Math.floor(Math.random() * activities.length)] : "";
	const w: Record<string, number> = { ...(BY_ACTIVITY[act] ?? WEIGHT), whisper: 1 }; // どの動作でも同じ出やすさ(seeds や metal と同程度)
	const kinds = Object.keys(b).filter((k) => k !== lastKind && (w[k] ?? 0) > 0); // 同じ素材を続けて選ばない
	if (!kinds.length) return undefined;
	const total = kinds.reduce((s, k) => s + (w[k] ?? 0), 0);
	let x = Math.random() * total;
	for (const k of kinds) {
		x -= w[k] ?? 0;
		if (x <= 0) {
			lastKind = k;
			return b[k][Math.floor(Math.random() * b[k].length)];
		}
	}
}

function next() {
	const c = loadSound();
	if (isMuted()) return stopThinking();
	const f = pick();
	if (f) {
		const vol = Math.max(0.05, c.thinkVolume * (0.7 + Math.random() * 0.5)); // 強さも毎回少し変える
		const whisper = f.startsWith(WHISPERS); // 囁きは小さめに、ピッチはそのまま
		const args = ["-q", "-v", String(whisper ? vol * 0.55 : vol), f];
		if (!whisper) args.push("pitch", String(PITCHES[Math.floor(Math.random() * PITCHES.length)]));
		spawnSound("/opt/homebrew/bin/play", args);
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
	const c = loadSound();
	if (!want || !c.think || isMuted()) return stopThinking();
	if (!timer) timer = setTimeout(next, 800 + Math.random() * 1500);
}
