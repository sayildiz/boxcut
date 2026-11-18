// Gong "fingerprint" matching.
//
// YAMNet recognises the first gong in a recording but can score an identical
// later gong near zero when the crowd/music bed changes. To avoid missing those
// repeats we learn the gong's narrowband partials from a detection the model is
// confident about, then scan the whole recording for moments where *all* of
// those partials rise together. In a boxing gym that signature (two or three
// stable tones that start together and ring) is specific enough that crowd
// noise, bag chains and clanks do not trigger it.

export type Fingerprint = {
  // Partials in Hz, strongest first.
  freqs: number[];
  // Prominence in dB of the strongest partial, for diagnostics/thresholding.
  strengthDb: number;
};

export type OnsetHit = { time: number; score: number };

const WINDOW = 2048; // 128 ms at 16 kHz
const SCAN_HOP = 512; // 32 ms
const MIN_PEAK_DB = 12; // narrowband peak above the local spectral floor
const MIN_PARTIAL_GAP_HZ = 150;
const MIN_MATCH_DB = 8; // every partial must rise this far above its baseline
const SUSTAIN_SEC = 0.35;
const BASELINE_DELAY_SEC = 1.5;
const BASELINE_SPAN_SEC = 4;

function hannWindow(size: number): Float32Array {
  const win = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  }
  return win;
}

function fftInPlace(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j];
        const ai = im[i + j];
        const br = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const bi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ar + br;
        im[i + j] = ai + bi;
        re[i + j + len / 2] = ar - br;
        im[i + j + len / 2] = ai - bi;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
}

/** Hann-windowed magnitude spectrum of one frame (normalised, linear). */
function magnitudes(
  pcm: Int16Array,
  sampleRate: number,
  startSample: number,
  window: Float32Array,
): Float32Array {
  const n = WINDOW;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = startSample + i < pcm.length ? pcm[startSample + i] / 32768 : 0;
    re[i] = s * window[i];
  }
  fftInPlace(re, im);
  const mags = new Float32Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    mags[k] = (Math.hypot(re[k], im[k]) * 2) / n;
  }
  return mags;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

/** Narrowband peaks that stand out from the local spectral floor. */
function findPartials(mags: Float32Array, sampleRate: number): Array<{ freq: number; db: number }> {
  const binHz = sampleRate / WINDOW;
  const lo = Math.max(2, Math.round(400 / binHz));
  const hi = Math.min(mags.length - 2, Math.round(5000 / binHz));
  const half = 24;
  const peaks: Array<{ freq: number; db: number }> = [];
  for (let k = lo; k <= hi; k++) {
    const value = mags[k];
    if (value <= 0) continue;
    if (value < mags[k - 1] || value < mags[k + 1]) continue;
    const floor = median(Array.from(mags.slice(Math.max(1, k - half), k + half + 1)));
    if (floor <= 0) continue;
    peaks.push({ freq: k * binHz, db: 20 * Math.log10(value / floor) });
  }
  peaks.sort((a, b) => b.db - a.db);

  const chosen: Array<{ freq: number; db: number }> = [];
  for (const peak of peaks) {
    if (peak.db < MIN_PEAK_DB) break;
    if (chosen.some((p) => Math.abs(p.freq - peak.freq) < MIN_PARTIAL_GAP_HZ)) continue;
    chosen.push(peak);
    if (chosen.length === 2) break;
  }
  return chosen;
}

/**
 * Learn the gong's partials from a detection the model is confident about.
 * YAMNet reports a frame centre that lags the physical strike, so we search the
 * ~1.2 s before `anchorSec` for the window with the strongest tonal peak.
 */
export function extractFingerprint(
  pcm: Int16Array,
  sampleRate: number,
  anchorSec: number,
): Fingerprint | null {
  const window = hannWindow(WINDOW);
  const startSearch = Math.max(0, Math.round((anchorSec - 1.2) * sampleRate));
  const endSearch = Math.min(
    Math.max(0, pcm.length - WINDOW),
    Math.round((anchorSec - 0.05) * sampleRate),
  );
  if (endSearch - startSearch < 0) return null;

  let best: { partials: Array<{ freq: number; db: number }> } | null = null;
  for (let start = startSearch; start <= endSearch; start += Math.round(0.1 * sampleRate)) {
    const partials = findPartials(magnitudes(pcm, sampleRate, start, window), sampleRate);
    if (partials.length < 2) continue;
    if (!best || partials[0].db > best.partials[0].db) best = { partials };
  }
  if (!best) return null;
  return {
    freqs: best.partials.map((p) => p.freq),
    strengthDb: best.partials[0].db,
  };
}

