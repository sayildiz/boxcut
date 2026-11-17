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
 * Turn raw bell onsets into clips. Boxing usually has a bell at round end and
 * another at round start, so a short interval (~break length) between two bells
 * marks a break; the longer intervals are the fights. When no such pattern is
 * found, every interval is treated as a round.
 */
export function onsetsToRounds(
  onsets: number[],
  expectedBreakSec: number,
): { intervals: Array<Segment & { isBreak: boolean }>; breakPatternFound: boolean } {
  const intervals: Array<Segment & { isBreak: boolean }> = []
  for (let i = 0; i < onsets.length - 1; i++) {
    intervals.push({ start: onsets[i], end: onsets[i + 1], isBreak: false })
  }
  if (intervals.length === 0) return { intervals, breakPatternFound: false }

  const durations = intervals.map((s) => s.end - s.start).sort((a, b) => a - b)
  const median = durations[durations.length >> 1]
  const low = expectedBreakSec * 0.5
  const high = expectedBreakSec * 1.75

  let breakCount = 0
  for (const interval of intervals) {
    const d = interval.end - interval.start
    if (d >= low && d <= high && d <= median * 1.1) {
      interval.isBreak = true
      breakCount++
    }
  }

  // If *every* interval looks like a break the heuristic misfired (there would
  // be no rounds left to cut). Fall back to treating them all as rounds.
  if (breakCount === 0 || breakCount === intervals.length) {
    for (const interval of intervals) interval.isBreak = false
    return { intervals, breakPatternFound: false }
  }
  return { intervals, breakPatternFound: true }
}
