# record-flow

A Claude Code plugin that lets any agent **record a video of an app's UI flow,
verify it, and hand it to the user**. It is project-agnostic and works locally,
in CI and in Claude Code cloud sessions.

- **Browser** (web apps; the only option in cloud containers): Playwright +
  Chromium at phone size, captured in true device pixels (390×844 @3 →
  1170×2532), so text stays sharp.
- **iOS simulator** (macOS + Xcode): `xcrun simctl io recordVideo` with a clean
  SIGINT stop, driven by Maestro or by any tool between `start` and `stop`.
- **Inspection is built in and mandatory**: ffprobe, blank-frame and
  `blackdetect` checks, a grey-padding detector, expected size and pixel
  density, a contact sheet and a per-tap sheet the agent must look at.
- **Output**: one H.264 MP4 (yuv420p, `+faststart`, even dimensions, CFR 30)
  plus `proof.json` (command, URL, environment, timestamped step log), in a run
  directory outside the project tree.

The agent-facing instructions are in
[skills/record-flow/SKILL.md](skills/record-flow/SKILL.md).

## Install: local sessions

In Claude Code:

```
/plugin marketplace add patryk-reba/record-flow
/plugin install record-flow@record-flow
```

or from a shell:

```bash
claude plugin marketplace add patryk-reba/record-flow
claude plugin install record-flow@record-flow
```

Needs Node ≥ 18. Playwright, a Chromium binary and ffmpeg are found or fetched
on first use (see [environments](skills/record-flow/reference/environments.md)).

## Install: cloud sessions (Claude Code on the web)

`~/.claude` doesn't persist into cloud sessions, and cloud sessions **don't**
install plugins that a repo enables through `enabledPlugins` /
`extraKnownMarketplaces` in `.claude/settings.json`. Use one of these instead:

**1. Environment setup script (recommended).** In the cloud environment's
settings, add to the setup script (runs before the session and is cached):

```bash
claude plugin marketplace add patryk-reba/record-flow
claude plugin install record-flow@record-flow
```

**2. SessionStart hook in the project.** Commit this to the repo's
`.claude/settings.json`. It runs only in cloud sessions
(`CLAUDE_CODE_REMOTE=true`):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "[ \"$CLAUDE_CODE_REMOTE\" = true ] && { claude plugin marketplace add patryk-reba/record-flow >/dev/null 2>&1; claude plugin install record-flow@record-flow >/dev/null 2>&1; git clone -q --depth 1 https://github.com/patryk-reba/record-flow \"$HOME/.cache/record-flow-plugin\" 2>/dev/null; } ; exit 0"
          }
        ]
      }
    ]
  }
}
```

The hook also clones the repo to `~/.cache/record-flow-plugin`. Plugins load
when a session starts, so a plugin installed by the hook may only show up on the
next session or resume. The clone works right away: a project skill can point
the agent at `~/.cache/record-flow-plugin/skills/record-flow/SKILL.md` and its
scripts when `/record-flow:record-flow` isn't listed.

github.com is on the cloud environments' default network allowlist. With
network access set to "None", neither option works.

The cloud image ships Chromium under `/opt/pw-browsers`. The recorder uses that
build with an explicit `executablePath` when the Playwright version doesn't
match, so it downloads nothing.

## Quick try

```bash
node skills/record-flow/scripts/record.mjs skills/record-flow/examples/counter.flow.json
```

## Layout

```
.claude-plugin/        plugin.json + marketplace.json (this repo is its own marketplace)
skills/record-flow/
  SKILL.md             the workflow the agent follows
  scripts/record.mjs   browser recorder (and dispatcher to sim.mjs)
  scripts/sim.mjs      iOS simulator recorder
  scripts/inspect.mjs  inspection: checks + contact sheet + taps sheet + full frames
  scripts/lib/         dependency resolution, encoding, tap overlay, run dirs
  reference/           flow format, standalone harness, iOS details, environments
  examples/            a fixture page and flow
```

## License

MIT