/** Magnitude of one frequency in a Hann-windowed frame (Goertzel). */
function goertzel(
  pcm: Int16Array,
  window: Float32Array,
  startSample: number,
  freq: number,
  sampleRate: number,
): number {
  const coeff = 2 * Math.cos((2 * Math.PI * freq) / sampleRate);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < WINDOW; i++) {
    const sample = startSample + i < pcm.length ? pcm[startSample + i] / 32768 : 0;
    const s0 = sample * window[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return Math.sqrt(Math.max(0, power)) * (2 / WINDOW);
}

/**
 * Find every moment where all of the fingerprint partials rise together above
 * their local baseline and stay up for at least ~0.35 s.
 */
export function findFingerprintMatches(
  pcm: Int16Array,
  sampleRate: number,
  fingerprint: Fingerprint,
): OnsetHit[] {
  const freqs = fingerprint.freqs;
  if (freqs.length === 0 || pcm.length < WINDOW) return [];
  const window = hannWindow(WINDOW);
  const frameSec = SCAN_HOP / sampleRate;
  const frameCount = Math.max(0, Math.floor((pcm.length - WINDOW) / SCAN_HOP) + 1);
  if (frameCount === 0) return [];

  const delayFrames = Math.round(BASELINE_DELAY_SEC / frameSec);
  const spanFrames = Math.round(BASELINE_SPAN_SEC / frameSec);

  // Per-partial deviation from its delayed baseline, in dB.
  const deviations: Float32Array[] = [];
  for (const freq of freqs) {
    const db = new Float32Array(frameCount);
    for (let i = 0; i < frameCount; i++) {
      const mag = goertzel(pcm, window, i * SCAN_HOP, freq, sampleRate);
      db[i] = 20 * Math.log10(mag + 1e-9);
    }
    const dev = new Float32Array(frameCount);
    const sorted: number[] = [];
    for (let i = 0; i < frameCount; i++) {
      const addIdx = i - delayFrames;
      if (addIdx >= 0) insertSorted(sorted, db[addIdx]);
      const removeIdx = addIdx - spanFrames;
      if (removeIdx >= 0) removeOneSorted(sorted, db[removeIdx]);
      const baseline = sorted.length > 0 ? sorted[sorted.length >> 1] : db[i];
      dev[i] = db[i] - baseline;
    }
    deviations.push(dev);
  }

  const scores = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    let worst = Infinity;
    for (const dev of deviations) worst = Math.min(worst, dev[i]);
    scores[i] = worst;
  }

  const minFrames = Math.max(1, Math.round(SUSTAIN_SEC / frameSec));
  const hits: OnsetHit[] = [];
  let i = 0;
  while (i < frameCount) {
    if (scores[i] < MIN_MATCH_DB) {
      i++;
      continue;
    }
    let end = i;
    let peak = scores[i];
    while (end < frameCount && scores[end] >= MIN_MATCH_DB) {
      if (scores[end] > peak) peak = scores[end];
      end++;
    }
    if (end - i >= minFrames) {
      const time = (i * SCAN_HOP + WINDOW / 2) / sampleRate;
      hits.push({ time, score: Math.min(0.95, 0.5 + peak / 40) });
    }
    i = end;
  }

  // Merge hits of the same bell (a long ring can drop below the threshold and
  // come back) and keep the strongest moment.
  hits.sort((a, b) => a.time - b.time);
  const merged: OnsetHit[] = [];
  for (const hit of hits) {
    const last = merged[merged.length - 1];
    if (last && hit.time - last.time < 1.5) {
      if (hit.score > last.score) {
        last.score = hit.score;
        last.time = hit.time;
      }
      continue;
    }
    merged.push({ ...hit });
  }
  return merged;
}

/** Combine two onset lists, keeping the stronger hit per strike. */
export function mergeOnsetHits(
  lists: OnsetHit[][],
  minGapSec: number,
): OnsetHit[] {
  const all = lists.flat().sort((a, b) => b.score - a.score);
  const kept: OnsetHit[] = [];
  for (const hit of all) {
    if (kept.some((k) => Math.abs(k.time - hit.time) < minGapSec)) continue;
    kept.push(hit);
  }
  return kept.sort((a, b) => a.time - b.time);
}

function insertSorted(arr: number[], value: number): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, value);
}

function removeOneSorted(arr: number[], value: number): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  if (lo < arr.length && arr[lo] === value) arr.splice(lo, 1);
}
