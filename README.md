# streamdeck-herdr

**A control room for AI coding agents — light is state, sound is event, voice is detail.**

[日本語](README.ja.md)

Four CLI agents (Claude Code, Codex, OpenCode, Hermes) run side by side in Herdr, a terminal multiplexer for agents, on a Linux box. This project turns a Mac with a Stream Deck, a few Hue bulbs and a microphone into their control room: you *see* what each agent is doing from the color of the room, *hear* when something happens, and *get told* the details only when you ask or when it matters.

> **This is a showcase, not a turnkey product.** It reflects one person's machines (Ubuntu + Mac + Stream Deck + Hue). Paths, hostnames and IPs are placeholders. Read it to see how it was designed; don't expect to run it unchanged.

Built 2026-10-01 → 10-03.

## The idea

Looking at four terminals to see who is waiting for you is exactly the kind of attention a control room should remove. Each channel gets one job:

| Channel | Carries | Why |
|---|---|---|
| **Light** | *State* — continuous, ambient | You can read a color in peripheral vision without stopping work |
| **Sound** | *Events* — something just changed | Short, quiet, never rhythmic (a beat feels like being hurried) |
| **Voice** | *Detail* — what is it and what should I do | Only on events, and only a summary of the screen |

| Agent state | Light (6 bulbs) | Sound | Voice |
|---|---|---|---|
| working | yellow, slow breathing | rolling grains (random material and timing) | — |
| blocked (needs you) | purple, fast pulse | `ask` — a two-note question | summarizes the screen aloud |
| done (> 30 s of work) | green for 15 s | `done` — a warm pad | same |
| done (> 20 min of work) | green | `big` — organ | same |
| neglected (blocked 90 s / long job done 60 s) | — | — | **Telegram message** (for when you are away) |

While a meeting is being recorded, all sounds stop (they would leak into the microphone).

## Architecture

![Architecture: agents report state to herdr; the Mac plugin turns that one feed into light, sound and voice.](docs/architecture.svg)

Why Herdr: it exposes every agent's state (`working / blocked / done / idle`) as JSON through one command, and the agents themselves report it via hooks — nothing is guessed from the screen. That is the foundation everything above stands on.

## What's in the box

- **Stream Deck plugin** (`src/`, `com.kz003.herdr.sdPlugin/`, TypeScript) — slots for spaces/tabs with live state, *Urgent* (jump to whoever needs you), *Brief* (spoken priority overview across all sessions), *Cmd* (send "continue / diff / test / commit", split panes, voice input, Hue presets, handoff between agents, cron triggers, usage meters).
- **Handoff** (`handoff.py`) — the current agent writes its own memo, a new tab starts a different agent with it. Short press flips direction, long press (0.7 s) executes.
- **Ambient light** (`src/ambient.ts`, `hue.py`, `hue_intent.py`) — state lights; plain-speech Hue control ("make it warmer").
- **Sound** (`make_sounds.py`, `src/sound.ts`, `src/thinking.ts`) — notification synthesis and the "thinking" grains.
- **Voice** (`priorities.py`, `narrate.py`, `tts.py`) — screen/priority summarization through an LLM gateway, spoken with a TTS model.
- **Mac helpers** (`helper/`, Swift) — `HerdrMic` (push-to-talk) and `HerdrScribe` (two-channel meeting transcription, then re-transcribed on a GPU Whisper with a summary).
- **Notifier** (`agent_notifier.py`) — neglect detection → Telegram.

## Added since the first version (2026-10-04 → 10-09)

Each item is something I asked for and the AI implemented. Where I haven't confirmed that it works, it says so.

