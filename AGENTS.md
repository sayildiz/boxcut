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
- That single 0.48 s frame grid is alignment-sensitive: a short bell can land at a frame edge and score ~0.02, while the same bell scores ~0.8 when the grid is shifted a few hundred ms. So `detectGong()` runs three phase-shifted passes (1/3 hop apart), clusters the per-strike hits keeping the highest score, then applies `minGapSec`. Triples inference time (~19 s per 7 min of audio in Node WASM) but is what makes quiet bells detectable.
- `toneFingerprint.ts` = narrowband signature matcher that rescues repeats YAMNet is blind to (in the reference gym video the same gong scores 0.79, 0.001 and 0.24). `extractFingerprint(pcm, sr, anchorSec)` searches ~1.2 s before the strongest YAMNet hit (frame centres lag the strike) for the window with the strongest tonal peak and keeps the top two partials ≥150 Hz apart. `findFingerprintMatches()` then Goertzel-scans the whole recording (128 ms Hann window, 32 ms hop) and reports moments where *all* partials rise ≥8 dB above a delayed 4 s median baseline and stay up ≥0.35 s. Deterministic, no model, ~220 ms per 7 min. `mergeOnsetHits()` fuses both lists, keeping the stronger hit per `minGapSec`; fingerprint hits carry a pseudo-confidence of ~0.95 so they win the merge and the round/break pruning.
- Both produce onsets (model: times + per-onset scores) → `filterPlausibleOnsets()` → `onsetsToRounds()` → the same review/cut UI. Audio is extracted at 8 kHz (energy) or 16 kHz (model) depending on the chosen backend.
- `filterPlausibleOnsets(onsets, scores, roundSec, breakSec)` is what rejects false positives. A boxing session is rounds of ~`roundSec` separated by ~`breakSec` pauses, so every interval between consecutive onsets must be within ±20 % of the round length or ±30 % of the break length. Intervals that fit neither (a bag chain, clank, dropped weight) cause the least trustworthy bounding onset — lowest YAMNet score first, then best duration fit, then later time — to be dropped, iteratively. The UI exposes "Expected round length" (default 180 s) and "Expected break length" (default 60 s). If fewer than two onsets survive, there is no complete round: the panel shows a warning and no clips are produced (do not add a "just make something up" fallback).
- Cutting is two-phase: `transcodeDetected()` tries `-c copy`, then falls back to a fast `libx264`/`aac` re-encode per clip when copy yields no file (some codecs/containers can't stream-copy into mp4).
- `onsetsToRounds(onsets, roundSec, breakSec)` classifies each surviving interval by whichever expected duration it is nearer to (a ~60 s interval is a break, ~180 s is a round). There is no median/all-breaks fallback anymore; only `round` intervals become enabled clips, breaks are opt-in.
- Clips are materialised by `rebuildDetectedClips()` from the un-padded `detectedIntervals`. "Keep the closing gong audible" (default on, +2 s) extends each clip end, clamped to the video duration, so a 3:00 round is cut as 3:02 and the end gong is not chopped. Changing the toggle/tail re-derives clips without re-running detection; the intervals themselves stay un-padded so the round/break classification is unaffected.
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
