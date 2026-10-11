#!/usr/bin/env node
// Mandatory pre-delivery inspection of an exported MP4.
//
//   node inspect.mjs <video.mp4> [--expect 1170x2532] [--css-width 390]
//                    [--steps steps.json] [--out <dir>]
//
// Writes inspect.json, contact-sheet.png, taps-sheet.png (when step log has
// taps) and full-resolution frames/*.png next to the video. Exit code 1 when
// any check FAILS. The agent must still LOOK at the sheets: numbers catch
// padding and blank frames, not a wrong screen.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, writeJson } from "./lib/rundir.mjs";
import { resolveFfmpeg } from "./lib/deps.mjs";
import { run } from "./lib/encode.mjs";

function probe(ffprobe, file) {
  const r = run(ffprobe, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_name,profile,pix_fmt,width,height,avg_frame_rate,nb_frames:format=duration,size",
    "-of",
    "json",
    file,
  ]);
  const j = JSON.parse(r.stdout);
  const s = j.streams?.[0] ?? {};
  const [n, d] = String(s.avg_frame_rate || "0/1").split("/").map(Number);
  return {
    codec: s.codec_name,
    profile: s.profile,
    pixFmt: s.pix_fmt,
    width: s.width,
    height: s.height,
    fps: d ? +(n / d).toFixed(2) : 0,
    frames: Number(s.nb_frames) || null,
    durationSec: +Number(j.format?.duration || 0).toFixed(3),
    sizeBytes: Number(j.format?.size || 0),
  };
}

/** `moov` before `mdat` = progressive playback starts before the download ends. */
function faststart(file) {
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(16);
  let pos = 0;
  const size = fs.fstatSync(fd).size;
  try {
    while (pos < size) {
      fs.readSync(fd, buf, 0, 16, pos);
      let len = buf.readUInt32BE(0);
      const type = buf.toString("latin1", 4, 8);
      if (type === "moov") return true;
      if (type === "mdat") return false;
      if (len === 1) len = Number(buf.readBigUInt64BE(8));
      if (len < 8) return false;
      pos += len;
    }
  } finally {
    fs.closeSync(fd);
  }
  return false;
}

function parseMetadata(text) {
  const frames = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/pts_time:([\d.]+)/);
    if (m) {
      cur = { t: Number(m[1]) };
      frames.push(cur);
      continue;
    }
    const kv = line.match(/lavfi\.signalstats\.(\w+)=([\d.]+)/);
    if (kv && cur) cur[kv[1]] = Number(kv[2]);
  }
  return frames;
}

/** No detail at all: luma AND chroma spread within a few code values. */
const flat = (f) => f.YMAX - f.YMIN < 8 && f.UMAX - f.UMIN < 8 && f.VMAX - f.VMIN < 8;

function regionStats(ffmpeg, file, workDir, sampleFps) {
  const graph = [
    `[0:v]fps=${sampleFps},split=3[a][b][c]`,
    `[a]signalstats,metadata=mode=print:file=sig-full.txt[a1]`,
    `[b]crop=iw/4:ih:iw*3/4:0,signalstats,metadata=mode=print:file=sig-right.txt[b1]`,
    `[c]crop=iw:ih/4:0:ih*3/4,signalstats,metadata=mode=print:file=sig-bottom.txt[c1]`,
  ].join(";");
  run(
    ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-i", file, "-filter_complex", graph,
      "-map", "[a1]", "-f", "null", "-", "-map", "[b1]", "-f", "null", "-", "-map", "[c1]", "-f", "null", "-"],
    { cwd: workDir },
  );
  const read = (n) => {
    const p = path.join(workDir, `sig-${n}.txt`);
    const frames = parseMetadata(fs.readFileSync(p, "utf8"));
    fs.rmSync(p);
    return frames;
  };
  return { full: read("full"), right: read("right"), bottom: read("bottom") };
}

function blackIntervals(ffmpeg, file) {
  const r = run(
    ffmpeg,
    ["-hide_banner", "-i", file, "-vf", "blackdetect=d=0.2:pic_th=0.995:pix_th=0.05", "-an", "-f", "null", "-"],
    { allowFail: true },
  );
  const out = [];
  for (const m of (r.stderr || "").matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)) {
    out.push({ start: Number(m[1]), end: Number(m[2]) });
  }
  return out;
}

