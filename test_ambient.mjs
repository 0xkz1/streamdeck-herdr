import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import { transformSync } from "esbuild";

const code = transformSync(readFileSync(new URL("./src/ambient.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs" }).code;
const copy = (v) => JSON.parse(JSON.stringify(v));
const warm = (bri) => ({ on: true, bri, colormode: "ct", ct: 420, hue: 8000, sat: 100 });

function fixture(initial = { 6: warm(102), 4: warm(51) }, disk) {
	let now = 1_000_000;
	const states = copy(initial), writes = [], timers = new Map();
	let readHook, writeHook;
	const files = new Map([
		["/test/.config/herdr-hue/ambient.json", JSON.stringify({ lights: ["6", "4"], pulse: true })],
		["/test/.config/herdr-hue/bridge.json", JSON.stringify([{ success: { username: "test" } }])],
	]);
	if (disk) files.set("/test/.config/herdr-hue/ambient-saved.json", disk);
	const fs = {
		readFileSync: (p) => { if (!files.has(p)) throw new Error("missing"); return files.get(p); },
		writeFileSync: (p, s) => files.set(p, s),
		existsSync: (p) => files.has(p),
		unlinkSync: (p) => files.delete(p),
		appendFileSync: () => {},
	};
	const child = {
		execFile: (_bin, args, cb) => {
			const url = args.find((a) => a.startsWith("https://"));
			const id = /\/lights\/(\d+)/.exec(url)[1];
			if (args.includes("PUT")) {
				const body = JSON.parse(args[args.indexOf("-d") + 1]);
				writes.push({ id, ...body });
				Object.assign(states[id], body);
				if (body.ct !== undefined) states[id].colormode = "ct";
				if (body.xy !== undefined) states[id].colormode = "xy";
				if (body.hue !== undefined) states[id].colormode = "hs";
				const failure = writeHook?.(id, body);
				queueMicrotask(() => cb(failure instanceof Error ? failure : null, typeof failure === "string" ? failure : failure ? "" : '[{"success":true}]'));
			} else {
				const snapshot = copy(states[id]);
				readHook?.(id, snapshot);
				queueMicrotask(() => cb(null, JSON.stringify({ state: snapshot })));
			}
		},
	};
	class Clock extends Date { static now() { return now; } }
	const module = { exports: {} };
	vm.runInNewContext(code, {
		module, exports: module.exports, Date: Clock,
		process: { env: { HOME: "/test" } },
		require: (name) => name === "node:fs" ? fs : name === "node:child_process" ? child : { isSleeping: () => false, isMuted: () => true, spawnSound: () => {} },
		setTimeout, setInterval: (fn) => { const id = Symbol(); timers.set(id, fn); return id; },
		clearInterval: (id) => timers.delete(id),
	});
	const api = module.exports;
	return {
		api, states, writes, files,
		onRead: (fn) => { readHook = fn; },
		onWrite: (fn) => { writeHook = fn; },
		advance: (ms = 2000) => { now += ms; },
		tick: (status) => api.ambientTick({ tabs: status ? [{ id: "a", agent: "codex", status }] : [] }),
		pulse: async () => { now += 2000; for (const fn of [...timers.values()]) await fn(); },
	};
}

test("working preserves each scene color and breathes at 50–100% without compounding", async () => {
	const f = fixture();
	await f.tick("working");
	assert.equal(f.states[6].bri, 102);
	assert.equal(f.states[4].bri, 51);
	assert.equal(f.states[6].ct, 420);
	assert.equal(f.states[6].colormode, "ct");
	await f.pulse();
	assert.equal(f.states[6].bri, 51);
	assert.equal(f.states[4].bri, 26);
	await f.pulse();
	assert.equal(f.states[6].bri, 102);
	assert.equal(f.states[4].bri, 51);
});

test("persistent brightness reports observed on real Hue lights never replace the full baseline", async () => {
	for (const [baseline, target, reported] of [[132, 66, 71], [129, 65, 68], [116, 58, 66], [66, 33, 40], [158, 158, 143], [22, 11, 14]]) {
		const f = fixture({ 6: warm(baseline), 4: warm(51) });
		await f.tick("working");
		if (target !== baseline) await f.pulse();
		assert.equal(f.states[6].bri, target);
		f.advance();
		f.onRead((id, snapshot) => { if (id === "6") snapshot.bri = reported; });
		await f.tick("working");
		assert.equal(JSON.parse(f.files.get("/test/.config/herdr-hue/ambient-saved.json")).saved[6].bri, baseline);
		await f.api.ambientSuspend(true);
		assert.equal(f.states[6].bri, baseline);
	}
});

test("a read started during a fade cannot lower the scene baseline after a delayed reply", async () => {
	const f = fixture();
	await f.tick("working");
	await f.pulse();
	// Read starts before the 1.2s fade ends; bridge reply arrives after its grace period.
	f.advance(1000);
	f.onRead((id, snapshot) => {
		if (id === "6") { snapshot.bri = 54; f.advance(400); }
	});
	await f.tick("working");
	f.onRead(undefined);
	const saved = JSON.parse(f.files.get("/test/.config/herdr-hue/ambient-saved.json")).saved;
	assert.equal(saved[6].bri, 102);
	await f.pulse();
	assert.equal(f.states[6].bri, 102);
});

test("a bridge still fading after the nominal deadline must settle before replacing the baseline", async () => {
	const f = fixture();
	await f.tick("working"); await f.pulse(); f.advance(1400);
	let reads = 0;
	f.onRead((id, snapshot) => { if (id === "6" && reads++ === 0) snapshot.bri = 65; });
	await f.tick("working");
	const saved = JSON.parse(f.files.get("/test/.config/herdr-hue/ambient-saved.json")).saved;
	assert.equal(saved[6].bri, 102);
	f.onRead(undefined); await f.pulse(); assert.equal(f.states[6].bri, 102);
});

test("several stale bridge replies during a pulse do not compound brightness", async () => {
	const f = fixture();
	await f.tick("working"); await f.pulse(); f.advance(1400);
	let reads = 0;
	f.onRead((id, snapshot) => { if (id === "6" && reads++ < 3) snapshot.bri = 65; });
	await f.tick("working");
	const saved = JSON.parse(f.files.get("/test/.config/herdr-hue/ambient-saved.json")).saved;
	assert.equal(saved[6].bri, 102);
	f.onRead(undefined); await f.pulse(); assert.equal(f.states[6].bri, 102);
});

test("a timed-out dim command cannot become the next scene baseline", async () => {
	const f = fixture();
	await f.tick("working");
	let once = true;
	f.onWrite((id) => { if (id === "6" && once) { once = false; return new Error("curl timeout after bridge accepted the command"); } });
	await f.pulse();
	assert.equal(f.states[6].bri, 51);
	f.advance();
	await f.tick("working");
	assert.equal(JSON.parse(f.files.get("/test/.config/herdr-hue/ambient-saved.json")).saved[6].bri, 102);
	await f.pulse();
	assert.equal(f.states[6].bri, 102);
});

test("an HTTP-success Hue error cannot turn a partly applied command into a scene", async () => {
	const f = fixture();
	await f.tick("working");
	let once = true;
	f.onWrite((id) => { if (id === "6" && once) { once = false; return '[{"error":{"type":901,"description":"bridge busy"}}]'; } });
	await f.pulse();
	assert.equal(JSON.parse(f.files.get("/test/.config/herdr-hue/ambient-saved.json")).pending[6].bri, 51);
	f.advance(); await f.tick("working"); await f.pulse();
	assert.equal(f.states[6].bri, 102);
});

test("restart and sleep restore the full scene after an unconfirmed dim command", async () => {
	for (const restart of [false, true]) {
		const f = fixture(); await f.tick("working");
		f.onWrite((id) => { if (id === "6") return new Error("timeout"); });
		await f.pulse();
		assert.equal(f.states[6].bri, 51);
		const disk = f.files.get("/test/.config/herdr-hue/ambient-saved.json");
		const target = restart ? fixture(f.states, disk) : f;
		target.onWrite(undefined);
		await target.api.ambientSuspend(true);
		assert.equal(target.states[6].bri, 102);
		assert.equal(target.states[4].bri, 51);
		assert.equal(target.files.has("/test/.config/herdr-hue/ambient-saved.json"), false);
	}
});

test("a failed sleep restore retains its baseline and retries after wake", async () => {
	for (const status of [undefined, "working"]) {
		const f = fixture(); await f.tick("working"); await f.pulse(); f.advance();
		f.onWrite((id, body) => {
			if (id === "6" && body.bri === 102) { f.states[6].bri = 51; return new Error("bridge unavailable during restore"); }
		});
		await f.api.ambientSuspend(true);
		assert.equal(f.states[6].bri, 51);
		assert.equal(JSON.parse(f.files.get("/test/.config/herdr-hue/ambient-saved.json")).saved[6].bri, 102);
		f.onWrite(undefined);
		await f.api.ambientSuspend(false); await f.tick(status);
		assert.equal(f.states[6].bri, 102);
	}
});

test("blocked and done use scene brightness, then restore the original scene", async () => {
	const f = fixture();
	await f.tick("blocked");
	assert.equal(f.states[6].hue, 50000);
	await f.pulse();
	assert.equal(f.states[6].bri, 10);
	assert.equal(f.states[4].bri, 5);
	f.advance();
	await f.tick("done");
	assert.equal(f.states[6].hue, 25500);
	assert.equal(f.states[6].bri, 102);
	f.advance(16_000);
	await f.tick("done");
	assert.equal(f.states[6].ct, 420);
	assert.equal(f.states[6].colormode, "ct");
	assert.equal(f.states[6].bri, 102);
});

test("five external scenes replace the baseline while working", async () => {
	const f = fixture();
	await f.tick("working");
	for (const bri of [160, 90, 60, 20, 2]) {
		Object.assign(f.states[6], warm(bri));
		Object.assign(f.states[4], { on: true, bri: Math.max(1, Math.round(bri / 2)), colormode: "xy", xy: [0.3, 0.4] });
		f.advance();
		await f.tick("working");
		await f.pulse();
		assert.equal(f.states[6].bri, Math.max(1, Math.round(bri / 2)));
		await f.pulse();
		assert.equal(f.states[6].bri, bri);
		assert.deepEqual(f.states[4].xy, [0.3, 0.4]);
	}
	f.advance();
	await f.tick();
	assert.equal(f.states[6].bri, 2);
	assert.equal(f.states[4].bri, 1);
});

test("explicit small brightness changes replace the baseline even within report tolerance", async () => {
	const f = fixture(); await f.tick("working");
	for (const bri of [101, 96, 92, 88, 84]) {
		await f.api.ambientUserChange(async () => { Object.assign(f.states[6], warm(bri)); });
		f.advance(); await f.tick("working");
		assert.equal(JSON.parse(f.files.get("/test/.config/herdr-hue/ambient-saved.json")).saved[6].bri, bri);
		await f.pulse(); assert.equal(f.states[6].bri, Math.round(bri / 2));
		await f.pulse(); assert.equal(f.states[6].bri, bri);
	}
});

test("scene switching pauses pulses and captures matching notification colors as real scenes", async () => {
	const f = fixture();
	await f.tick("blocked");
	await f.api.ambientUserChange(async () => {
		Object.assign(f.states[6], { on: true, bri: 30, colormode: "hs", hue: 50000, sat: 254 });
		Object.assign(f.states[4], warm(10));
	});
	await f.tick("blocked");
	assert.equal(f.states[6].bri, 30);
	f.advance();
	await f.tick("blocked");
	await f.pulse();
	assert.equal(f.states[6].bri, 3);
	f.advance();
	await f.tick();
	assert.equal(f.states[6].bri, 30);
	assert.equal(f.states[6].hue, 50000);
	assert.equal(f.states[4].ct, 420);
});

test("off lights stay off and manual power-off survives restoring", async () => {
	const f = fixture({ 6: warm(100), 4: { ...warm(50), on: false } });
	await f.tick("blocked");
	await f.pulse();
	assert.equal(f.states[4].on, false);
	f.states[6].on = false;
	f.advance();
	await f.tick();
	assert.equal(f.states[6].on, false);
	assert.equal(f.states[4].on, false);
});

test("color-only user changes start from the full baseline rather than a dim pulse", async () => {
	const f = fixture();
	await f.tick("working");
	await f.pulse();
	await f.api.ambientUserChange(async () => {
		assert.equal(f.states[6].bri, 102);
		Object.assign(f.states[6], { ct: 300 });
	});
	f.advance();
	await f.tick("working");
	await f.pulse();
	assert.equal(f.states[6].bri, 51);
	f.advance();
	await f.tick();
	assert.equal(f.states[6].bri, 102);
	assert.equal(f.states[6].ct, 300);
});

test("restart restores the scene from a low working pulse", async () => {
	const f = fixture();
	await f.tick("working");
	await f.pulse();
	const disk = f.files.get("/test/.config/herdr-hue/ambient-saved.json");
	const restarted = fixture(f.states, disk);
	await restarted.tick();
	assert.equal(restarted.states[6].bri, 102);
	assert.equal(restarted.states[4].bri, 51);
});

test("legacy saved states recover the old notification colors", async () => {
	const f = fixture({ 6: { ...warm(254), colormode: "hs", hue: 9000, sat: 254 }, 4: warm(51) }, JSON.stringify({ 6: warm(80) }));
	await f.tick();
	assert.equal(f.states[6].bri, 80);
	assert.equal(f.states[6].colormode, "ct");
});

test("GPU critical alert retains priority while respecting scene brightness", async () => {
	const f = fixture();
	f.api.setGpuTemp(85);
	await f.tick("blocked");
	assert.equal(f.states[6].hue, 0);
	assert.equal(f.states[6].bri, 102);
	await f.pulse();
	assert.equal(f.states[6].bri, 26);
	assert.equal(f.states[4].bri, 13);
});

test("sleep stops pulses and restores the scene; wake resumes from settings changed while asleep", async () => {
	const f = fixture();
	await f.tick("blocked");
	await f.pulse();
	await f.api.ambientSuspend(true);
	assert.equal(f.states[6].bri, 102);
	assert.equal(f.states[6].colormode, "ct");
	const count = f.writes.length;
	f.api.setGpuTemp(85);
	await f.tick("blocked");
	await f.pulse();
	assert.equal(f.writes.length, count);
	Object.assign(f.states[6], warm(30));
	Object.assign(f.states[4], { ...warm(10), on: false });
	f.api.setGpuTemp(60);
	await f.api.ambientSuspend(false);
	await f.tick("working");
	await f.pulse();
	assert.equal(f.states[6].bri, 15);
	assert.equal(f.states[4].on, false);
	f.advance();
	await f.tick();
	assert.equal(f.states[6].bri, 30);
});

test("sleep arriving during an in-flight pulse prevents a late notification write", async () => {
	const f = fixture();
	await f.tick("working");
	const pulse = f.pulse();
	const sleep = f.api.ambientSuspend(true);
	await Promise.all([pulse, sleep]);
	assert.equal(f.states[6].bri, 102);
	assert.equal(f.states[4].bri, 51);
	const count = f.writes.length;
	await f.tick("blocked");
	await f.pulse();
	assert.equal(f.writes.length, count);
});
