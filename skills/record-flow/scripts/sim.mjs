#!/usr/bin/env node
// iOS simulator recording (macOS + Xcode). Records the simulator's own
// framebuffer with `xcrun simctl io <device> recordVideo` — never the desktop.
//
//   node sim.mjs preflight            [--device booted] [--out dir]
//   node sim.mjs start                [--device booted] [--out dir]   → prints run dir
//   node sim.mjs stop  --out <runDir>                                 → MP4 + inspection
//   node sim.mjs run   <flow.json>    [--out dir]                     → start, run Maestro, stop
//
// start/stop split the recording so the agent can drive the app with any
// tool in between (Maestro, idb, XCUITest, simulator MCP taps).
// flow.json for iOS: { "name", "target": "ios", "device"?: "booted",
//   "maestro": "path/to/flow.yaml", "leadMs"?: 800, "tailMs"?: 1200 }
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { makeRunDir, parseArgs, writeJson } from "./lib/rundir.mjs";
import { resolveFfmpeg } from "./lib/deps.mjs";
import { transcode } from "./lib/encode.mjs";
import { inspect, printReport } from "./inspect.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function simctl(args, opts = {}) {
  const r = spawnSync("xcrun", ["simctl", ...args], { encoding: "utf8", ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`xcrun simctl ${args.join(" ")}: ${r.stderr}`);
  return r;
}

function bootedDevice(want) {
  if (spawnSync("xcrun", ["--find", "simctl"]).status !== 0) {
    throw new Error("xcrun simctl not found — iOS recording needs macOS with Xcode. Use a browser flow instead.");
  }
  const j = JSON.parse(simctl(["list", "devices", "booted", "-j"]).stdout);
  const booted = Object.entries(j.devices).flatMap(([rt, ds]) => ds.map((d) => ({ ...d, runtime: rt.split(".").pop() })));
  if (!booted.length) throw new Error("No booted simulator. Boot one (xcrun simctl boot <udid>; open -a Simulator) and retry.");
  if (!want || want === "booted") return booted[0];
  const d = booted.find((x) => x.udid === want || x.name === want);
  if (!d) throw new Error(`Simulator "${want}" is not booted. Booted: ${booted.map((x) => x.name).join(", ")}`);
  return d;
}

async function preflight(dev, runDir) {
  const file = path.join(runDir, "preflight.png");
  simctl(["io", dev.udid, "screenshot", "--type=png", file]);
  console.log(`[record-flow] simulator: ${dev.name} (${dev.runtime}, ${dev.udid})`);
  console.log(`[record-flow] preflight screenshot: ${file} — view it: right app, no stray alerts, not the lock screen.`);
  return file;
}

