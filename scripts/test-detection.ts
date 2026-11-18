// Deterministic smoke test for the pure detector (no browser/ffmpeg needed):
//   bun run test:detect
import {
  DEFAULT_DETECT_CONFIG,
  detectBoundaries,
  filterPlausibleOnsets,
  onsetsToRounds,
} from "../src/audioDetection"
import {
  extractFingerprint,
  findFingerprintMatches,
} from "../src/toneFingerprint"

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

const mapped = onsetsToRounds(onsets, 30, 10)
console.log("Break pattern found:", mapped.breakPatternFound)
for (const [i, s] of mapped.intervals.entries()) {
  console.log(
    `  ${i + 1}: ${s.start.toFixed(1)} -> ${s.end.toFixed(1)} ` +
      `(${(s.end - s.start).toFixed(1)}s)${s.isBreak ? " [break]" : ""}`,
  )
}

// False-positive filtering: a bag-chain clank 150 s after a real round start
// matches neither a 180 s round nor a 60 s break and must be dropped.
const noisy = [10, 190, 300, 301.5]
const noisyScores = [0.8, 0.75, 0.28, 0.31]
const filtered = filterPlausibleOnsets(noisy, noisyScores, 180, 60)
console.log(`False-positive filter: kept ${JSON.stringify(filtered.onsets)}, rejected ${filtered.rejected}`)
if (filtered.rejected !== 2 || filtered.onsets.length !== 2) {
  console.error("FAIL: expected the two out-of-rhythm clanks to be rejected")
  process.exit(1)
}

if (onsets.length < 4) {
  console.error("FAIL: expected at least 4 onsets")
  process.exit(1)
}

// Tone-fingerprint matching: learn a chime's two partials from one hit and find
// an identical repeat later in the recording (the case YAMNet misses).
const toneRate = 16000
const tonePcm = new Int16Array(toneRate * 40)
let seed = 12345
for (let i = 0; i < tonePcm.length; i++) {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  tonePcm[i] = Math.round(120 * Math.sin((2 * Math.PI * 160 * i) / toneRate) + (seed % 200))
}
for (const t of [10, 25]) {
  const start = Math.floor(t * toneRate)
  for (let k = 0; k < toneRate * 1.4; k++) {
    const decay = Math.exp(-k / (toneRate * 0.4))
    const a = 6000 * decay * Math.sin((2 * Math.PI * 1270 * k) / toneRate)
    const b = 6000 * decay * Math.sin((2 * Math.PI * 2250 * k) / toneRate)
    tonePcm[start + k] = Math.round(tonePcm[start + k] + a + b)
  }
}
// YAMNet reports frame centres late, so anchor 1 s after the strike.
const printedAt = 11
const fingerprint = extractFingerprint(tonePcm, toneRate, printedAt)
const matches = fingerprint
  ? findFingerprintMatches(tonePcm, toneRate, fingerprint)
  : []
console.log(
  `Tone fingerprint: ${fingerprint ? fingerprint.freqs.map((f) => f.toFixed(0)).join(" + ") + " Hz" : "none"}` +
    ` -> ${matches.map((m) => m.time.toFixed(1)).join(", ")}`,
)
const near = (t: number) => matches.some((m) => Math.abs(m.time - t) < 0.3)
if (!fingerprint || !near(10) || !near(25)) {
  console.error("FAIL: expected fingerprint matches at 10s and 25s")
  process.exit(1)
}

console.log("OK")
