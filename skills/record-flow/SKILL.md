---
name: record-flow
description: Record a video of an app's UI flow (web app in a browser, or an iOS app in the simulator), verify the video with scripted checks plus a visual review, and send the MP4 to the user. Use when asked to record, film, capture or demo a flow, onboarding, walkthrough or feature as a video, or to "show me a video of" an app.
---

# record-flow

You drive the app; the scripts capture it, encode a delivery-ready MP4 and
inspect it. **Never hand over a video you have not inspected and looked at.**

Scripts live in `${CLAUDE_SKILL_DIR}/scripts/` (Node ≥ 18, no install step:
Playwright and ffmpeg are resolved or fetched on first run — see
[reference/environments.md](reference/environments.md)).

## 1. Pick the target

| The app is… | Target | How |
| --- | --- | --- |
| a web app / anything with a URL (the only option in cloud containers) | browser | `record.mjs` + a flow file with `url` |
| a native iOS app, and `xcrun` exists (macOS + Xcode) | iOS simulator | `sim.mjs` — see [reference/ios-simulator.md](reference/ios-simulator.md) |

A web app that also ships in a native shell (Capacitor, etc.) records best in
the browser at phone size: crisper, scriptable, no simulator needed.

If the flow needs auth or a backend you can't reach, render the screen in a
**standalone harness** instead of fighting the real app:
[reference/standalone-harness.md](reference/standalone-harness.md).

## 2. Write the flow file

JSON, anywhere outside the repo is fine (a project may keep reusable ones).
Full schema: [reference/flow-format.md](reference/flow-format.md).

```json
{
  "name": "signup",
  "url": "http://localhost:5173/signup",
  "device": "iphone",
  "colorScheme": "light",
  "ready": "form#signup",
  "stepDefaults": { "afterMs": 300 },
  "steps": [
    { "tap": "input[name=email]", "label": "focus email" },
    { "type": "ada@example.com" },
    { "hold": "button[aria-label=Help]", "ms": 1200 },
    { "tap": "button[type=submit]", "expect": "text=Welcome" }
  ]
}
```

Selectors are Playwright selectors. Prefer ids, `aria-label`s and
`data-*` hooks the app already has; read the component source to find them.
Taps wait for the target to be visible; add `waitFor` for a cue that must
appear first (a tooltip, a loaded list) and `expect` for what must follow.

## 3. Preflight — look before you record

```bash
node "${CLAUDE_SKILL_DIR}/scripts/record.mjs" flow.json --preflight
```

Open the printed `preflight.png` with your image-viewing tool. Confirm: the
right screen, fully loaded, right theme, no stray dialogs/toasts/cookie
banners, no dev overlays (Vite error overlay, React Query devtools). Remove
clutter **through the UI** — add `setup` steps (they run before capture) —
never by cropping. Fix and preflight again until it is clean.

## 4. Record

```bash
node "${CLAUDE_SKILL_DIR}/scripts/record.mjs" flow.json
```

It writes a run directory **outside the working tree**
(`$TMPDIR/record-flow/<stamp>-<name>/`, override with `--out`):

- `<name>.mp4` — H.264 High, yuv420p, `+faststart`, even dimensions, CFR 30,
  at viewport × deviceScaleFactor (390×844 @3 → 1170×2532)
- `proof.json` — command, URL, environment, device, capture fps, step log
- `steps.json` — every action with its timestamp in the video
- `inspect.json`, `contact-sheet.png`, `taps-sheet.png`, `frames/full-*.png`
- `preflight.png`, `console.json` (page console, errors, failed requests)
- `failure.png` if a step failed

Tap indicators are on by default (`--no-taps` / `"tapIndicators": false`).
Exit codes: 0 pass, 1 inspection failed, 3 a flow step failed.

## 5. Inspect — mandatory, then look

The recorder runs `inspect.mjs` on the exported file automatically (run it by
hand on any other video: `node "${CLAUDE_SKILL_DIR}/scripts/inspect.mjs" video.mp4
--expect 1170x2532 --css-width 390 --steps steps.json`). It checks:
container/codec/pix_fmt, even dimensions, faststart, expected size (fills the
frame), pixel density (sharp at device size), leading blank frames, blank
frames overall, grey/black padding in the right and bottom quarters,
`blackdetect`.

Then **view, in this order**:
1. `contact-sheet.png` — 12 frames across the whole video. Is it the right
   flow, start to finish, nothing stuck, no error screens?
2. `taps-sheet.png` — one frame per tap/hold. Is every indicator on the
   intended control?
3. At least one `frames/full-*.png` at full resolution — text crisp, nothing
   clipped, no private data.

A WARN on padding means a large flat area: decide from the sheet whether it is
the app's own background (fine) or padding (re-record). Any FAIL, a wrong
screen, a missed tap or a step failure → fix the flow and re-record. Do not
ship a flawed video with a disclaimer.

## 6. Deliver

Send the MP4 itself with the session's file-sending tool (e.g.
`SendUserFile`, display `render`); in a plain terminal give the absolute path.
Include a two-line summary: what the video shows, duration/resolution, and the
inspection verdict. Keep raw captures local (they are deleted on a clean
pass; `--keep-raw` keeps them). Never commit videos or run dirs.

## Fallbacks — diagnose before retrying

| Symptom | Likely cause → fix |
| --- | --- |
| page in the top-left, grey elsewhere | capture size ≠ viewport × DPR (the classic `recordVideo.size` mistake). `record.mjs` captures at exactly the viewport; if you see this you used another recorder. |
| blank / white frames at the start | `ready` selector missing or too early → point it at real content; raise `readyDelayMs` |
| blank throughout | page didn't load (check `console.json` for failed requests / page errors), wrong URL or port, dev server down |
| black frames (simulator) | simulator asleep / locked screen / wrong device booted → preflight shows it |
| `No launchable Chromium` | set `RECORD_FLOW_CHROMIUM=/path/to/chrome`, or `npx playwright install chromium` |
| a step times out | wrong selector or the UI is busy; open `failure.png`, adjust `waitFor` / `timeoutMs` |
| tap does nothing | an overlay intercepts it, or the app ignores touch → `"via": "mouse"` on that step |
| choppy motion | heavy page: capture rate is printed (`captured N fps`); keep animations, accept ~15 fps on very heavy UIs, or record a smaller viewport for smooth motion |
