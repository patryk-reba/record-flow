# Standalone harness: record one component without auth or a backend

When the screen you need sits behind sign-in, paywalls or live data, don't
script your way through the real app. Render the component alone with a
scratch Vite app that imports the project's own source. The component, its
styles and its assets are the real ones; only the shell around it is new.

## Layout

```
<harness>/            # a scratch dir; outside the repo, or committed under a skill dir
  vite.config.ts
  index.html
  main.tsx
  harness.css
  node_modules -> <repo>/node_modules   # symlink, only if <harness> is OUTSIDE the repo
```

Inside the repo, Node resolution walks up to `<repo>/node_modules` by itself.
Outside it, symlink `node_modules` so `react`, the router, etc. resolve to the
project's copies.

## vite.config.ts

```ts
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite"; // if the project uses Tailwind v4

const harness = import.meta.dirname;
const repo = "/abs/path/to/repo";

export default defineConfig({
  root: harness,
  publicDir: resolve(repo, "public"),       // the app's real assets
  envDir: harness,                           // don't load the app's .env (no analytics, no prod keys)
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [{ find: /^~\//, replacement: `${resolve(repo, "src")}/` }], // mirror tsconfig paths
    // one copy of anything with module-level state or React context
    dedupe: ["react", "react-dom", "@tanstack/react-router"],
  },
  define: { /* any compile-time globals the source expects, e.g. __APP_VERSION__ */ },
  server: {
    port: 5179,
    strictPort: true,
    // a symlinked node_modules lives outside the root: allow its real path
    fs: { allow: [repo, realpathSync(resolve(repo, "node_modules"))] },
  },
});
```

## harness.css (Tailwind v4)

```css
@import "/abs/path/to/repo/src/styles/main.css";
@source "/abs/path/to/repo/src";   /* scan the project's classes, not just the harness */
```

Without `@source` Tailwind only sees the harness files and most utility
classes are missing — the component renders unstyled.

## main.tsx

Render the component with the minimum providers its hooks require:

- **Router** — a memory history, a root route whose component is the harness:
  `createRouter({ routeTree: createRootRoute({ component: Harness }), history: createMemoryHistory({ initialEntries: ["/"] }) })`
- **Data client** (Convex, React Query, Apollo…) — a dummy client whose URL
  parses but is never queried; fully mocked components never hit it.
- **Theme** — if dark mode is a class, set it from `prefers-color-scheme` in
  `index.html` so the flow's `colorScheme` drives it.
- Give the end state a hook (`data-harness-exit`) so the flow can `expect` it.

## Run and record

```bash
pnpm exec vite --config <harness>/vite.config.ts     # from the repo root
node "${CLAUDE_SKILL_DIR}/scripts/record.mjs" flow.json --preflight
```

Watch the preflight console log (`console.json`): a 403 on `/@fs/…` means
`server.fs.allow` is missing a path; "Missing environment variable" means a
module reads `import.meta.env` at import time — add a `define` or a harness
`.env` with a dummy value.
