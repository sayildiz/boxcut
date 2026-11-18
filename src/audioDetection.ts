// Pure, dependency-free audio analysis for detecting boxing round bells.
// Operates on decoded mono PCM (Int16, little-endian) and never touches the DOM
// or ffmpeg, so it can be tested with synthetic buffers.

export type DetectConfig = {
  sampleRate: number
  windowSize: number // analysis window in samples
  hopSize: number // hop between windows in samples
  sensitivityDb: number // how far above the local noise floor a peak must be
  minGapSec: number // minimum spacing between accepted onsets
  clusterSec: number // maximum width of a single bell strike
}

export type Segment = { start: number; end: number }
export type EnvelopeFrame = { time: number; db: number }

export const DEFAULT_DETECT_CONFIG: DetectConfig = {
  sampleRate: 8000,
  windowSize: 512, // 64 ms at 8 kHz
  hopSize: 256, // 32 ms hop
  sensitivityDb: 8,
  minGapSec: 2,
  clusterSec: 1.5,
}

/** View raw s16le bytes (ffmpeg output) as Int16 samples. */
export function toInt16Array(bytes: Uint8Array): Int16Array {
  const samples = Math.floor(bytes.byteLength / 2)
  return new Int16Array(bytes.buffer, bytes.byteOffset, samples)
}

/** Short-time RMS loudness envelope, in dB, with a timestamp per frame. */
export function computeEnvelope(pcm: Int16Array, cfg: DetectConfig): EnvelopeFrame[] {
  const frames: EnvelopeFrame[] = []
  for (let start = 0; start + cfg.windowSize <= pcm.length; start += cfg.hopSize) {
    let sum = 0
    for (let i = 0; i < cfg.windowSize; i++) {
      const s = pcm[start + i] / 32768
      sum += s * s
    }
    const rms = Math.sqrt(sum / cfg.windowSize)
    frames.push({
      time: start / cfg.sampleRate,
      db: 20 * Math.log10(rms + 1e-7),
    })
  }
  return frames
}

