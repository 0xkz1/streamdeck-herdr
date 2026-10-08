import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import vm from "node:vm";
import { transformSync } from "esbuild";

const sources = Object.fromEntries(["power", "sound"].map((name) => [name, transformSync(readFileSync(new URL(`./src/${name}.ts`, import.meta.url), "utf8"), { loader: "ts", format: "cjs" }).code]));
const flush = () => new Promise(setImmediate);

function fixture(muted = false) {
	const files = new Map([["/test/.config/herdr-sound.json", JSON.stringify({ muted, tick: true })]]);
	const children = [], killedExternal = [];
	const cache = new Map();
	const fs = {
		existsSync: (p) => files.has(p),
		readFileSync: (p) => { if (!files.has(p)) throw new Error("missing"); return files.get(p); },
		writeFileSync: (p, s) => files.set(p, s),
		unlinkSync: (p) => files.delete(p),
	};
	const spawn = (command) => {
		const child = new EventEmitter();
		child.command = command;
		child.stdout = new PassThrough();
		child.stdin = new PassThrough();
		child.killed = false;
		child.kill = () => { child.killed = true; child.emit("close"); };
		children.push(child);
		return child;
	};
	function load(name) {
		if (cache.has(name)) return cache.get(name);
		const module = { exports: {} };
		vm.runInNewContext(sources[name], {
			module, exports: module.exports, process: { env: { HOME: "/test" }, platform: "darwin" }, setTimeout,
			require: (name) => name === "node:fs" ? fs : name === "node:child_process" ? { spawn, execFile: (_cmd, args, done) => { killedExternal.push(args); done(); } } : name === "node:readline" ? { createInterface } : load(name.slice(2)),
		});
		cache.set(name, module.exports);
		return module.exports;
	}
	const power = load("power"), sound = load("sound");
	const changes = [], warnings = [];
	let hook = async () => {};
	power.startPowerWatch(async (sleeping) => {
		changes.push(sleeping);
		if (sleeping) sound.stopSounds();
		await hook(sleeping);
	}, (s) => warnings.push(s));
	const watcher = children[0];
	let replies = "";
	watcher.stdin.on("data", (chunk) => { replies += chunk; });
	return {
		power, sound, files, children, changes, warnings, killedExternal,
		replies: () => replies,
		hook: (fn) => { hook = fn; },
		event: async (s) => { watcher.stdout.write(s + "\n"); await flush(); },
	};
}

test("display sleep kills playing sounds and blocks new audio without altering manual preferences", async () => {
	const f = fixture();
	await f.event("display-wake");
	const voice = f.sound.spawnSound("/usr/bin/afplay", ["voice.wav"]);
	f.sound.tick(true);
	const clock = f.children.at(-1);
	const preferences = f.files.get("/test/.config/herdr-sound.json");
	await f.event("display-sleep");
	assert.equal(voice.killed, true);
	assert.equal(clock.killed, true);
	assert.equal(f.sound.spawnSound("/usr/bin/afplay", []), undefined);
	assert.equal(f.sound.isMuted(), true);
	assert.equal(f.files.get("/test/.config/herdr-sound.json"), preferences);
	assert.ok(f.killedExternal[0][1].includes("/test/streamdeck-herdr/sounds/chime-"));
	await f.event("display-wake");
	assert.equal(f.sound.isMuted(), false);
	assert.ok(f.sound.spawnSound("/usr/bin/afplay", []));
});

test("network wake leaves audio paused until the display wakes", async () => {
	const f = fixture();
	await f.event("display-sleep");
	await f.event("system-sleep");
	assert.equal(f.replies(), "ready\n");
	await f.event("system-wake");
	assert.equal(f.power.isSleeping(), true);
	assert.deepEqual(f.changes, [true]);
	await f.event("display-wake");
	assert.equal(f.power.isSleeping(), false);
	assert.deepEqual(f.changes, [true, false]);
});

test("sleep acknowledgement waits for Hue restoration and acknowledges failures too", async () => {
	const f = fixture();
	let release;
	f.hook(() => new Promise((resolve) => { release = resolve; }));
	await f.event("system-sleep");
	assert.equal(f.sound.isMuted(), true);
	assert.equal(f.replies(), "");
	release();
	await flush();
	assert.equal(f.replies(), "ready\n");
	const broken = fixture();
	broken.hook(async () => { throw new Error("bridge offline"); });
	await broken.event("system-sleep");
	assert.equal(broken.replies(), "ready\n");
	assert.equal(broken.warnings.length, 1);
});

test("wake clears an old sleep marker and preserves a user's mute setting", async () => {
	const f = fixture(true);
	f.files.set("/test/.config/herdr-sleeping", "sleep\n");
	await f.event("display-wake");
	assert.equal(f.power.isSleeping(), false);
	assert.equal(f.sound.isMuted(), true);
	await f.event("display-sleep");
	f.sound.toggleMute();
	assert.equal(f.sound.isMuted(), true);
	await f.event("display-wake");
	assert.equal(f.sound.isMuted(), false);
});
