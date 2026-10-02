// エージェントの目印は頭文字の図形(他社ロゴは使わない)。agent 名 → data URI
const badge = (letter: string, fill: string) =>
	"data:image/svg+xml;utf8," +
	encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="22" fill="${fill}"/>` +
			`<text x="48" y="66" font-size="56" font-family="Helvetica,sans-serif" font-weight="700" text-anchor="middle" fill="#fff">${letter}</text></svg>`,
	);

export const ICONS: Record<string, string> = {
	claude: badge("C", "#b5651d"),
	codex: badge("X", "#2f6f5e"),
	hermes: badge("H", "#5b4b8a"),
	opencode: badge("O", "#3a3a3a"),
};
