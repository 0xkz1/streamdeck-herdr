// Mac の画面消灯・睡眠中だけ抑制する。手動の消音設定とは別に保存する。
import { spawn } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const FILE = `${process.env.HOME}/.config/herdr-sleeping`;
export const isSleeping = () => existsSync(FILE);

export function startPowerWatch(onChange: (sleeping: boolean) => Promise<void>, warn: (message: string) => void) {
	if (process.platform !== "darwin") return;
	const child = spawn(`${process.env.HOME}/streamdeck-herdr/helper/HerdrPower/power-watch`, [], { stdio: ["pipe", "pipe", "ignore"] });
	let system = false, display = false;
	let previous: boolean | undefined;
	let pending = Promise.resolve();
	const lines = createInterface({ input: child.stdout });
	lines.on("line", (event) => {
		pending = pending.then(async () => {
			if (event === "system-sleep") system = true;
			else if (event === "system-wake") system = false;
			else if (event === "display-sleep") display = true;
			else if (event === "display-wake") display = false;
			else return;
			const sleeping = system || display;
			try {
				if (sleeping !== previous) {
					previous = sleeping;
					if (sleeping) writeFileSync(FILE, "sleep\n");
					else if (existsSync(FILE)) unlinkSync(FILE);
					await onChange(sleeping);
				}
			} finally {
				if (event === "system-sleep") child.stdin.write("ready\n");
			}
		}).catch((e) => warn(`power change failed: ${e}`));
	});
	child.stdin.on("error", (e) => warn(`power acknowledgement failed: ${e}`));
	child.on("error", (e) => warn(`power watcher failed: ${e}`));
	child.on("close", () => {
		lines.close();
		setTimeout(() => startPowerWatch(onChange, warn), 3000);
	});
}