- **Role layer.** `roles.json` maps a role (`builder`, `review-editor`, …) to an ordered list of agents; the first entry is the first choice. `handoff.py <pane> builder` starts that agent in a new tab named after the role, and writes a handoff memo in a fixed schema (from/to role, project, goal, done, decisions, open items, known problems, next step) to `~/handoffs/`. Role names follow my Hermes profile names; the role *definitions* stay owned by Hermes, so the role cards are not published here. The second and later choices are only documented, not tried automatically yet. Each role can have its own voice (`voices.example.json`, re-read on every utterance).
- **Handoff safety.** A failed start renames the tab `✗role` and stops with an error. The prompt is re-sent up to three times if the memo's file name never appears on screen. It will **not** type into a confirmation screen: on 2026-10-04 an automated handoff typed into Codex's hook-review screen and flipped hook trust settings (restored by hand). See `DESIGN.md`.
- **Usage-limit detection** (`limit_watch.py`, a systemd timer every 2 minutes). When a Claude or Codex pane stops on a usage-limit message, it is logged, one key lights up, and a press hands the work to the other agent. The stopped agent cannot write its own memo, so the memo is built from its conversation log. Handoff is a **press, not automatic**. Codex's message wording was checked against a real log; **Claude's wording is unconfirmed**. The "new stop" sound and light are not confirmed by ear.
- **Mute-everything key**, and the system goes quiet when the Mac's screen is off or asleep (a small native helper, `HerdrPower`).
- **Work sound says what the agent is doing.** `activity.py` reads Claude Code's screen to tell reading, writing, running, searching, web and thinking apart, and each gets different grains. It only works for Claude Code, and falls back to "thinking" when the screen text changes.
- **Model-tier start chime.** On the first message of a conversation, a short synthesized sound says which tier of model is running: rocket (high), airliner (mid), drone (low); `make_chimes.py`.
- **GPU heat alert**, top priority: red steady at 75 °C, red fast blink and an alarm at 83 °C.
- **Small extras:** a usage readout in Herdr's tab bar, two one-key prompts to the selected agent ("what are you doing?", "anything left undone?"), a background-music key using SoundCloud's official widget (set your own URL in `~/.config/herdr-music.json`), and a patrol script (`patrol.py`, preview by default) that can nudge idle sessions.
- **Also used, not part of this repo:** a few third-party Herdr plugins (tab auto-titling, automations, projects, watcher), and a third-party tool to reach the same Herdr session from a phone. Their setup is deliberately not described here.

## Who decided what (honest authorship)

Most of the code was written by an AI (Claude, via Claude Code) at my direction. The split:

**Decided by me** — the experience: that light/sound/voice should each own one role; which events deserve a sound and which only a light; the taste calls (no ticking clock because a beat hurries me; nothing "Zimmer-sized" for everyday notifications; quiet like *Her*); what to throw away; the hardware and the agent line-up.

**Left to the AI** — the implementation: the plugin, helpers, scripts, protocol glue, and most debugging. I tested on the real hardware and kept sending it back until it sounded right.

## Security notes

- `HerdrMic` (127.0.0.1:18867) and `HerdrScribe` (127.0.0.1:18868) accept **unauthenticated** HTTP and can **start a recording**. They bind to loopback only, which keeps other machines out but **not other local processes**. If you reuse this, add token authentication.
- Some pieces **type into live agent panes**: `handoff.py`, the two one-key prompts, and `patrol.py --apply`. Read them before enabling. `patrol.py` can optionally send terminal text to an external judging API (`jev.mode` in `patrol.json`); it is **off** in the shipped config.
- No secrets are in the repository. API keys are read at runtime from an env file named by `HERDR_ENV_FILE`; signing-keychain password via `HERDR_SIGN_PW`; environment values in `~/.config/herdr-deck/config.json` (see `config.example.json`).

## Credits & licenses

Code: [MIT](LICENSE) © Kazuki. Clock recordings used in an earlier sound design come from Wikimedia Commons (one is CC BY-SA 4.0, attribution required); see [`sounds/raw/LICENSES.md`](sounds/raw/LICENSES.md). No audio files are included. The sounds this repo can produce are all synthesized from scratch (`make_sounds.py` writes `sounds/*.wav`, about 110 MB in 6 s; needs numpy and scipy; `make_chimes.py` and `make_more_think_sounds.py` add the start chimes and extra grains). My own setup also uses a few third-party sound recordings (the optional clock, a whispered-voice pair, one game jingle). Those are **not included and not redistributed**, and the scripts that process them are left out.

## More

Pitfalls and the reasoning behind rejected ideas: [`DESIGN.md`](DESIGN.md).
