import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { h264Args } from "./deps.mjs";

export function run(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`${path.basename(bin)} ${args.join(" ")}\n${(r.stderr || "").slice(-2000)}`);
  }
  return r;
}

/** Shared tail of every encode: even dimensions, yuv420p, H.264, moov up front. */
export function finalVideoArgs({ codec, fps }) {
  return [
    "-vf",
    // out_range=tv: JPEG stills are full-range; without it the output is
    // yuvj420p, which some players and upload pipelines reject.
    `fps=${fps},scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos:out_range=tv,format=yuv420p`,
    ...h264Args(codec),
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-an",
  ];
}

/**
 * Timestamped stills → constant-frame-rate MP4. Each still is held until the
 * next one was captured (concat demuxer durations), so the video keeps real
 * time even though the capture rate varies with page complexity.
 */
export function encodeFrames({ ffmpeg, codec, frames, outFile, fps = 30, tailMs = 1000, workDir }) {
  if (frames.length === 0) throw new Error("no frames captured");
  const q = (f) => `file '${f.replace(/'/g, "'\\''")}'`;
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const next = frames[i + 1];
    const dur = next ? Math.max(1, next.t - frames[i].t) : tailMs;
    lines.push(q(frames[i].file), `duration ${(dur / 1000).toFixed(4)}`);
  }
  lines.push(q(frames[frames.length - 1].file)); // concat demuxer drops the last duration otherwise
  const list = path.join(workDir, "frames.txt");
  fs.writeFileSync(list, lines.join("\n") + "\n");
  run(ffmpeg, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    ...finalVideoArgs({ codec, fps }),
    outFile,
  ]);
  return outFile;
}

/** Any capture (e.g. simctl's variable-frame-rate .mov) → the same delivery format, optionally trimmed. */
export function transcode({ ffmpeg, codec, input, outFile, fps = 30, startSec = 0, endSec }) {
  const trim = [];
  if (startSec > 0) trim.push("-ss", startSec.toFixed(3));
  if (endSec) trim.push("-to", endSec.toFixed(3));
  run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", input, ...trim, ...finalVideoArgs({ codec, fps }), outFile]);
  return outFile;
}
