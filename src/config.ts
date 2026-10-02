import { readFileSync } from "node:fs";

// 環境依存の値は ~/.config/herdr-deck/config.json に置く(config.example.json を参照)
type Cfg = { sshHost: string; remoteHome: string; hueIp: string; whisperUrl: string };
const DEFAULTS: Cfg = {
	sshHost: "ubuntu-host",
	remoteHome: "/home/user",
	hueIp: "192.0.2.10",
	whisperUrl: "http://whisper-host:18866/v1/audio/transcriptions",
};
let user: Partial<Cfg> = {};
try { user = JSON.parse(readFileSync(`${process.env.HOME}/.config/herdr-deck/config.json`, "utf8")); } catch { /* 無ければ既定値 */ }
export const CONFIG: Cfg = { ...DEFAULTS, ...user };
