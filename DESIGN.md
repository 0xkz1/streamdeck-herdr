# Design notes

[日本語](DESIGN.ja.md) · back to [README](README.md)

What was tried, what was thrown away, and why. Written from the working notes of the three days this was built (2026-10-01 → 10-03). Taste calls are mine; the reasoning behind them is recorded as I gave it.

## 1. One job per channel

The whole design is a division of labor, decided before any code:

- **Light** carries *state*. Continuous, readable in peripheral vision.
- **Sound** carries *events*. Short, quiet, only when something changes.
- **Voice** carries *detail*. Only on events, and only a summary of what is on the screen.

Everything below follows from it. When a new idea didn't fit one of the three roles, it was dropped rather than bent to fit.

## 2. Why Herdr, not Orca

The choice came down to one question: can something *outside* the agents ask each one "are you working, blocked, or done?"

- **Herdr** answers it in one command: `herdr api snapshot` returns spaces, tabs and every agent's `agent_status` as JSON. Claude Code, Codex, OpenCode and Hermes all report through hooks, so it is the agent saying so, not a guess from the screen. Pane/tab/agent operations are plain commands and work over SSH, which suits a home base on a remote machine.
- **Orca** (a GUI desktop app built around git worktrees): its CLI exists, but in the shallow look I took, I found no way to read each agent's working/blocked state. That is "not found", not "cannot": I only read the CLI help. It is also a desktop app on the Mac, while my agents live on the Ubuntu box.

Caveat on sources: the side-by-side comparison of the two tools is a third-party summary I did not verify. Only what I ran myself (the Herdr snapshot, the hooks, the commands over SSH) is verified.

Also: Claude Code's terminal version has "finished" / "waiting for permission" hooks, so Claude alone could be wired up without Herdr. Herdr's value is giving all four agents one identical shape.

## 3. The sound of "thinking"

The longest back-and-forth. Order of events:

1. **Synthesized clock ticks** → rejected. Pure synthesis, sine waves in particular, sounded like water drops, or like a hit, not a clock.
2. **Real recordings** (Wikimedia Commons) → the clock now sounded like a clock. The sound problem was solved.
3. **But a clock is the wrong idea for "working".** A steady beat makes me feel hurried: the agent is working, and the sound says *hurry up*. Clock sound is still in the code, off by default.
4. **Rolling grains** → kept. Small things rolling, with randomized material (seven source sounds) and randomized intervals. No beat to lock onto, so nothing to be hurried by. Made by `make_sounds.py` along with all other sounds.

Rule that came out of it: **no rhythmic sounds**. Rhythm in a sound about waiting turns waiting into pressure.

## 4. Scale of the notification sounds

- **Zimmer-style cues (huge brass, sub-bass hits)** → removed from everyday notifications. They are *too big*: they suit the moment a vast system is completed, not an agent finishing a task.
- **Quiet like *Her*** → the direction I wanted instead: soft pads and piano, a warm `done`.
- The one place big is allowed: `big`, the organ, for work that ran **over 20 minutes**. Size of sound tracks size of effort.
- `ask` is a two-note, question-shaped cue: it should sound like asking, without words.

## 5. Light behavior

- A **blink is a brightness change, never power on/off**, and updates go out at most about once a second per bulb. That keeps within what the bulbs and bridge handle well.
- **Done = green for 15 seconds**, then back. The agent's "done" state stays until someone looks at it, and my first version re-lit green again right after fading, mistaking the old "done" for a new one. It now remembers which done it already announced.
- **Don't fight the human.** If I change a color while the plugin is mid-fade, it does not restore over my change.
- **Gaming-desk lights (Entertainment group) are excluded.** During a Hue Sync stream, REST commands can conflict with it.

## 6. Voice

- It speaks **only a summary of the screen**, and only on events (blocked / done) or when I press *Brief*.
- Style: plain, no honorifics, male, taciturn. TTS is a Gemini model with a fixed voice. If the preferred model fails, it falls back to a newer one and the voice changes slightly. I kept that: a changed voice is a free "the primary failed" signal.
- *Brief* gives one prioritized overview across all sessions, in the voice of a partner, not a report.

## 7. Away from the desk

If I'm not there, light and sound are useless. A blocked agent left **90 seconds**, or a long job finished and left **60 seconds**, sends a Telegram message.

During a **meeting recording**, every sound stops: they would be picked up by the microphone.

## 8. Handoff between agents

When one agent is stuck or the wrong tool, the work moves to another: the **original agent writes its own memo**, a new tab starts a different agent with that memo. It needs nothing but Herdr's CLI. On the Deck, **short press flips the direction, long press (0.7 s) executes**. The long press also keeps a handoff from firing by accident.

## 9. Things considered and shelved

- **Session watchdog** (a Hermes job): paused. Almost no targets, and each run cost about 180k tokens.
- **Speaker separation** for multi-person meetings: not done.
- **Per-project notification destinations**: not done.
- Several sound ideas beyond the above (more "thinking" repertoire): open.

## 10. Pitfalls, with causes

| # | Symptom | Cause | Fix |
|---|---|---|---|
| 1 | Voice input records silence, Whisper "hallucinates" a stock phrase (a YouTube-style sign-off) | The Stream Deck app is hardened-runtime without the audio-input entitlement: no permission prompt ever appears | A separate small app (`HerdrMic`) that holds the permission records for it. A hallucinated sign-off is the tell-tale of empty audio |
| 2 | Mic / screen-recording permission vanishes after every rebuild of a helper app | Ad-hoc code signing makes each build a "different" app | Sign with a fixed local certificate and pin the designated requirement to *identifier + certificate fingerprint*. If a stale grant remains: `tccutil reset`, launch, grant, relaunch |
| 3 | `streamdeck restart` does nothing | — | Kill the plugin process; the host restarts it. Manifest `Software.MinimumVersion` must be 7.1+ or it crashes at once and is marked unstable |
| 4 | Hue never returns to the "original" color | Plugin died while a color was set; next start remembered *that* as the original | Save the original to disk, restore on start, and if the saved value looks like one of our colors treat it as neutral. (Hue 12750 is yellow-green; yellow is 9000-10900) |
| 5 | Green fires again and again | A "done" lingers until seen, so it looked new each time | Remember announced done pairs; light only on a new one |
| 6 | Ports and models | Common ports already taken; a model alias that routes to a reasoning model returns an empty body when `max_tokens` is small | Use unusual ports (Whisper on 18866); give a generous `max_tokens` |
| 7 | Can't read files from over SSH | macOS privacy protection (TCC) on Documents etc. | Not fixable from the SSH side; recorded as a constraint (the Mac app that owns the permission saves to `~/Documents/HerdrScribe/`) |
| 8 | Synthesized clock sounded wrong | See section 3 | Real recording, then dropped the clock as an idea |
