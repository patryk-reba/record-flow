// Resolves the tools a recording needs without assuming a machine layout:
// Playwright (project → plugin → global → cached install), a Chromium binary
// (Playwright's own → any preinstalled build → system Chrome), and an ffmpeg
// with an H.264 encoder (PATH → cached ffmpeg-static).
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_DIR = path.resolve(here, "../..");
const isWin = process.platform === "win32";

export function cacheDir() {
  const dir =
    process.env.RECORD_FLOW_CACHE ||
    (isWin
      ? path.join(process.env.LOCALAPPDATA || os.tmpdir(), "record-flow")
      : path.join(os.homedir(), ".cache", "record-flow"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function tryResolve(fromDir, name) {
  try {
    return createRequire(path.join(fromDir, "noop.js")).resolve(name);
  } catch {
    return null;
  }
}

function npmGlobalRoot() {
  try {
    return execFileSync(isWin ? "npm.cmd" : "npm", ["root", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function npmInstall(prefix, pkgs) {
  console.error(`[record-flow] installing ${pkgs.join(" ")} into ${prefix}`);
  const r = spawnSync(
    isWin ? "npm.cmd" : "npm",
    ["install", "--no-audit", "--no-fund", "--no-save", "--prefix", prefix, ...pkgs],
    {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
    },
  );
  if (r.status !== 0) throw new Error(`npm install ${pkgs.join(" ")} failed`);
}

/** Playwright's library, preferring the copy the project already pins. */
export async function loadPlaywright() {
  const roots = [process.cwd(), SKILL_DIR, npmGlobalRoot(), path.join(cacheDir(), "node_modules")];
  for (const root of roots.filter(Boolean)) {
    for (const name of ["playwright", "playwright-core"]) {
      const resolved =
        tryResolve(root, name) ?? (fs.existsSync(path.join(root, name)) ? path.join(root, name) : null);
      if (!resolved) continue;
      try {
        const req = createRequire(path.join(root, "noop.js"));
        const mod = req(resolved);
        const pkg = req(path.join(path.dirname(req.resolve(`${name}/package.json`, { paths: [root] })), "package.json"));
        return { playwright: mod, name, version: pkg.version, from: root };
      } catch {
        // try the next candidate
      }
    }
  }
  const prefix = cacheDir();
  npmInstall(prefix, ["playwright-core"]);
  const req = createRequire(path.join(prefix, "noop.js"));
  return {
    playwright: req("playwright-core"),
    name: "playwright-core",
    version: req("playwright-core/package.json").version,
    from: prefix,
  };
}

function buildNumber(p) {
  const m = p.match(/(?:chromium|chrome)[-_a-z]*-(\d+)/i);
  return m ? Number(m[1]) : 0;
}

/** Every Chromium-family executable this machine already has, newest build first. */
export function findChromiumExecutables() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    "/opt/pw-browsers",
    path.join(os.homedir(), ".cache", "ms-playwright"),
    path.join(os.homedir(), "Library", "Caches", "ms-playwright"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "ms-playwright"),
  ].filter((d) => d && d !== "0" && fs.existsSync(d));
  const rel = [
    "chrome-linux/chrome",
    "chrome-linux64/chrome",
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-win/chrome.exe",
    "chrome-win64/chrome.exe",
  ];
  const found = [];
  for (const root of roots) {
    for (const dir of fs.readdirSync(root)) {
      if (!/^chromium-\d+/.test(dir)) continue; // full browser only; headless_shell lacks GPU raster parity
      for (const r of rel) {
        const p = path.join(root, dir, r);
        if (fs.existsSync(p)) found.push(p);
      }
    }
  }
  found.sort((a, b) => buildNumber(b) - buildNumber(a));
  const system = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
  ].filter((p) => p && fs.existsSync(p));
  return [...found, ...system];
}

/**
 * Launch Chromium. Playwright's bundled build first; if it is missing (a
 * preinstalled browser that doesn't match this Playwright version, as in
 * cloud containers), fall back to an explicit `executablePath` rather than
 * downloading anything.
 */
export async function launchChromium(chromium, { headless = true, executablePath } = {}) {
  const args = ["--hide-scrollbars", "--force-color-profile=srgb"];
  const explicit = executablePath || process.env.RECORD_FLOW_CHROMIUM;
  if (explicit) {
    return { browser: await chromium.launch({ headless, executablePath: explicit, args }), executablePath: explicit };
  }
  try {
    const browser = await chromium.launch({ headless, args });
    return { browser, executablePath: chromium.executablePath() };
  } catch (err) {
    const errors = [String(err.message).split("\n")[0]];
    for (const exe of findChromiumExecutables()) {
      try {
        const browser = await chromium.launch({ headless, executablePath: exe, args });
        return { browser, executablePath: exe };
      } catch (e) {
        errors.push(`${exe}: ${String(e.message).split("\n")[0]}`);
      }
    }
    throw new Error(
      `No launchable Chromium found. Tried:\n  ${errors.join("\n  ")}\n` +
        "Set RECORD_FLOW_CHROMIUM=/path/to/chrome, or install one with `npx playwright install chromium`.",
    );
  }
}

function which(bin) {
  const r = spawnSync(isWin ? "where" : "which", [bin], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

function encoders(ffmpeg) {
  const r = spawnSync(ffmpeg, ["-hide_banner", "-encoders"], { encoding: "utf8" });
  return r.stdout || "";
}

/** ffmpeg + ffprobe paths and the best available H.264 encoder. */
export function resolveFfmpeg() {
  let ffmpeg = process.env.RECORD_FLOW_FFMPEG || which("ffmpeg");
  let ffprobe = process.env.RECORD_FLOW_FFPROBE || which("ffprobe");
  if (!ffmpeg || !ffprobe) {
    const prefix = cacheDir();
    const req = createRequire(path.join(prefix, "noop.js"));
    const load = () => ({ ffmpeg: req("ffmpeg-static"), ffprobe: req("ffprobe-static").path });
    let got;
    try {
      got = load();
    } catch {
      npmInstall(prefix, ["ffmpeg-static", "ffprobe-static"]);
      got = load();
    }
    ffmpeg ||= got.ffmpeg;
    ffprobe ||= got.ffprobe;
  }
  const enc = encoders(ffmpeg);
  const codec = ["libx264", "h264_videotoolbox", "libopenh264"].find((c) => enc.includes(` ${c} `));
  if (!codec) throw new Error(`${ffmpeg} has no H.264 encoder (libx264/h264_videotoolbox/libopenh264)`);
  const version = (spawnSync(ffmpeg, ["-version"], { encoding: "utf8" }).stdout || "").split("\n")[0];
  return { ffmpeg, ffprobe, codec, version };
}

export function h264Args(codec) {
  if (codec === "libx264") return ["-c:v", "libx264", "-preset", "slow", "-crf", "18", "-tune", "animation"];
  if (codec === "h264_videotoolbox") return ["-c:v", "h264_videotoolbox", "-b:v", "12M"];
  return ["-c:v", codec, "-b:v", "12M"];
}
