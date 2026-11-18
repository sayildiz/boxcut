// Gong/round detection using YAMNet (AudioSet, 521 classes) run in-browser
// via onnxruntime-web. The mel-spectrogram frontend is baked into the graph, so
// input is raw 16 kHz mono PCM and no feature extraction is reimplemented here.
//
// Outputs per-frame class scores; a frame covers 0.96 s and advances 0.48 s.
// We score the "gong / bell" family of AudioSet classes, threshold, and cluster
// the resulting frames into onset timestamps (seconds).
//
// A single 0.48 s frame grid is alignment-sensitive: a short bell can fall at a
// frame edge and score near zero, then score highly when the grid is shifted by
// a few hundred ms. To avoid losing strikes to that lottery we run the model on
// three phase-shifted copies of the audio (hop/3 apart) and keep the best score
// per moment. That triples inference time but stabilises recall a lot.
import * as ort from "onnxruntime-web";

const ORT_VERSION = "1.31.1";
const MODEL_URL =
  "https://huggingface.co/audiomagic/yamnet-onnx/resolve/main/yamnet.onnx";
const ORT_WASM_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

export const YAMNET_SAMPLE_RATE = 16000;
const FRAME_HOP_SEC = 0.48;
const FRAME_HOP_SAMPLES = Math.round(YAMNET_SAMPLE_RATE * FRAME_HOP_SEC);
// Phase shifts (as fractions of the hop) used to make detection independent of
// where the model's 0.96 s analysis windows happen to land.
const PHASE_FRACTIONS = [0, 1 / 3, 2 / 3];

// AudioSet indices for the gong/bell family that marks a boxing round.
const GONG_CLASSES: Record<number, string> = {
  172: "Gong",
  173: "Tubular bells",
  195: "Bell",
  196: "Church bell",
  200: "Chime",
  202: "Change ringing",
  209: "Singing bowl",
};

export const YAMNET_CLASS_COUNT = 521;

let sessionPromise: Promise<ort.InferenceSession> | null = null;

function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    ort.env.wasm.wasmPaths = ORT_WASM_BASE;
    // Single-threaded keeps the WASM bootstrap simple; still SIMD-accelerated.
    ort.env.wasm.numThreads = 1;
    sessionPromise = ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ["wasm"],
    });
  }
  return sessionPromise;
}

export type YamnetResult = {
  onsets: number[];
  // Best gong-family score behind each onset (same order), used to decide which
  // onsets are real gongs when filtering against expected round lengths.
  onsetScores: number[];
  // Top predicted class per frame, for diagnostics.
  topClassNames: string[];
};

/**
 * Detect gong/bell onsets in 16 kHz mono s16le PCM.
 * `threshold` is a YAMNet sigmoid score in [0, 1]; `minGapSec` dedupes frames
 * belonging to the same strike.
 */
export async function detectGong(
  pcm: Int16Array,
  options: {
    threshold?: number;
    minGapSec?: number;
    log?: (msg: string) => void;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<YamnetResult> {
  const {
    threshold = 0.3,
    minGapSec = 2,
    log = console.log,
    onProgress,
  } = options;
  const session = await getSession();

  // Process in ~60 s chunks to bound memory; overlap so a strike at a chunk
  // boundary is still captured by a full frame.
  const chunkSec = 60;
  const chunkSamples = YAMNET_SAMPLE_RATE * chunkSec;
  const overlapSamples = Math.round(YAMNET_SAMPLE_RATE * 2);
  const step = chunkSamples - overlapSamples;
  const total = pcm.length;
  const phases = PHASE_FRACTIONS.map((f) => Math.round(FRAME_HOP_SAMPLES * f));
  const totalPasses = phases.reduce(
    (sum, shift) => sum + Math.max(1, Math.ceil((total - shift) / step)),
    0,
  );
  onProgress?.(0, totalPasses);

  const hits: Array<{ time: number; score: number }> = [];
  const topClassNames: string[] = [];

  let passIndex = 0;
  for (const phaseShift of phases) {
    for (let base = 0; base < total; base += step) {
      const offset = base + phaseShift;
      if (offset >= total) break;
      const end = Math.min(offset + chunkSamples, total);
      const length = end - offset;
      if (length < YAMNET_SAMPLE_RATE) break; // no full frame fits
      const wave = new Float32Array(length);
      for (let i = 0; i < length; i++) wave[i] = pcm[offset + i] / 32768;

      const tensor = new ort.Tensor("float32", wave, [length]);
      const results = await session.run({ waveform: tensor });
      const scores = results.output_0.data as Float32Array;
      const frames = scores.length / YAMNET_CLASS_COUNT;

      for (let f = 0; f < frames; f++) {
        const centerSamples = offset + f * FRAME_HOP_SAMPLES + FRAME_HOP_SAMPLES;
        if (centerSamples > total) continue; // skip the zero-padded tail frame
        const rowStart = f * YAMNET_CLASS_COUNT;
        const time = centerSamples / YAMNET_SAMPLE_RATE;

        let gong = 0;
        let topIdx = 0;
        let topScore = 0;
        for (let c = 0; c < YAMNET_CLASS_COUNT; c++) {
          const s = scores[rowStart + c];
          if (s > topScore) {
            topScore = s;
            topIdx = c;
          }
          if (c in GONG_CLASSES && s > gong) gong = s;
        }
        // Only the first pass feeds the diagnostic list, so its timestamps stay
        // on a single grid.
        if (phaseShift === phases[0]) {
          topClassNames.push(
            `${GONG_CLASSES[topIdx] ?? `class ${topIdx}`} (${topScore.toFixed(2)})`,
          );
        }
        if (gong >= threshold) hits.push({ time, score: gong });
      }

      passIndex++;
      log(`YAMNet pass ${passIndex}/${totalPasses}: ${(offset / YAMNET_SAMPLE_RATE).toFixed(0)}s–${(end / YAMNET_SAMPLE_RATE).toFixed(0)}s`);
      onProgress?.(passIndex, totalPasses);
    }
  }

  // The three passes can all report the same strike at slightly different
  // times. Collapse them into one candidate per strike (highest score wins),
  // then enforce the caller's minimum gap between strikes.
  const clusterSec = Math.min(minGapSec, FRAME_HOP_SEC * 1.5);
  hits.sort((a, b) => a.time - b.time);
  const clusters: Array<{ time: number; score: number; end: number }> = [];
  for (const hit of hits) {
    const last = clusters[clusters.length - 1];
    if (last && hit.time - last.end <= clusterSec) {
      last.end = hit.time;
      if (hit.score > last.score) {
        last.score = hit.score;
        last.time = hit.time;
      }
    } else {
      clusters.push({ ...hit, end: hit.time });
    }
  }

  const kept: typeof clusters = [];
  for (const cluster of [...clusters].sort((a, b) => b.score - a.score)) {
    if (kept.some((k) => Math.abs(k.time - cluster.time) < minGapSec)) continue;
    kept.push(cluster);
  }
  kept.sort((a, b) => a.time - b.time);
  const onsets = kept.map((c) => c.time);
  const onsetScores = kept.map((c) => c.score);

  return { onsets, onsetScores, topClassNames };
}
