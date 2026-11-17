// Deterministic smoke test for the pure detector (no browser/ffmpeg needed):
//   bun run test:detect
import {
  DEFAULT_DETECT_CONFIG,
  detectBoundaries,
  onsetsToRounds,
} from "../src/audioDetection"

const sampleRate = DEFAULT_DETECT_CONFIG.sampleRate
const durationSec = 120
const pcm = new Int16Array(sampleRate * durationSec)

// Quiet background "crowd/music" bed.
for (let i = 0; i < pcm.length; i++) {
  pcm[i] = Math.round(700 * Math.sin((2 * Math.PI * 100 * i) / sampleRate))
}

// Loud, decaying bell strikes at 10s, 40s (round end), 50s (round start), 80s.
for (const t of [10, 40, 50, 80]) {
  const start = Math.floor(t * sampleRate)
  for (let k = 0; k < sampleRate * 0.7; k++) {
    const decay = Math.exp(-k / (sampleRate * 0.12))
    pcm[start + k] = Math.round(
      26000 * decay * Math.sin((2 * Math.PI * 1000 * k) / sampleRate),
    )
  }
}

const onsets = detectBoundaries(pcm, DEFAULT_DETECT_CONFIG)
console.log("Detected onsets (s):", onsets.map((t) => t.toFixed(2)).join(", "))

const { intervals, breakPatternFound } = onsetsToRounds(onsets, 10)
console.log("Break pattern found:", breakPatternFound)
for (const [i, s] of intervals.entries()) {
  console.log(
    `  ${i + 1}: ${s.start.toFixed(1)} -> ${s.end.toFixed(1)} ` +
      `(${(s.end - s.start).toFixed(1)}s)${s.isBreak ? " [break]" : ""}`,
  )
}

if (onsets.length < 4) {
  console.error("FAIL: expected at least 4 onsets")
  process.exit(1)
}
console.log("OK")
