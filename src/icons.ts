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

// 複数の作業カードを優先順に前へ送る。tile の SVG 描画を使う。
export const PATROL_SVG =
	`<g stroke-linecap="round" stroke-linejoin="round"><path d="M77 51h5q10 0 10 12v24q0 12-10 12h-5M77 75h15" fill="none" stroke="#9ce8d5" stroke-width="3"/><rect x="21" y="41" width="56" height="20" rx="6" fill="#214f58" stroke="#f8ce76" stroke-width="2.5"/><rect x="21" y="65" width="56" height="20" rx="6" fill="#214f58" stroke="#c7f5eb" stroke-width="2.5"/><rect x="21" y="89" width="56" height="20" rx="6" fill="#214f58" stroke="#9ce8d5" stroke-width="2.5"/><circle cx="32" cy="51" r="3.5" fill="#f8ce76"/><circle cx="32" cy="75" r="3.5" fill="#c7f5eb"/><circle cx="32" cy="99" r="3.5" fill="#9ce8d5"/><path d="M43 51h22M43 75h22M43 99h22" stroke="#e5fff8" stroke-width="3"/><path d="M92 75h30m-11-12 12 12-12 12" fill="none" stroke="#f8ce76" stroke-width="6"/></g>`;

// グラボ(横から見た絵)。Unicode にグラボの絵文字が無いので自作。tile の emoji 欄に "<" で始まる SVG を渡すとそのまま描く
export const GPU_SVG =
	`<g transform="translate(72 74) scale(1.25) translate(-72 -70)"><rect x="30" y="48" width="5" height="46" rx="1" fill="#fff"/><rect x="35" y="52" width="76" height="34" rx="4" fill="#1f1f2b" stroke="#fff" stroke-width="2.5"/><g transform="translate(55 69)"><circle r="13" fill="#2b2b3a" stroke="#fff" stroke-width="2"/><g stroke="#fff" stroke-width="2.5" stroke-linecap="round"><line x1="-9" y1="0" x2="9" y2="0"/><line x1="-4.5" y1="-7.8" x2="4.5" y2="7.8"/><line x1="-4.5" y1="7.8" x2="4.5" y2="-7.8"/></g><circle r="3" fill="#fff"/></g><g transform="translate(90 69)"><circle r="13" fill="#2b2b3a" stroke="#fff" stroke-width="2"/><g stroke="#fff" stroke-width="2.5" stroke-linecap="round"><line x1="-9" y1="0" x2="9" y2="0"/><line x1="-4.5" y1="-7.8" x2="4.5" y2="7.8"/><line x1="-4.5" y1="7.8" x2="4.5" y2="-7.8"/></g><circle r="3" fill="#fff"/></g><rect x="46" y="86" width="40" height="6" fill="#e0b030"/><rect x="88" y="47" width="16" height="5" rx="1" fill="#fff"/></g>`;

// CPU チップ(正面)。GPU_SVG と同じく tile の emoji 欄に渡す
export const CPU_SVG =
	`<g transform="translate(72 74) scale(1.25) translate(-72 -70)"><rect x="54" y="46" width="3" height="8" fill="#fff"/><rect x="54" y="90" width="3" height="8" fill="#fff"/><rect x="64" y="46" width="3" height="8" fill="#fff"/><rect x="64" y="90" width="3" height="8" fill="#fff"/><rect x="74" y="46" width="3" height="8" fill="#fff"/><rect x="74" y="90" width="3" height="8" fill="#fff"/><rect x="84" y="46" width="3" height="8" fill="#fff"/><rect x="84" y="90" width="3" height="8" fill="#fff"/><rect x="46" y="58" width="8" height="3" fill="#fff"/><rect x="90" y="58" width="8" height="3" fill="#fff"/><rect x="46" y="68" width="8" height="3" fill="#fff"/><rect x="90" y="68" width="8" height="3" fill="#fff"/><rect x="46" y="78" width="8" height="3" fill="#fff"/><rect x="90" y="78" width="8" height="3" fill="#fff"/><rect x="46" y="88" width="8" height="3" fill="#fff"/><rect x="90" y="88" width="8" height="3" fill="#fff"/><rect x="52" y="52" width="40" height="40" rx="4" fill="#1f1f2b" stroke="#fff" stroke-width="2.5"/><rect x="60" y="60" width="24" height="24" rx="2" fill="none" stroke="#fff" stroke-width="2"/><circle cx="72" cy="72" r="4" fill="#fff"/></g>`;

// メモリ・SSD(自作。GPU_SVG と同じ使い方)
export const RAM_SVG =
	`<g transform="translate(72 74) scale(1.25) translate(-72 -70)"><rect x="30" y="54" width="84" height="30" rx="3" fill="#1f1f2b" stroke="#fff" stroke-width="2.5"/><rect x="38" y="60" width="14" height="14" rx="2" fill="#fff"/><rect x="56" y="60" width="14" height="14" rx="2" fill="#fff"/><rect x="74" y="60" width="14" height="14" rx="2" fill="#fff"/><rect x="92" y="60" width="14" height="14" rx="2" fill="#fff"/><rect x="34" y="84" width="3" height="7" fill="#e0b030"/><rect x="40" y="84" width="3" height="7" fill="#e0b030"/><rect x="46" y="84" width="3" height="7" fill="#e0b030"/><rect x="52" y="84" width="3" height="7" fill="#e0b030"/><rect x="58" y="84" width="3" height="7" fill="#e0b030"/><rect x="64" y="84" width="3" height="7" fill="#e0b030"/><rect x="70" y="84" width="3" height="7" fill="#e0b030"/><rect x="76" y="84" width="3" height="7" fill="#e0b030"/><rect x="82" y="84" width="3" height="7" fill="#e0b030"/><rect x="88" y="84" width="3" height="7" fill="#e0b030"/><rect x="94" y="84" width="3" height="7" fill="#e0b030"/><rect x="100" y="84" width="3" height="7" fill="#e0b030"/><rect x="106" y="84" width="3" height="7" fill="#e0b030"/></g>`;
export const SSD_SVG =
	`<g transform="translate(72 74) scale(1.25) translate(-72 -70)"><rect x="28" y="56" width="88" height="26" rx="13" fill="#1f1f2b" stroke="#fff" stroke-width="2.5"/><rect x="44" y="62" width="16" height="14" rx="2" fill="#fff"/><rect x="66" y="62" width="16" height="14" rx="2" fill="#fff"/><circle cx="104" cy="69" r="4" fill="#e0b030"/></g>`;