function lowerBound(arr: number[], value: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

function insertSorted(arr: number[], value: number): void {
  arr.splice(lowerBound(arr, value), 0, value)
}

function removeOneSorted(arr: number[], value: number): void {
  const i = lowerBound(arr, value)
  if (i < arr.length && arr[i] === value) arr.splice(i, 1)
}

/**
 * Detect bell-like transients by comparing each frame's loudness to the median
 * of a delayed trailing window. The delay keeps the current bell out of its own
 * baseline; the median makes crowd/music level changes tolerable.
 */
export function detectBoundaries(pcm: Int16Array, cfg: DetectConfig): number[] {
  const env = computeEnvelope(pcm, cfg)
  const frameSec = cfg.hopSize / cfg.sampleRate
  const delayFrames = Math.max(1, Math.ceil((cfg.clusterSec + 0.5) / frameSec))
  const windowFrames = delayFrames + Math.max(8, Math.ceil(6 / frameSec))

  const sorted: number[] = []
  const candidateFrames: number[] = []

  for (let i = 0; i < env.length; i++) {
    const addIdx = i - delayFrames
    if (addIdx >= 0) insertSorted(sorted, env[addIdx].db)
    const removeIdx = i - windowFrames
    if (removeIdx >= 0) removeOneSorted(sorted, env[removeIdx].db)
    if (sorted.length < 10) continue
    const baseline = sorted[sorted.length >> 1]
    if (env[i].db - baseline >= cfg.sensitivityDb) candidateFrames.push(i)
  }

  // Group neighbouring loud frames into a single strike, then take its onset.
  const clusters: Array<{ startIdx: number; endIdx: number; peakDb: number }> = []
  for (const idx of candidateFrames) {
    const last = clusters[clusters.length - 1]
    if (last && idx - last.endIdx <= 1) {
      last.endIdx = idx
      last.peakDb = Math.max(last.peakDb, env[idx].db)
    } else {
      clusters.push({ startIdx: idx, endIdx: idx, peakDb: env[idx].db })
    }
  }

  const onsets: number[] = []
  for (const cluster of clusters) {
    const time = env[cluster.startIdx].time
    if (onsets.length && time - onsets[onsets.length - 1] < cfg.minGapSec) continue
    onsets.push(time)
  }
  return onsets
}

/**
 * Turn raw bell onsets into clips. In a real session a round lasts about
 * `roundSec` and the pause between rounds about `breakSec`, so every interval
 * is classified by whichever expected duration it is closer to.
 *
 * Callers are expected to run `filterPlausibleOnsets()` first, which removes
 * onsets whose intervals match neither duration (bag chains, clanks, ...).
 */
export function onsetsToRounds(
  onsets: number[],
  roundSec: number,
  breakSec: number,
): { intervals: Array<Segment & { isBreak: boolean }>; breakPatternFound: boolean } {
  const intervals: Array<Segment & { isBreak: boolean }> = []
  for (let i = 0; i < onsets.length - 1; i++) {
    intervals.push({ start: onsets[i], end: onsets[i + 1], isBreak: false })
  }
  if (intervals.length === 0) return { intervals, breakPatternFound: false }

  let breakPatternFound = false
  for (const interval of intervals) {
    const d = interval.end - interval.start
    const roundErr = Math.abs(d - roundSec) / roundSec
    const breakErr = breakSec > 0 ? Math.abs(d - breakSec) / breakSec : Infinity
    interval.isBreak = breakErr < roundErr
    if (interval.isBreak) breakPatternFound = true
  }
  return { intervals, breakPatternFound }
}

// How far a detected interval may deviate from the expected round/break length
// before its onsets are treated as false positives. A gong pair at 1:20 is not
// a 1:00 break; it is noise that happens to fall in between.
const ROUND_TOLERANCE = 0.2 // ±20 % of the expected round length
const BREAK_TOLERANCE = 0.3 // ±30 % of the expected break length

function intervalError(d: number, roundSec: number, breakSec: number): number {
  const roundErr = Math.abs(d - roundSec) / roundSec
  const breakErr = breakSec > 0 ? Math.abs(d - breakSec) / breakSec : Infinity
  return Math.min(roundErr, breakErr)
}

function isPlausibleInterval(d: number, roundSec: number, breakSec: number): boolean {
  if (Math.abs(d - roundSec) <= roundSec * ROUND_TOLERANCE) return true
  return Math.abs(d - breakSec) <= breakSec * BREAK_TOLERANCE
}

/**
 * Drop onsets that cannot be part of a round/break rhythm. A boxing session is
 * a sequence of ~`roundSec` rounds separated by ~`breakSec` pauses, so an
 * interval that matches neither is evidence of a false positive (a bag chain,
 * a clash, a dropped weight). Iteratively removes the least trustworthy onset
 * bounding such an interval: lowest detector score first, then the removal that
 * leaves the most plausible intervals.
 *
 * With fewer than two onsets left there is no complete round to cut, which is
 * the honest result for audio that contains only one real gong.
 */
export function filterPlausibleOnsets(
  onsets: number[],
  scores: number[] | undefined,
  roundSec: number,
  breakSec: number,
): { onsets: number[]; scores: number[]; rejected: number } {
  const items = onsets.map((time, i) => ({ time, score: scores?.[i] ?? 1 }))
  const rejected = onsets.length

  const badIntervalCount = (): number => {
    let count = 0
    for (let i = 0; i < items.length - 1; i++) {
      if (!isPlausibleInterval(items[i + 1].time - items[i].time, roundSec, breakSec)) count++
    }
    return count
  }

  const totalErrorWithout = (index: number): number => {
    let total = 0
    let prev: number | null = null
    for (let i = 0; i < items.length; i++) {
      if (i === index) continue
      const time = items[i].time
      if (prev !== null) total += intervalError(time - prev, roundSec, breakSec)
      prev = time
    }
    return total
  }

  while (items.length >= 2 && badIntervalCount() > 0) {
    const candidates = new Set<number>()
    for (let i = 0; i < items.length - 1; i++) {
      if (isPlausibleInterval(items[i + 1].time - items[i].time, roundSec, breakSec)) continue
      candidates.add(i)
      candidates.add(i + 1)
    }

    // Lowest score loses; on a score tie keep the removal that fits the
    // expected durations best, and prefer dropping the later onset.
    const rank = (index: number) => {
      const error = totalErrorWithout(index)
      return { score: items[index].score, error, time: items[index].time }
    }
    let victim = -1
    let best: ReturnType<typeof rank> | null = null
    for (const index of candidates) {
      const candidate = rank(index)
      const better =
        best === null ||
        candidate.score < best.score - 1e-9 ||
        (Math.abs(candidate.score - best.score) <= 1e-9 &&
          (candidate.error < best.error - 1e-9 ||
            (Math.abs(candidate.error - best.error) <= 1e-9 &&
              candidate.time > best.time)))
      if (better) {
        victim = index
        best = candidate
      }
    }
    items.splice(victim, 1)
  }

  return {
    onsets: items.map((item) => item.time),
    scores: items.map((item) => item.score),
    rejected: rejected - items.length,
  }
}
