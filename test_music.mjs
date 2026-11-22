import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { transformSync } from "esbuild";

const source = transformSync(readFileSync(new URL("./src/music.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs" }).code;
function fixture(initialPlaying = false, config) {
	let now = 1_000_000, sleeping = false, muted = false;
	const routes = [], files = new Map(), launches = [];
	if (config) files.set("/test/.config/herdr-music.json", JSON.stringify({ enabled: true, ...config }));
	let playing = initialPlaying, loading = false, fail = false, gate, rating = 0, subRating = "", category = "all", ratingFilter = "all", responseError = "";
	let trackUrl = "https://soundcloud.com/test/liked-track";
	const module = { exports: {} };
	vm.runInNewContext(source, {
		module, exports: module.exports, process: { env: { HOME: "/test" } }, Date: class extends Date { static now() { return now; } }, AbortSignal, setTimeout,
		require: (name) => ({
			"node:fs": { readFileSync: (p) => { if (!files.has(p)) throw Error("missing"); return files.get(p); }, writeFileSync: (p, text) => files.set(p, text) },
			"node:child_process": { execFile: (_cmd, args, cb) => { launches.push(args); cb(); } },
			"./power": { isSleeping: () => sleeping }, "./sound": { isMuted: () => muted },
		})[name],
		fetch: async (url, options) => {
			const u = new URL(url);
			const route = u.pathname;
			const fullRoute = u.pathname + u.search;
			if (gate) { const wait = gate; gate = undefined; await wait; }
			if (fail) throw Error("offline");
			routes.push(fullRoute);
			if (route === "/play") { playing = true; loading = false; category = u.searchParams.get("category") || "all"; ratingFilter = u.searchParams.get("rating") || "all"; }
			if (route === "/pause") { playing = false; loading = false; }
			if (route === "/rate") {
				assert.equal(options.method, "POST");
				assert.equal(u.searchParams.get("url"), trackUrl);
				if (!responseError) { rating = Number(u.searchParams.get("value")); if (u.searchParams.has("sub")) subRating = u.searchParams.get("sub"); }
			}
			return { json: async () => ({ playing, loading, category, ratingFilter, rating, subRating, url: trackUrl, track: playing ? "liked track" : "", error: responseError }) };
		},
	});
	return { ...module.exports, routes, files, launches,
		advance: (ms) => { now += ms; }, sleep: (s) => { sleeping = s; }, mute: (s) => { muted = s; }, fail: (s) => { fail = s; },
		gate: (p) => { gate = p; },
		setTime: (time) => { now = time; },
		responseError: (s) => { responseError = s; }, trackUrl: (s) => { trackUrl = s; }, playerRating: (r, sub = "") => { rating = r; subRating = sub; },
	};
}

test("polling never starts playback automatically", async () => {
 const f = fixture();
 for (let i = 0; i < 20; i++) { await f.musicTick(); f.advance(30_000); }
 assert.ok(!f.routes.includes("/play"));
 assert.equal(f.launches.length, 0);
 assert.match(JSON.parse(f.files.get("/test/.config/herdr-music.json")).url, /\/likes$/);
});

test("five-star cycling uses the freshly fetched track state", async () => {
	const f = fixture(); await f.musicToggle();
	// Cached state belongs to the previous track, which had no stars.
	f.trackUrl("https://soundcloud.com/test/next-track"); f.playerRating(5, "");
	for (const expected of ["S", "A", "B", "C", "D", "S"]) {
		await f.musicRate(5, undefined, true);
		assert.equal(f.musicState().subRating, expected);
		assert.match(f.routes.at(-1), new RegExp(`&sub=${expected}$`));
	}
	// A new, unrated track must get five stars without inheriting a sub-rating.
	f.trackUrl("https://soundcloud.com/test/unrated-track"); f.playerRating(0);
	await f.musicRate(5, undefined, true);
	assert.doesNotMatch(f.routes.at(-1), /&sub=/);
});

const hour = (h, minute = 0, second = 0) => new Date(2026, 9, 18, h, minute, second).getTime();
const scheduled = (minute = 0) => ({ autoStart: { enabled: true, minute } });
const playRequests = f => f.routes.filter(r => r.startsWith("/play"));

test("hourly auto-start begins all-track shuffle at the configured minute, once per slot", async () => {
	const f = fixture(false, scheduled(15));
	f.setTime(hour(10, 14, 59)); await f.musicTick();
	assert.equal(playRequests(f).length, 0);
	f.advance(2000); await f.musicTick();
	assert.equal(f.musicState().playing, true);
	assert.equal(playRequests(f).length, 1);
	assert.equal(playRequests(f)[0], "/play?category=all&rating=all");
	for (let n = 0; n < 10; n++) { f.advance(1200); await f.musicTick(); }
	assert.equal(playRequests(f).length, 1);
	assert.equal(JSON.parse(f.files.get("/test/.config/herdr-music.json")).lastAutoStartSlot, hour(10, 15));
});

test("manual pause holds until the next scheduled hour", async () => {
	const f = fixture(false, scheduled());
	f.setTime(hour(10)); await f.musicTick();
	await f.musicToggle();
	f.advance(5000); await f.musicTick();
	assert.equal(f.musicState().playing, false);
	f.setTime(hour(10, 59)); await f.musicTick();
	assert.equal(f.musicState().playing, false);
	f.setTime(hour(11)); await f.musicTick();
	assert.equal(f.musicState().playing, true);
	assert.equal(playRequests(f).length, 2);
});

test("a manual pause at the scheduled minute wins even before the scheduled tick", async () => {
	const f = fixture(false, scheduled());
	f.setTime(hour(9, 59)); await f.musicToggle();
	f.setTime(hour(10)); await f.musicToggle();
	await f.musicTick();
	assert.equal(f.musicState().playing, false);
	assert.equal(playRequests(f).length, 1);
});

test("mute, sleep and recording skip the slot without a delayed start", async () => {
	for (const reason of ["mute", "sleep", "recording"]) {
		const f = fixture(false, scheduled());
		if (reason === "mute") f.mute(true);
		if (reason === "sleep") f.sleep(true);
		f.setTime(hour(10)); await f.musicTick(reason === "recording");
		assert.equal(playRequests(f).length, 0, reason);
		f.mute(false); f.sleep(false); f.advance(10000); await f.musicTick();
		assert.equal(playRequests(f).length, 0, reason);
		f.setTime(hour(11)); await f.musicTick();
		assert.equal(f.musicState().playing, true, reason);
	}
});

test("scheduled ticks and plugin restarts preserve an already playing track and filters", async () => {
	const f = fixture(false, scheduled());
	f.setTime(hour(9, 59)); await f.musicToggle("chill", "4+");
	f.setTime(hour(10)); await f.musicTick();
	assert.equal(playRequests(f).length, 1);
	assert.equal(f.musicState().category, "chill");
	assert.equal(f.musicState().ratingFilter, "4+");
	const restarted = fixture(true, scheduled());
	restarted.setTime(hour(10, 5)); await restarted.musicTick();
	assert.equal(restarted.musicState().playing, true);
	assert(!restarted.routes.includes("/pause"));
	assert.equal(playRequests(restarted).length, 0);
});

test("sleep or recording while an automatic start is connecting cancels the slot", async () => {
	for (const reason of ["sleep", "recording"]) {
		const f = fixture(false, scheduled());
		f.setTime(hour(9, 59)); await f.musicTick();
		let release; f.gate(new Promise(r => { release = r; }));
		f.setTime(hour(10)); const pending = f.musicTick();
		if (reason === "sleep") f.sleep(true);
		else await f.musicTick(true);
		release(); await pending;
		f.sleep(false); f.advance(5000); await f.musicTick();
		assert.equal(playRequests(f).length, 0, reason);
	}
});

test("an adopted playing session resumes after a quiet startup check", async () => {
	const f = fixture(true, scheduled());
	f.setTime(hour(10, 5)); await f.musicTick(true);
	assert.equal(f.musicState().playing, false);
	await f.musicTick();
	assert.equal(f.musicState().playing, true);
});

test("a saved schedule slot prevents duplicate starts after a restart", async () => {
	const f = fixture(false, { ...scheduled(), enabled: false, lastAutoStartSlot: hour(10) });
	f.setTime(hour(10, 0, 20)); await f.musicTick();
	assert.equal(playRequests(f).length, 0);
	f.setTime(hour(11)); await f.musicTick();
	assert.equal(playRequests(f).length, 1);
});

test("missed slots, disabled schedules and invalid minutes never start playback", async () => {
	for (const config of [scheduled(), { autoStart: { enabled: false, minute: 0 } }, scheduled(-1), scheduled(60), scheduled(1.5), scheduled("0")]) {
		const f = fixture(false, config);
		f.setTime(hour(10, 5)); await f.musicTick();
		assert.equal(playRequests(f).length, 0);
		if (config.autoStart.minute !== 0 || !config.autoStart.enabled) {
			f.setTime(hour(11)); await f.musicTick();
			assert.equal(playRequests(f).length, 0);
		}
	}
});

test("ratings use the current player URL, overwrite and clear without changing playback", async () => {
	const f = fixture(); await f.musicToggle();
	f.trackUrl("https://soundcloud.com/test/new-track");
	await f.musicRate(4); assert.equal(f.musicState().rating, 4);
	await f.musicRate(2); assert.equal(f.musicState().rating, 2);
	await f.musicRate(0); assert.equal(f.musicState().rating, 0);
	assert.equal(f.musicState().playing, true);
	await assert.rejects(f.musicRate(6), /評価/);
	await assert.rejects(f.musicRate(1.5), /評価/);
	f.responseError("保存できません");
	await assert.rejects(f.musicRate(5), /保存できません/);
});

test("rating filters intersect the category and survive mute and resume", async () => {
	const f = fixture(); await f.musicToggle("chill", "4+");
	assert.equal(f.musicState().ratingFilter, "4+");
	assert.ok(f.routes.includes("/play?category=chill&rating=4%2B"));
	f.mute(true); await f.musicTick();
	f.mute(false); await f.musicTick();
	assert.equal(f.musicState().ratingFilter, "4+");
	assert.equal(f.musicState().category, "chill");
	await f.musicToggle("chill", "all");
	assert.equal(f.musicState().playing, true);
	assert.equal(f.musicState().ratingFilter, "all");
});

test("empty rating filters report failure and do not retry playback automatically", async () => {
	const f = fixture(); f.responseError("該当する曲はありません");
	await assert.rejects(f.musicToggle("all", "5"), /該当/);
	f.responseError("");
	const before = f.routes.filter(r => r.startsWith("/play")).length;
	f.advance(60000); await f.musicTick();
	assert.equal(f.routes.filter(r => r.startsWith("/play")).length, before);
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

test("category playback, switching and toggling pause", async () => {
	const f = fixture();
	// 長尺BGMを開始
	await f.musicToggle("long");
	assert.equal(f.musicState().playing, true);
	assert.equal(f.musicState().category, "long");
	assert.ok(f.routes.some((r) => r.includes("/play?category=long")));

	// チルに切り替え (再生は継続したままカテゴリ切替)
	await f.musicToggle("chill");
	assert.equal(f.musicState().playing, true);
	assert.equal(f.musicState().category, "chill");
	assert.ok(f.routes.some((r) => r.includes("/play?category=chill")));

	// 同じチルを再度押すと一時停止
	await f.musicToggle("chill");
	assert.equal(f.musicState().playing, false);
});

test("musicNext skips to next track", async () => {
	const f = fixture();
	await f.musicToggle();
	await f.musicNext();
	assert.ok(f.routes.some((r) => r.startsWith("/next")));
});

test("musicPrev returns to previous track", async () => {
	const f = fixture();
	await f.musicToggle();
	await f.musicPrev();
	assert.ok(f.routes.some((r) => r.startsWith("/prev")));
});

test("duckProcess triggers /duck on start and /duck/stop on exit", async () => {
	const f = fixture();
	await f.musicToggle();
	const child = new EventEmitter();
	f.duckProcess(child);
	await new Promise((r) => setImmediate(r));
	assert.ok(f.routes.some((r) => r.startsWith("/duck")));

	child.emit("close");
	await new Promise((r) => setImmediate(r));
	assert.ok(f.routes.includes("/duck/stop"));
});

test("musicDuck with duration passes duration parameter", async () => {
	const f = fixture();
	await f.musicToggle();
	await f.musicDuck(2.5);
	assert.ok(f.routes.includes("/duck?duration=2.5"));
});

test("musicToggleTag adds and removes tags and reloads catalog", async () => {
	const f = fixture(true);
	const initialCatalog = {
		tracks: [{ url: "https://soundcloud.com/test/liked-track", title: "liked track", categories: ["all"], tags: [] }]
	};
	f.files.set("/test/.config/herdr-music-catalog.json", JSON.stringify(initialCatalog));

	// 1. Add piano tag
	await f.musicToggleTag("piano");
	assert.ok(f.routes.includes("/reload"));
	const updated1 = JSON.parse(f.files.get("/test/.config/herdr-music-catalog.json"));
	assert.deepEqual(updated1.tracks[0].categories, ["all", "piano"]);
	const userTags1 = JSON.parse(f.files.get("/test/.config/herdr-music-user-tags.json"));
	assert.deepEqual(userTags1["https://soundcloud.com/test/liked-track"], ["piano"]);
	assert.deepEqual(JSON.parse(JSON.stringify(f.currentTrackTags())), ["all", "piano"]);

	// 1b. Add latin and witcher tags
	await f.musicToggleTag("latin");
	await f.musicToggleTag("witcher");
	const updated1b = JSON.parse(f.files.get("/test/.config/herdr-music-catalog.json"));
	assert.ok(updated1b.tracks[0].categories.includes("latin"));
	assert.ok(updated1b.tracks[0].categories.includes("witcher"));

	// 2. Add guitar tag (should also add guitar-strings)
	await f.musicToggleTag("guitar");
	const updated2 = JSON.parse(f.files.get("/test/.config/herdr-music-catalog.json"));
	assert.ok(updated2.tracks[0].categories.includes("guitar"));
	assert.ok(updated2.tracks[0].categories.includes("guitar-strings"));

	// 3. Toggle off piano tag
	await f.musicToggleTag("piano");
	const updated3 = JSON.parse(f.files.get("/test/.config/herdr-music-catalog.json"));
	assert.ok(!updated3.tracks[0].categories.includes("piano"));
	assert.ok(updated3.tracks[0].categories.includes("guitar"));

	// 4. Clear all instrument tags
	await f.musicClearTags();
	const updated4 = JSON.parse(f.files.get("/test/.config/herdr-music-catalog.json"));
	assert.deepEqual(updated4.tracks[0].categories, ["all"]);
	const userTags4 = JSON.parse(f.files.get("/test/.config/herdr-music-user-tags.json") || "{}");
	assert.equal(userTags4["https://soundcloud.com/test/liked-track"], undefined);
});




