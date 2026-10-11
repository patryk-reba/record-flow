# Environments and dependency resolution

Everything is resolved at run time, so the same command works on a laptop, in
CI and in a cloud container. All three steps are in `scripts/lib/deps.mjs`.

## Playwright library

First match wins:

1. the project's own `playwright` / `playwright-core` (resolved from the cwd)
2. one installed next to the plugin
3. the global npm root
4. `playwright-core` installed once into the cache
   (`~/.cache/record-flow`, `%LOCALAPPDATA%\record-flow` on Windows;
   override with `RECORD_FLOW_CACHE`). Browsers are never downloaded by this step.

## Chromium

1. `RECORD_FLOW_CHROMIUM` or the flow's `executablePath`, if set
2. Playwright's bundled build for that version
3. otherwise any preinstalled build, newest first:
   `$PLAYWRIGHT_BROWSERS_PATH`, `/opt/pw-browsers` (Claude Code cloud
   containers), `~/.cache/ms-playwright`, `~/Library/Caches/ms-playwright`,
   `%LOCALAPPDATA%\ms-playwright`, then system Chrome/Chromium.
   It launches with an explicit `executablePath`, so nothing is downloaded when
   the preinstalled browser doesn't match the Playwright version.

## ffmpeg / ffprobe

`RECORD_FLOW_FFMPEG` / `RECORD_FLOW_FFPROBE`, then `PATH`, then
`ffmpeg-static` + `ffprobe-static` installed into the cache. The encoder is
`libx264` when available, else `h264_videotoolbox` (macOS), else `libopenh264`.
Playwright's own bundled ffmpeg is VP8-only and is not used.

## Why screenshots, not `recordVideo` or screencast

Measured on Chromium 147–153 (headless and headed):

- `recordVideo` and CDP `Page.startScreencast` deliver frames at **CSS-pixel**
  size (390×844 for an iPhone viewport) whatever `deviceScaleFactor` is, and
  `recordVideo.size` larger than the viewport **pads with grey** instead of
  scaling. The output is either soft (CSS px) or mostly grey (padded).
- `Page.captureScreenshot` with `clip.scale = deviceScaleFactor` returns true
  device pixels (1170×2532). Each frame is timestamped and the frames are
  encoded with the concat demuxer (each still held until the next), so the
  video keeps real time at a constant 30 fps.
- Capture rate depends on the page: ~30–55 fps on simple pages, ~15–20 fps on
  heavy ones (large blurs, many layers). Parallel capture requests mostly
  return duplicate frames, so the loop stays sequential.
- JPEG stills are full-range; the encoder converts with `out_range=tv`, so the
  file is real `yuv420p` (not `yuvj420p`).
