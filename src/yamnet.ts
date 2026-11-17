// Gong/round detection using YAMNet (AudioSet, 521 classes) run in-browser
// via onnxruntime-web. The mel-spectrogram frontend is baked into the graph, so
// input is raw 16 kHz mono PCM and no feature extraction is reimplemented here.
//
// Outputs per-frame class scores; a frame covers 0.96 s and advances 0.48 s.
// We score the "gong / bell" family of AudioSet classes, threshold, and cluster
// the resulting frames into onset timestamps (seconds).
import * as ort from "onnxruntime-web";

const ORT_VERSION = "1.31.1";
const MODEL_URL =
  "https://huggingface.co/audiomagic/yamnet-onnx/resolve/main/yamnet.onnx";
const ORT_WASM_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

export const YAMNET_SAMPLE_RATE = 16000;
const FRAME_HOP_SEC = 0.48;
const FRAME_HOP_SAMPLES = Math.round(YAMNET_SAMPLE_RATE * FRAME_HOP_SEC);

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
  const totalChunks = Math.max(1, Math.ceil(total / step));
  onProgress?.(0, totalChunks);

  const hits: number[] = [];
  const topClassNames: string[] = [];

  let chunkIndex = 0;
  for (let offset = 0; offset < total; offset += step) {
    const end = Math.min(offset + chunkSamples, total);
    const length = end - offset;
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
      topClassNames.push(`${GONG_CLASSES[topIdx] ?? `class ${topIdx}`} (${topScore.toFixed(2)})`);
      if (gong >= threshold) hits.push(time);
    }

    chunkIndex++;
    log(`YAMNet chunk ${chunkIndex}: ${(offset / YAMNET_SAMPLE_RATE).toFixed(0)}s–${(end / YAMNET_SAMPLE_RATE).toFixed(0)}s`);
    onProgress?.(chunkIndex, totalChunks);
  }

  hits.sort((a, b) => a - b);
  const onsets: number[] = [];
  for (const t of hits) {
    if (onsets.length && t - onsets[onsets.length - 1] < minGapSec) continue;
    onsets.push(t);
  }

  return { onsets, topClassNames };
}
