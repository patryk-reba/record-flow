import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * A fresh run directory OUTSIDE the project's working tree (raw captures are
 * large and must never end up committed). `--out` / RECORD_FLOW_OUT override.
 */
export function makeRunDir(name, out) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const safe = String(name || "flow").replace(/[^a-z0-9._-]+/gi, "-").slice(0, 60);
  const base = out || process.env.RECORD_FLOW_OUT || path.join(os.tmpdir(), "record-flow");
  const dir = out ? path.resolve(out) : path.join(base, `${stamp}-${safe}`);
  fs.mkdirSync(path.join(dir, "raw"), { recursive: true });
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", cwd: dir });
  if (top.status === 0 && top.stdout.trim()) {
    console.error(`[record-flow] warning: run dir ${dir} is inside the git work tree ${top.stdout.trim()}`);
  }
  return dir;
}

export function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

/** `--k v`, `--k=v`; names in `booleans` never take a value. */
export function parseArgs(argv, booleans = []) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) args[k] = v;
      else if (!booleans.includes(k) && argv[i + 1] && !argv[i + 1].startsWith("--")) args[k] = argv[++i];
      else args[k] = true;
    } else args._.push(a);
  }
  return args;
}
