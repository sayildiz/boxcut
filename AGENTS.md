# AGENTS.md

## Package manager & commands
- Bun is the package manager (`bun.lock`, lockfileVersion 1). Use `bun install`; do not add npm/pnpm lockfiles. `node_modules` is not committed.
- Scripts (`bun run <script>`): `dev`, `build`, `preview`, `check`.
- Verification is `bun run check` only. There is **no** test suite, linter, or formatter configured — don't invent or expect them.
- `check` runs `svelte-check --tsconfig ./tsconfig.app.json && tsc -p tsconfig.node.json`. The `&&` means svelte-check must pass before the node tsc runs; fix app errors first.

## Architecture
- Single-page Svelte 5 app, no router and no backend. Entry: `src/main.ts` mounts `src/App.svelte` into `#app` in `index.html`.
- Essentially all behavior (UI, drag/drop, video cutting) lives in `src/App.svelte`. Expect to work there, not across many modules.
- Uses modern Svelte 5 APIs: `mount()` in main.ts and runes (`$state`, etc.) in components. Don't reintroduce Svelte 4 `on:event`/`export let` syntax.
- Two tsconfigs: `tsconfig.app.json` (covers `src/**`, `checkJs: true`) and `tsconfig.node.json` (strict, `noUnusedLocals`/`noUnusedParameters`, only `vite.config.ts`).

## ffmpeg.wasm quirks
- `@ffmpeg/ffmpeg` + `@ffmpeg/util` are npm deps, but the actual **core is loaded at runtime from a CDN**: `App.svelte`'s `load()` hardcodes `https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm` and uses `toBlobURL`. `@ffmpeg/core` is intentionally not in package.json. To change the core version, edit that URL in `App.svelte`, not the manifest.
- Runtime requires network access to that CDN; loading fails offline.
- ffmpeg's in-memory FS persists across runs, so `clearPreviousFiles()` deletes stale `output_*`/`input.*` before each transcode. Preserve this when touching transcode logic.

## Audio round detection (two backends in `src/`)
- `audioDetection.ts` = energy/loudness-peak detector on 8 kHz PCM (pure, `bun run test:detect`). Fails when the bell/gong is quieter than the crowd.
- `yamnet.ts` = YAMNet (AudioSet 521-class) via `onnxruntime-web`, 16 kHz PCM. The model's mel frontend is baked in, so input is raw waveform; output is per-0.48 s-frame class scores. The gong/bell class indices (172 Gong, 195 Bell, 196 Church bell, 173, 200, 202, 209) are hardcoded there.
- Both produce `number[]` onsets → `onsetsToRounds()` → the same review/cut UI. Audio is extracted at 8 kHz (energy) or 16 kHz (model) depending on the chosen backend.
- Cutting is two-phase: `transcodeDetected()` tries `-c copy`, then falls back to a fast `libx264`/`aac` re-encode per clip when copy yields no file (some codecs/containers can't stream-copy into mp4). `onsetsToRounds()` treats all intervals as rounds if every one looks like a break, so a misfire never leaves zero enabled clips.
- The model path needs ≥2 onsets to form any clip; with 1 onset the review panel shows a "lower the threshold" warning instead of silently hiding.
- Model + WASM runtime are CDN-loaded at runtime (mirrors the ffmpeg-core pattern): model from `https://huggingface.co/audiomagic/yamnet-onnx/resolve/main/yamnet.onnx`, wasm from `https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/`. Both serve `Access-Control-Allow-Origin: *`.
- `bun run build` bundles a ~29 MB `ort-wasm-simd-threaded.jsep.wasm` (WebGPU-only, unused with the `wasm` EP). Harmless but bloats the Docker image; the runtime wasm is fetched from the CDN.

## vite.config.ts — do not remove
- `base: './'` produces relative asset paths for static/subpath hosting.
- Dev server sets `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Opener-Policy: same-origin` — required for ffmpeg.wasm's SharedArrayBuffer. Removing them breaks video processing.
- `optimizeDeps.exclude` lists `@ffmpeg/ffmpeg` and `@ffmpeg/util` for the same reason.

## Docker (local testing)
- `docker compose up -d --build` builds a two-stage image (bun build → nginx) and publishes **host port 8080 → container port 80**. This bypasses the host firewall, which otherwise only allows port 22.
- `docker/nginx.conf` must keep the COOP/COEP headers — the Vite dev server sets them via `vite.config.ts`, but the built static site is served by nginx, so the headers have to be duplicated there or ffmpeg.wasm breaks.

## Deploy flow
- No deploy script in this repo. Pushing to `main` triggers `.github/workflows/notify-site.yml`, which POSTs a repository_dispatch (`event_type: boxcut-updated`) to `sayildiz/sayildiz.github.io` using secret `SITE_DISPATCH_TOKEN`. The external site repo builds/publishes; keep this in mind when changing output paths or `base`.