function extract(ffmpeg, file, t, outFile, width) {
  const vf = width ? ["-vf", `scale=${width}:-2:flags=lanczos`] : [];
  run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", ...vf, outFile]);
}

function sheet(ffmpeg, dir, outFile, count, cols) {
  const rows = Math.ceil(count / cols);
  run(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error", "-framerate", "1", "-i", path.join(dir, "%03d.png"),
    "-vf", `tile=${cols}x${rows}:padding=8:margin=8:color=0x303030`, "-frames:v", "1", outFile,
  ]);
}

export async function inspect(video, opts = {}) {
  video = path.resolve(video);
  const tools = opts.tools ?? resolveFfmpeg();
  const { ffmpeg, ffprobe } = tools;
  const outDir = path.resolve(opts.out ?? path.dirname(video));
  fs.mkdirSync(path.join(outDir, "frames"), { recursive: true });
  const meta = probe(ffprobe, video);
  const checks = [];
  const check = (name, ok, detail, level = "fail") =>
    checks.push({ name, status: ok ? "pass" : level, detail });

  check("container", meta.codec === "h264" && meta.pixFmt === "yuv420p",
    `${meta.codec} ${meta.profile ?? ""} ${meta.pixFmt} @ ${meta.fps}fps, ${meta.durationSec}s, ${(meta.sizeBytes / 1e6).toFixed(1)}MB`);
  check("even dimensions", meta.width % 2 === 0 && meta.height % 2 === 0, `${meta.width}x${meta.height}`);
  check("faststart (moov before mdat)", faststart(video), "");
  if (opts.expect) {
    const [w, h] = String(opts.expect).split("x").map(Number);
    check("fills the frame (expected size)", Math.abs(meta.width - w) <= 2 && Math.abs(meta.height - h) <= 2,
      `video ${meta.width}x${meta.height}, expected ${w}x${h} (viewport × deviceScaleFactor)`);
  }
  if (opts.cssWidth) {
    const density = meta.width / Number(opts.cssWidth);
    check("sharp at device size", density >= 2, `${density.toFixed(2)} video px per CSS px (want ≥ 2, ideally 3)`, "fail");
  }

  const sampleFps = 10;
  const stats = regionStats(ffmpeg, video, outDir, sampleFps);
  let leadingBlank = 0;
  for (const f of stats.full) {
    if (!flat(f)) break;
    leadingBlank = f.t + 1 / sampleFps;
  }
  const blankRatio = stats.full.filter(flat).length / Math.max(1, stats.full.length);
  check("no leading blank frames", leadingBlank < 0.15, `${leadingBlank.toFixed(2)}s blank at start`);
  check("no blank frames overall", blankRatio < 0.02, `${(blankRatio * 100).toFixed(1)}% of sampled frames are uniform`);

  for (const region of ["right", "bottom"]) {
    const frames = stats[region];
    const padded = frames.filter((f, i) => flat(f) && !flat(stats.full[i] ?? f));
    const ratio = padded.length / Math.max(1, frames.length);
    const avg = (k) => (padded.length ? Math.round(padded.reduce((s, f) => s + f[k], 0) / padded.length) : 0);
    const [y, u, v] = [avg("YAVG"), avg("UAVG"), avg("VAVG")];
    // Playwright/ffmpeg pad with neutral grey (or black): that is a hard
    // fail. Any other flat fill is more likely the app's own empty
    // background, so it only warns and the contact sheet decides.
    const neutral = Math.abs(u - 128) < 5 && Math.abs(v - 128) < 5 && (y < 24 || (y > 90 && y < 170));
    check(`no ${region} padding`, ratio < 0.9,
      ratio >= 0.9
        ? `${region} quarter is a flat ${neutral ? "neutral grey/black " : ""}fill (YUV ≈ ${y},${u},${v}) in ${(ratio * 100).toFixed(0)}% of frames while the rest has content — ${neutral ? "the page was padded, not scaled: capture size ≠ viewport × DPR" : "confirm on the contact sheet that this is the app's own background"}`
        : `${(ratio * 100).toFixed(0)}% of frames flat in the ${region} quarter`,
      neutral ? "fail" : "warn");
  }

  const black = blackIntervals(ffmpeg, video);
  check("no black at start", !black.some((b) => b.start < 0.1), JSON.stringify(black));
  check("no long black stretches", !black.some((b) => b.end - b.start > 1), JSON.stringify(black), "warn");

  // Contact sheet: 12 evenly spaced frames, a small multiple of the whole video.
  const sheetDir = path.join(outDir, "frames", "sheet");
  fs.rmSync(sheetDir, { recursive: true, force: true });
  fs.mkdirSync(sheetDir, { recursive: true });
  const n = 12;
  const times = Array.from({ length: n }, (_, i) => +((meta.durationSec - 0.05) * (i / (n - 1))).toFixed(3));
  times.forEach((t, i) => extract(ffmpeg, video, t, path.join(sheetDir, `${String(i + 1).padStart(3, "0")}.png`), 300));
  const contactSheet = path.join(outDir, "contact-sheet.png");
  sheet(ffmpeg, sheetDir, contactSheet, n, 6);

  // Full-resolution frames FROM THE EXPORTED FILE (not raw captures).
  const fullFrames = [0.02, 0.33, 0.66, 0.98].map((p, i) => {
    const t = +(meta.durationSec * p).toFixed(3);
    const f = path.join(outDir, "frames", `full-${i + 1}-${t.toFixed(2)}s.png`);
    extract(ffmpeg, video, t, f);
    return f;
  });

  // Tap sheet: one frame just after every tap/hold so the indicators can be seen.
  let tapsSheet = null;
  let taps = [];
  if (opts.steps && fs.existsSync(opts.steps)) {
    const log = JSON.parse(fs.readFileSync(opts.steps, "utf8"));
    taps = (log.steps ?? log).filter((s) => (s.action === "tap" || s.action === "hold") && typeof s.videoT === "number");
    if (taps.length) {
      const tapDir = path.join(outDir, "frames", "taps");
      fs.rmSync(tapDir, { recursive: true, force: true });
      fs.mkdirSync(tapDir, { recursive: true });
      taps.forEach((s, i) => {
        const t = Math.min(meta.durationSec - 0.05, s.videoT + (s.action === "hold" ? 0.5 : 0.15));
        extract(ffmpeg, video, t, path.join(tapDir, `${String(i + 1).padStart(3, "0")}.png`), 240);
      });
      tapsSheet = path.join(outDir, "taps-sheet.png");
      sheet(ffmpeg, tapDir, tapsSheet, taps.length, Math.min(8, taps.length));
    }
  }

  const failed = checks.filter((c) => c.status === "fail");
  const result = {
    video: path.resolve(video),
    verdict: failed.length ? "FAIL" : "PASS",
    meta,
    checks,
    leadingBlankSec: +leadingBlank.toFixed(2),
    blackIntervals: black,
    contactSheet: { file: contactSheet, timesSec: times, layout: "6 columns x 2 rows, left→right, top→bottom" },
    tapsSheet: tapsSheet && { file: tapsSheet, taps: taps.map((s, i) => ({ n: i + 1, label: s.label, t: s.videoT })) },
    fullFrames,
  };
  writeJson(path.join(outDir, "inspect.json"), result);
  return result;
}

export function printReport(r) {
  console.log(`\nINSPECTION ${r.verdict}  ${r.video}`);
  for (const c of r.checks) console.log(`  [${c.status.toUpperCase().padEnd(4)}] ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  console.log(`  contact sheet: ${r.contactSheet.file}`);
  if (r.tapsSheet) console.log(`  taps sheet:    ${r.tapsSheet.file}`);
  console.log(`  full frames:   ${r.fullFrames.join("\n                 ")}`);
  console.log("  NEXT: view the contact sheet (and taps sheet) and at least one full frame before delivering.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const video = args._[0];
  if (!video) {
    console.error("usage: node inspect.mjs <video.mp4> [--expect WxH] [--css-width N] [--steps steps.json] [--out dir]");
    process.exit(2);
  }
  const r = await inspect(video, { expect: args.expect, cssWidth: args["css-width"], steps: args.steps, out: args.out });
  printReport(r);
  process.exit(r.verdict === "PASS" ? 0 : 1);
}