async function start(dev, runDir) {
  const raw = path.join(runDir, "raw", "capture.mov");
  const logFile = path.join(runDir, "raw", "simctl.log");
  const fd = fs.openSync(logFile, "w");
  // h264 (default is hevc); black mask so the rounded-corner area is not transparent.
  const child = spawn("xcrun", ["simctl", "io", dev.udid, "recordVideo", "--codec=h264", "--mask=black", "--force", raw], {
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  const t0 = Date.now();
  // simctl prints "Recording started" after the first frame lands; drive nothing before that.
  while (!/Recording started/i.test(fs.readFileSync(logFile, "utf8"))) {
    if (Date.now() - t0 > 15000) throw new Error(`simctl recordVideo did not start: ${fs.readFileSync(logFile, "utf8")}`);
    await sleep(100);
  }
  const state = { pid: child.pid, udid: dev.udid, device: dev.name, runtime: dev.runtime, raw, startedAt: Date.now() };
  writeJson(path.join(runDir, "raw", "state.json"), state);
  console.log(`[record-flow] recording ${dev.name} → ${raw} (pid ${child.pid})`);
  return state;
}

async function stop(runDir, extra = {}) {
  const state = JSON.parse(fs.readFileSync(path.join(runDir, "raw", "state.json"), "utf8"));
  try {
    process.kill(state.pid, "SIGINT"); // clean stop: simctl finalizes the file, then exits
  } catch {
    // already gone
  }
  const t0 = Date.now();
  for (;;) {
    try {
      process.kill(state.pid, 0);
    } catch {
      break;
    }
    if (Date.now() - t0 > 30000) throw new Error("simctl did not exit after SIGINT");
    await sleep(100);
  }
  const tools = resolveFfmpeg();
  const name = extra.name ?? "simulator";
  const mp4 = path.join(runDir, `${name}.mp4`);
  // simctl writes frames only on change (VFR): re-encode to CFR 30.
  transcode({ ffmpeg: tools.ffmpeg, codec: tools.codec, input: state.raw, outFile: mp4, fps: 30 });
  let report = await inspect(mp4, { tools, out: runDir });
  if (report.leadingBlankSec > 0) {
    transcode({ ffmpeg: tools.ffmpeg, codec: tools.codec, input: state.raw, outFile: mp4, fps: 30, startSec: report.leadingBlankSec });
    report = await inspect(mp4, { tools, out: runDir });
  }
  writeJson(path.join(runDir, "proof.json"), {
    target: "ios-simulator",
    device: `${state.device} (${state.runtime}, ${state.udid})`,
    capture: "xcrun simctl io recordVideo --codec=h264 --mask=black, SIGINT stop, re-encoded to CFR 30",
    ffmpeg: tools.version,
    startedAt: new Date(state.startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    video: mp4,
    inspection: { verdict: report.verdict, file: path.join(runDir, "inspect.json") },
    ...extra,
  });
  console.log(`\n[record-flow] run dir: ${runDir}\n[record-flow] video:   ${mp4}`);
  printReport(report);
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd === "stop") {
    if (!args.out) throw new Error("stop needs --out <runDir> (printed by start)");
    const r = await stop(path.resolve(args.out), { name: args.name });
    process.exit(r.verdict === "PASS" ? 0 : 1);
  }
  const flow = cmd === "run" && args._[1] ? JSON.parse(fs.readFileSync(args._[1], "utf8")) : {};
  const dev = bootedDevice(args.device ?? flow.device);
  const runDir = makeRunDir(flow.name ?? "simulator", args.out);
  await preflight(dev, runDir);
  if (cmd === "preflight") return;
  if (cmd === "start") {
    await start(dev, runDir);
    console.log(`[record-flow] drive the app now, then: node ${path.relative(process.cwd(), process.argv[1])} stop --out ${runDir}`);
    return;
  }
  if (cmd === "run") {
    if (!flow.maestro) throw new Error('iOS flow needs "maestro": "<flow.yaml>" (or use start/stop and drive the app yourself)');
    if (spawnSync("maestro", ["--version"]).status !== 0) throw new Error("maestro CLI not found (https://maestro.dev) — or use start/stop");
    const maestroFlow = path.resolve(path.dirname(args._[1]), flow.maestro);
    await start(dev, runDir);
    await sleep(flow.leadMs ?? 800);
    const t = Date.now();
    const r = spawnSync("maestro", ["--device", dev.udid, "test", maestroFlow], { stdio: "inherit" });
    await sleep(flow.tailMs ?? 1200);
    const report = await stop(runDir, {
      name: flow.name,
      flow: path.resolve(args._[1]),
      command: `maestro --device ${dev.udid} test ${maestroFlow}`,
      maestroExit: r.status,
      maestroSec: (Date.now() - t) / 1000,
    });
    if (r.status !== 0) {
      console.error(`[record-flow] maestro exited ${r.status} — the video shows a failed flow; fix and re-record.`);
      process.exit(3);
    }
    process.exit(report.verdict === "PASS" ? 0 : 1);
  }
  console.error("usage: node sim.mjs preflight|start|stop|run …");
  process.exit(2);
}

main().catch((e) => {
  console.error(`[record-flow] ${e.message}`);
  process.exit(1);
});
