#!/usr/bin/env node
// Record a UI flow to a delivery-ready MP4, then inspect it.
//
//   node record.mjs <flow.json> [--preflight] [--out <dir>] [--headed]
//                   [--no-taps] [--keep-raw] [--chromium <path>]
//
// Browser flows (a `url`) are driven with Playwright + Chromium and captured
// as a timestamped sequence of device-pixel screenshots (CDP
// Page.captureScreenshot with clip.scale = deviceScaleFactor), then encoded to
// constant-frame-rate H.264. iOS simulator flows are handed to sim.mjs.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright, launchChromium, resolveFfmpeg } from "./lib/deps.mjs";
import { makeRunDir, parseArgs, writeJson } from "./lib/rundir.mjs";
import { encodeFrames } from "./lib/encode.mjs";
import { inspect, printReport } from "./inspect.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Full-screen app viewports (no browser chrome), CSS px @ deviceScaleFactor. */
const DEVICES = {
  iphone: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  "iphone-pro-max": { width: 430, height: 932, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  "iphone-se": { width: 375, height: 667, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  android: { width: 412, height: 915, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  tablet: { width: 820, height: 1180, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 2, isMobile: false, hasTouch: false },
};

function resolveDevice(spec, playwright) {
  if (spec && typeof spec === "object") return { ...DEVICES.iphone, ...spec };
  if (!spec) return DEVICES.iphone;
  if (DEVICES[spec]) return DEVICES[spec];
  const d = playwright.devices?.[spec];
  if (d) return { ...d.viewport, deviceScaleFactor: d.deviceScaleFactor, isMobile: d.isMobile, hasTouch: d.hasTouch, userAgent: d.userAgent };
  throw new Error(`unknown device "${spec}" (presets: ${Object.keys(DEVICES).join(", ")}, or any Playwright device name, or an object)`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = (s) => (Array.isArray(s) ? s.join(", ") : s);

async function main() {
  const args = parseArgs(process.argv.slice(2), ["preflight", "headed", "no-taps", "keep-raw"]);
  const flowPath = args._[0];
  if (!flowPath) {
    console.error("usage: node record.mjs <flow.json> [--preflight] [--out dir] [--headed] [--no-taps] [--keep-raw]");
    process.exit(2);
  }
  const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
  // A bare path is a local file next to the flow (handy for fixtures).
  if (flow.url && !/^[a-z][a-z0-9+.-]*:/i.test(flow.url)) {
    flow.url = pathToFileURL(path.resolve(path.dirname(flowPath), flow.url)).href;
  }
  const target = flow.target ?? (flow.url ? "browser" : "ios");
  if (target === "ios") {
    const r = spawnSync(process.execPath, [path.join(here, "sim.mjs"), "run", flowPath, ...process.argv.slice(3)], { stdio: "inherit" });
    process.exit(r.status ?? 1);
  }

  const runDir = makeRunDir(flow.name ?? path.basename(flowPath, ".json"), args.out);
  const rawDir = path.join(runDir, "raw");
  const pw = await loadPlaywright();
  const tools = resolveFfmpeg();
  const device = resolveDevice(flow.device, pw.playwright);
  const fps = flow.fps ?? 30;
  const timeout = flow.timeoutMs ?? 15000;
  const gap = flow.stepGapMs ?? 500;
  const tapsOn = !args["no-taps"] && flow.tapIndicators !== false;

  const { browser, executablePath } = await launchChromium(pw.playwright.chromium, {
    headless: !args.headed,
    executablePath: args.chromium ?? flow.executablePath,
  });
  const context = await browser.newContext({
    viewport: { width: device.width, height: device.height },
    screen: { width: device.width, height: device.height },
    deviceScaleFactor: device.deviceScaleFactor,
    isMobile: device.isMobile,
    hasTouch: device.hasTouch,
    userAgent: device.userAgent,
    colorScheme: flow.colorScheme ?? "light",
    reducedMotion: flow.reducedMotion ?? "no-preference",
    locale: flow.locale,
  });
  if (tapsOn) await context.addInitScript({ path: path.join(here, "lib", "taps.js") });
  // Scroll offset for the capture clip, pushed from the page on scroll so the
  // capture loop never spends a round trip asking for it.
  const scroll = { x: 0, y: 0 };
  await context.exposeBinding("__recordFlowScroll", (_src, x, y) => Object.assign(scroll, { x, y }));
  await context.addInitScript(() => {
    addEventListener("scroll", () => window.__recordFlowScroll?.(scrollX, scrollY), { passive: true, capture: true });
  });
  const page = await context.newPage();
  const consoleLog = [];
  page.on("console", (m) => consoleLog.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => consoleLog.push(`[pageerror] ${e.message}`));
  page.on("requestfailed", (r) => consoleLog.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText ?? ""}`));
  page.setDefaultTimeout(timeout);

  const proof = {
    flow: path.resolve(flowPath),
    command: process.argv.join(" "),
    url: flow.url,
    startedAt: new Date().toISOString(),
    environment: {
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      playwright: `${pw.name}@${pw.version} (${pw.from})`,
      chromium: `${browser.version()} (${executablePath})`,
      ffmpeg: `${tools.version} [${tools.codec}]`,
    },
    device,
    colorScheme: flow.colorScheme ?? "light",
    capture: "CDP Page.captureScreenshot sequence, clip.scale = deviceScaleFactor",
  };

  // ---- load + preflight -------------------------------------------------
  const t0 = Date.now();
  await page.goto(flow.url, { waitUntil: flow.waitUntil ?? "load" });
  if (flow.ready) await page.locator(flow.ready).first().waitFor({ state: "visible" });
  for (const s of flow.setup ?? []) await runStep(page, s, { timeout, log: () => {} });
  await sleep(flow.readyDelayMs ?? 500);
  const preflight = path.join(runDir, "preflight.png");
  await page.screenshot({ path: preflight, scale: "device" });
  console.log(`[record-flow] preflight screenshot: ${preflight} (loaded in ${Date.now() - t0}ms)`);
  if (args.preflight) {
    writeJson(path.join(runDir, "console.json"), consoleLog);
    await browser.close();
    console.log("[record-flow] preflight only — view the screenshot, then run without --preflight.");
    return;
  }

  // ---- capture loop -----------------------------------------------------
  const cdp = await context.newCDPSession(page);
  const frames = [];
  let capturing = true;
  let videoStart = 0;
  const clip = { width: device.width, height: device.height, scale: device.deviceScaleFactor };
  const loop = (async () => {
    let i = 0;
    while (capturing) {
      const before = Date.now();
      try {
        const { x, y } = scroll;
        const shot = await cdp.send("Page.captureScreenshot", {
          format: "jpeg",
          quality: 92,
          optimizeForSpeed: true,
          clip: { x, y, ...clip },
        });
        const file = path.join(rawDir, `${String(i++).padStart(6, "0")}.jpg`);
        const buf = Buffer.from(shot.data, "base64");
        fs.writeFileSync(file, buf);
        // Stamp at the midpoint: the pixels are from somewhere inside the call.
        frames.push({ file, t: (before + Date.now()) / 2, bytes: buf.length });
      } catch (e) {
        if (capturing) consoleLog.push(`[capture] ${e.message}`);
        await sleep(10);
      }
    }
  })();
  while (frames.length === 0) await sleep(10);
  videoStart = frames[0].t;
  await sleep(flow.headMs ?? 700);

  // ---- steps --------------------------------------------------------------
  const steps = [];
  const log = (entry) => {
    const videoT = +((Date.now() - videoStart) / 1000).toFixed(3);
    steps.push({ ...entry, videoT });
    console.log(`  ${videoT.toFixed(2).padStart(6)}s  ${entry.action}${entry.label ? ` (${entry.label})` : ""}${entry.selector ? ` ${entry.selector}` : ""}`);
  };
  let failure = null;
  try {
    for (const [i, s] of (flow.steps ?? []).entries()) {
      // stepDefaults (e.g. a shared "wait for the on-screen cue" selector)
      // apply to interactions only, never to waits/gotos.
      const interactive = s.tap || s.hold || s.type !== undefined;
      await runStep(page, interactive ? { ...flow.stepDefaults, ...s } : s, { timeout, gap, log, index: i, cdp });
    }
  } catch (e) {
    failure = e;
    console.error(`[record-flow] step failed: ${e.message.split("\n")[0]}`);
    await page.screenshot({ path: path.join(runDir, "failure.png"), scale: "device" }).catch(() => {});
  }
  await sleep(flow.tailMs ?? 1500);
  // Re-time taps/holds to the moment the page saw the pointer go down.
  const downs = await page.evaluate(() => window.__recordFlowDowns ?? []).catch(() => []);
  let di = 0;
  for (const s of steps) {
    if ((s.action === "tap" || s.action === "hold") && s.wallStart) {
      while (di < downs.length && downs[di] < s.wallStart - 5) di++;
      if (di < downs.length) s.videoT = +((downs[di++] - videoStart) / 1000).toFixed(3);
    }
    delete s.wallStart;
  }
  capturing = false;
  await loop;
  await browser.close();

  // ---- trim leading blank frames, encode -------------------------------------
  const sizes = frames.map((f) => f.bytes).sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)];
  let first = 0;
  while (first < frames.length - 1 && frames[first].bytes < median * 0.15) first++;
  const kept = frames.slice(first);
  const origin = kept[0].t;
  const shift = (origin - videoStart) / 1000;
  for (const s of steps) s.videoT = +(s.videoT - shift).toFixed(3);
  const spanSec = (kept[kept.length - 1].t - origin) / 1000;
  const captureFps = +(kept.length / Math.max(0.001, spanSec)).toFixed(1);
  const mp4 = path.join(runDir, `${flow.name ?? "flow"}.mp4`);
  encodeFrames({
    ffmpeg: tools.ffmpeg,
    codec: tools.codec,
    frames: kept.map((f) => ({ file: f.file, t: f.t - origin })),
    outFile: mp4,
    fps,
    tailMs: 1000 / fps,
    workDir: runDir,
  });

  const stepsFile = path.join(runDir, "steps.json");
  writeJson(stepsFile, { steps });
  writeJson(path.join(runDir, "console.json"), consoleLog);
  const report = await inspect(mp4, {
    tools,
    expect: `${Math.round(device.width * device.deviceScaleFactor / 2) * 2}x${Math.round(device.height * device.deviceScaleFactor / 2) * 2}`,
    cssWidth: device.width,
    steps: stepsFile,
    out: runDir,
  });
  Object.assign(proof, {
    finishedAt: new Date().toISOString(),
    video: mp4,
    capturedFrames: frames.length,
    droppedLeadingFrames: first,
    captureFps,
    outputFps: fps,
    steps,
    stepFailure: failure ? failure.message : null,
    inspection: { verdict: report.verdict, file: path.join(runDir, "inspect.json") },
    preflight,
  });
  writeJson(path.join(runDir, "proof.json"), proof);
  if (!args["keep-raw"] && report.verdict === "PASS" && !failure) fs.rmSync(rawDir, { recursive: true, force: true });

  console.log(`\n[record-flow] run dir: ${runDir}`);
  console.log(`[record-flow] video:   ${mp4}  (captured ${captureFps} fps → ${fps} fps CFR)`);
  printReport(report);
  if (failure) {
    console.error(`\n[record-flow] FLOW FAILED at a step — see failure.png and console.json in ${runDir}`);
    process.exit(3);
  }
  process.exit(report.verdict === "PASS" ? 0 : 1);
}

/** Centre of the first visible match, in CSS px. */
async function centre(page, selector) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function waitForAny(page, selectors, timeout, state = "visible") {
  const sels = Array.isArray(selectors) ? selectors : [selectors];
  await page.locator(sels.join(", ")).first().waitFor({ state, timeout });
}

async function runStep(page, s, { timeout, gap = 0, log: rawLog, cdp }) {
  const label = s.label;
  let wallStart = 0;
  const log = (entry) => rawLog({ ...entry, wallStart });
  if (s.waitFor) {
    try {
      await waitForAny(page, s.waitFor, s.waitForTimeoutMs ?? timeout);
    } catch (e) {
      if (!s.optionalWait) throw new Error(`waitFor ${list(s.waitFor)}: ${e.message}`);
    }
  }
  const pause = s.delayMs ?? (s.tap || s.hold || s.type ? gap : 0);
  if (pause) await sleep(pause);

  if (s.tap) {
    const count = s.count ?? 1;
    for (let k = 0; k < count; k++) {
      const loc = page.locator(s.tap).first();
      await loc.waitFor({ state: "visible", timeout });
      wallStart = Date.now();
      // Logged after the action resolves: Playwright's actionability checks
      // run first, so "before" would stamp the tap ahead of the touch.
      if (s.via === "mouse" || !(await page.evaluate(() => navigator.maxTouchPoints > 0))) await loc.click();
      else await loc.tap();
      log({ action: "tap", selector: s.tap, label });
      if (k < count - 1) await sleep(s.betweenMs ?? gap);
    }
  } else if (s.hold) {
    await page.locator(s.hold).first().waitFor({ state: "visible", timeout });
    const { x, y } = await centre(page, s.hold);
    const ms = s.ms ?? 1000;
    wallStart = Date.now();
    log({ action: "hold", selector: s.hold, label, ms });
    if (s.via === "mouse" || !cdp) {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await sleep(ms);
      await page.mouse.up();
    } else {
      const pt = [{ x, y, id: 1, radiusX: 8, radiusY: 8, force: 1 }];
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt });
      await sleep(ms);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
  } else if (s.type !== undefined) {
    if (s.into) {
      const loc = page.locator(s.into).first();
      await loc.waitFor({ state: "visible", timeout });
      wallStart = Date.now();
      await loc.tap().catch(() => loc.click());
      log({ action: "tap", selector: s.into, label: label ?? "focus field" });
    }
    log({ action: "type", label, text: s.type });
    await page.keyboard.type(String(s.type), { delay: s.delayPerCharMs ?? 45 });
  } else if (s.press) {
    log({ action: "press", label, key: s.press });
    await page.keyboard.press(s.press);
  } else if (s.scroll !== undefined) {
    log({ action: "scroll", selector: s.scroll || "window", label, dy: s.dy ?? 400 });
    await page.evaluate(
      ({ sel, dy }) => (sel ? document.querySelector(sel) : window)?.scrollBy({ top: dy, behavior: "smooth" }),
      { sel: s.scroll, dy: s.dy ?? 400 },
    );
  } else if (s.goto) {
    log({ action: "goto", label, url: s.goto });
    await page.goto(s.goto);
  } else if (s.wait !== undefined) {
    log({ action: "wait", label, ms: s.wait });
    await sleep(s.wait);
  } else if (s.waitFor) {
    log({ action: "waitFor", selector: list(s.waitFor), label });
  } else {
    throw new Error(`unknown step: ${JSON.stringify(s)}`);
  }

  if (s.expect) {
    try {
      await waitForAny(page, s.expect, s.expectTimeoutMs ?? timeout);
    } catch (e) {
      throw new Error(`expect ${list(s.expect)} after ${label ?? JSON.stringify(s)}: ${e.message.split("\n")[0]}`);
    }
  }
  if (s.afterMs) await sleep(s.afterMs);
}

main().catch((e) => {
  console.error(`[record-flow] ${e.stack ?? e}`);
  process.exit(1);
});
