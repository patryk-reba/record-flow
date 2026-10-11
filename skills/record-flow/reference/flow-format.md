# Flow file format

One JSON object. Only `url` (browser) or `maestro` (iOS) is required.

## Top level

| Key | Default | Meaning |
| --- | --- | --- |
| `name` | file name | used for the run dir and the MP4 name |
| `target` | `browser` if `url`, else `ios` | force `browser` / `ios` |
| `url` | — | page to open. A bare path is resolved relative to the flow file (`file://`) |
| `device` | `iphone` | preset, a Playwright device name (`"Pixel 7"`), or an object `{width,height,deviceScaleFactor,isMobile,hasTouch,userAgent}` |
| `colorScheme` | `light` | `light` / `dark` (sets `prefers-color-scheme`) |
| `reducedMotion` | `no-preference` | `reduce` to freeze animations |
| `locale` | browser default | e.g. `en-US` |
| `waitUntil` | `load` | `goto` wait condition (`domcontentloaded`, `networkidle`) |
| `ready` | — | selector that must be visible before recording starts |
| `readyDelayMs` | 500 | extra settle time after `ready` |
| `setup` | `[]` | steps run **before** capture (dismiss banners, seed state through the UI) |
| `steps` | `[]` | the recorded flow |
| `stepDefaults` | `{}` | merged into every `tap` / `hold` / `type` step |
| `stepGapMs` | 500 | pause before each interaction, so viewers see the target first |
| `headMs` | 700 | recorded lead-in before the first step |
| `tailMs` | 1500 | recorded tail after the last step |
| `timeoutMs` | 15000 | default wait timeout |
| `fps` | 30 | output frame rate |
| `tapIndicators` | `true` | draw touch indicators |
| `executablePath` | auto | Chromium binary to use |

Device presets (CSS px @ DPR → video px): `iphone` 390×844@3 → 1170×2532,
`iphone-pro-max` 430×932@3, `iphone-se` 375×667@2, `android` 412×915@3,
`tablet` 820×1180@2, `desktop` 1440×900@2.

## Steps

Each step does one thing. Common keys on any step:

| Key | Meaning |
| --- | --- |
| `label` | name in the step log / proof / taps sheet |
| `waitFor` | selector or array (any of) that must be visible before acting |
| `waitForTimeoutMs` | timeout for `waitFor` |
| `optionalWait` | `true`: carry on if `waitFor` never appears |
| `delayMs` | pause before acting (overrides `stepGapMs`) |
| `expect` | selector or array that must appear after acting (fails the run otherwise) |
| `expectTimeoutMs` | timeout for `expect` |
| `afterMs` | pause after acting |

Actions:

| Step | Effect |
| --- | --- |
| `{ "tap": sel }` | touch tap (mouse click on non-touch devices). `count`, `betweenMs` repeat it; `"via": "mouse"` forces a click |
| `{ "hold": sel, "ms": 1000 }` | press and hold at the element centre (CDP touch; `"via": "mouse"` for mouse down/up) |
| `{ "type": "text", "into"?: sel }` | tap `into` first if given, then type (`delayPerCharMs`, default 45) |
| `{ "press": "Enter" }` | key press |
| `{ "scroll": sel \| "", "dy": 400 }` | smooth-scroll an element (or the window) |
| `{ "goto": url }` | navigate |
| `{ "wait": ms }` | just wait |
| `{ "waitFor": sel }` | wait without acting |

## Pacing for a demo

- A visible cue (tooltip, highlight) should be on screen ~0.5 s before the
  tap: put the cue selector in `stepDefaults.waitFor` with `optionalWait`.
- A short `afterMs` (≈300 ms) stops the next step from matching the previous
  step's cue while the UI re-renders.
- Holds need 1–1.5 s to read as a hold on video.
