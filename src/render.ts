import type { Status } from "./herdr";
import { ICONS } from "./icons";

const COLOR: Record<Status, string> = {
	blocked: "#e5484d",
	working: "#f5c542",
	done: "#7be0b0",
	idle: "#3b82f6",
	none: "#2a1f3d",
};

const WORD: Record<Status, string> = {
	blocked: "確認待ち",
	working: "作業中",
	done: "完了",
	idle: "待機",
	none: "—",
};

// 状態ごとに2コマ。frame の偶奇で切り替えて動いて見せる
const EMOJI: Record<Status, [string, string]> = {
	blocked: ["🙋", "❗"],
	working: ["⌨️", "⚙️"],
	done: ["🎉", "✨"],
	idle: ["😴", "💤"],
	none: ["🫥", "🫥"],
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// 全角は幅2として数え、収まる分だけ残す
function clip(s: string, max: number): string {
	let w = 0;
	let out = "";
	for (const ch of s) {
		w += ch.charCodeAt(0) > 0x7f ? 2 : 1;
		if (w > max) return out + "…";
		out += ch;
	}
	return out;
}

export function renderKey(opts: { label: string; status: Status; selected: boolean; kind: "space" | "tab"; frame: number; agent?: string }): string {
	const { label, status, selected, kind, frame, agent } = opts;
	if (status === "none") {
		// 情報が無い場所は目立たせない: 暗い面にスペース名/タブ名だけ
		const op = selected ? 0.9 : 0.5;
		return (
			`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" fill="${COLOR.none}"/>` +
			`<text x="72" y="82" font-size="26" font-family="Helvetica,sans-serif" font-weight="600" text-anchor="middle" fill="#c9b8ff" opacity="${op}">${esc(clip(label, 10))}</text></svg>`
		);
	}
	const bg = COLOR[status];
	const dim = selected ? "" : `<rect width="144" height="144" fill="#000" opacity="0.45"/>`;
	// blocked だけ点滅して目を引く
	const blink = status === "blocked" && frame % 4 < 2 ? `<rect width="144" height="144" fill="#fff" opacity="0.25"/>` : "";
	const fg = "#111";
	const mark = kind === "space" ? `<rect x="0" y="0" width="144" height="10" fill="#000" opacity="0.35"/>` : "";
	const emoji = EMOJI[status][(frame >> 1) % 2];
	// ロゴがあるエージェントはロゴを主役にし、状態の絵文字は右下のバッジにする
	const art =
		agent && ICONS[agent]
			? `<image href="${ICONS[agent]}" x="30" y="34" width="84" height="84"/>` +
				`<text x="116" y="116" font-size="40" font-family="Apple Color Emoji" text-anchor="middle">${emoji}</text>`
			: `<text x="72" y="100" font-size="64" font-family="Apple Color Emoji" text-anchor="middle">${emoji}</text>`;
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">` +
		`<rect width="144" height="144" fill="${bg}"/>${mark}${blink}${dim}` +
		`<text x="72" y="26" font-size="24" font-family="Hiragino Sans,Helvetica,sans-serif" font-weight="800" text-anchor="middle" fill="${fg}">${WORD[status]}</text>` +
		art +
		`<text x="72" y="136" font-size="20" font-family="Helvetica,sans-serif" font-weight="600" text-anchor="middle" fill="${fg}">${esc(clip(label, 14))}</text>` +
		`</svg>`
	);
}

export const toDataUri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

export function renderEmpty(): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" fill="#14101f"/></svg>`;
}

// 色つきの汎用タイル: 上に短い語、中央に絵文字、下にラベル
export const tile = (color: string, emoji: string, word: string, label: string) =>
	toDataUri(
		`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" fill="${color}"/>` +
			`<text x="72" y="30" font-size="24" font-family="Hiragino Sans,Helvetica,sans-serif" font-weight="800" text-anchor="middle" fill="#fff">${esc(word)}</text>` +
			`<text x="72" y="104" font-size="64" font-family="Apple Color Emoji" text-anchor="middle">${emoji}</text>` +
			`<text x="72" y="136" font-size="${label.length > 10 ? 15 : 20}" font-family="Hiragino Sans,Helvetica,sans-serif" font-weight="600" text-anchor="middle" fill="#fff">${esc(label)}</text></svg>`,
	);
