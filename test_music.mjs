import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { transformSync } from "esbuild";

const source = transformSync(readFileSync(new URL("./src/music.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs" }).code;
function fixture(initialPlaying = false) {
	let now = 1_000_000, sleeping = false, muted = false;
	const routes = [], files = new Map(), launches = [];
	let playing = initialPlaying, loading = false, fail = false, gate;
	const module = { exports: {} };
	vm.runInNewContext(source, {
		module, exports: module.exports, process: { env: { HOME: "/test" } }, Date: { now: () => now }, AbortSignal, setTimeout,
		require: (name) => ({
			"node:fs": { readFileSync: (p) => { if (!files.has(p)) throw Error("missing"); return files.get(p); }, writeFileSync: (p, text) => files.set(p, text) },
			"node:child_process": { execFile: (_cmd, args, cb) => { launches.push(args); cb(); } },
			"./power": { isSleeping: () => sleeping }, "./sound": { isMuted: () => muted },
		})[name],
		fetch: async (url) => {
			const route = new URL(url).pathname;
			if (gate) { const wait = gate; gate = undefined; await wait; }
			if (fail) throw Error("offline");
			routes.push(route);
			if (route === "/play") { playing = true; loading = false; }
			if (route === "/pause") { playing = false; loading = false; }
			return { json: async () => ({ playing, loading, track: playing ? "liked track" : "", error: "" }) };
		},
	});
	return { ...module.exports, routes, files, launches,
		advance: (ms) => { now += ms; }, sleep: (s) => { sleeping = s; }, mute: (s) => { muted = s; }, fail: (s) => { fail = s; },
		gate: (p) => { gate = p; },
	};
}

test("polling never starts playback automatically", async () => {
 const f = fixture();
 for (let i = 0; i < 20; i++) { await f.musicTick(); f.advance(30_000); }
 assert.ok(!f.routes.includes("/play"));
 assert.equal(f.launches.length, 0);
 assert.match(JSON.parse(f.files.get("/test/.config/herdr-music.json")).url, /\/likes$/);
});

test("restarting the plugin pauses an already running player until the button is pressed", async () => {
	const f = fixture(true);
	await f.musicTick();
	assert.equal(f.musicState().playing, false);
	assert.equal(f.launches.length, 0);
	await f.musicToggle();
	assert.equal(f.musicState().playing, true);
});

test("manual playback continues through idle time and manual pause stays paused", async () => {
	const f = fixture();
	await f.musicToggle(); f.advance(600_000); await f.musicTick();
	assert.equal(f.musicState().playing, true);
	await f.musicToggle(); await f.musicTick(); f.advance(60_000); await f.musicTick();
	assert.equal(f.musicState().playing, false);
	assert.equal(JSON.parse(f.files.get("/test/.config/herdr-music.json")).enabled, false);
});

test("sleep pauses music and wake resumes without changing the user's preference", async () => {
	const f = fixture();
	await f.musicToggle(); const cfg = f.files.get("/test/.config/herdr-music.json");
	f.sleep(true); await f.musicPause(); await f.musicTick();
	assert.equal(f.musicState().playing, false);
	f.sleep(false); await f.musicTick();
	assert.equal(f.musicState().playing, true);
	assert.equal(f.files.get("/test/.config/herdr-music.json"), cfg);
});

test("recording and global mute pause playback, and unmuting resumes", async () => {
	const f = fixture(); await f.musicToggle();
	await f.musicTick(true); assert.equal(f.musicState().playing, false);
	await f.musicTick(); assert.equal(f.musicState().playing, true);
	f.mute(true); await f.musicTick(); assert.equal(f.musicState().playing, false);
	f.mute(false); await f.musicTick(); assert.equal(f.musicState().playing, true);
});

test("sleep while connecting cancels the pending play request", async () => {
	const f = fixture(); let release;
	f.gate(new Promise((r) => { release = r; }));
	const pending = f.musicToggle();
	f.sleep(true); await f.musicPause(); release(); await pending;
	assert.ok(!f.routes.includes("/play")); assert.equal(f.musicState().playing, false);
});

test("network failures are contained and playback can recover", async () => {
	const f = fixture(); await f.musicToggle();
	f.fail(true); await f.musicTick(); assert.match(f.musicState().error, /offline/);
	f.fail(false); f.advance(30_000); await f.musicTick();
	assert.equal(f.musicState().playing, true); assert.equal(f.musicState().error, "");
});
