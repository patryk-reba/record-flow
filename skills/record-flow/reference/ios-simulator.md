# iOS simulator recording

Requires macOS with Xcode (`xcrun simctl`). Records the simulator's own
framebuffer (`xcrun simctl io <udid> recordVideo`), so no desktop, no other
windows, and no screen-recording permission is involved.

## Choices made

| Option | Decision | Why |
| --- | --- | --- |
| `--codec` | `h264` | default is HEVC, which many players/upload paths reject |
| `--mask` | `black` | `alpha` is unsupported and renders black anyway; `ignored` leaves corner garbage |
| start | wait for `Recording started` on stderr | simctl prints it after the first frame; driving earlier loses the start |
| stop | `SIGINT`, then wait for the process to exit | simctl finalizes the file on SIGINT; killing harder leaves an unplayable file |
| frame rate | re-encode with `fps=30` | simctl writes frames only on change (VFR) |
| leading blank | detected by `inspect.mjs`, trimmed on re-encode | the first frame can arrive late |

**Maestro** (`startRecording`/`stopRecording` inside a flow, or `maestro
record`) is the alternative. `maestro record` renders a 2× sped-up video with
the flow overlay and caps at 2 minutes — fine for CI artifacts, wrong for
demos. Here Maestro drives the app and simctl records it.

## Tap indicators

The Simulator's "Show single touches" setting
(`defaults write com.apple.iphonesimulator ShowSingleTouches 1`) draws dots in
the Simulator **window** only; they are not in the framebuffer, so
`simctl recordVideo` does not capture them. Options:

1. The app's own debug touch overlay, if it has one (best).
2. Maestro's recording, which injects its own indicator into the app.
3. Accept no indicators; the step log in `proof.json` still times every tap.

## Commands

```bash
S="${CLAUDE_SKILL_DIR}/scripts"
node "$S/sim.mjs" preflight                     # booted device + preflight.png
node "$S/sim.mjs" run ios.flow.json              # record while Maestro runs the flow
node "$S/sim.mjs" start                          # or: start …
#   … drive the app with any tool (Maestro, idb, a simulator MCP) …
node "$S/sim.mjs" stop --out <runDir>            # … stop, encode, inspect
```

`ios.flow.json`:

```json
{ "name": "onboarding", "target": "ios", "maestro": "onboarding.yaml", "leadMs": 800, "tailMs": 1200 }
```

Preflight first: the screenshot must show the app on the expected screen — not
the lock screen, the home screen, a system alert or a different booted device.
A black preflight means the device isn't booted or is asleep. Close stray
alerts in the app's UI (or with a Maestro step), not by cropping.
