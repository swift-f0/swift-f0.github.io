import { FRAME_PERIOD } from './ONNXService'

export interface Note {
  start: number
  end: number
  pitch_hz: number
}

export function segmentNotes(
  pitch: ArrayLike<number>,
  confidence: ArrayLike<number>,
  loudness: ArrayLike<number>,
  pitchHoldMs = 80,
): Note[] {
  const n = pitch.length
  const m = new Float64Array(n)
  const w = new Float64Array(n)
  const q = new Float64Array(n)
  const observed: number[] = []
  for (let t = 0; t < n; t++) {
    if (Number.isFinite(pitch[t]) && pitch[t] > 0) {
      m[t] = 69 + 12 * Math.log2(pitch[t] / 440)
      w[t] = confidence[t]
      observed.push(Math.floor(m[t] * 100 + 0.5) / 100)
    }
    let left = -Infinity
    let right = -Infinity
    for (let j = 0; j < 5; j++) {
      let a = t - j
      while (a < 0 || a >= n) a = a < 0 ? -a - 1 : 2 * n - a - 1
      let b = t + j
      while (b < 0 || b >= n) b = b < 0 ? -b - 1 : 2 * n - b - 1
      left = Math.max(left, loudness[a])
      right = Math.max(right, loudness[b])
    }
    const cc = Math.min(Math.max(w[t], 0.01), 0.99)
    q[t] = -Math.log(cc / (1 - cc)) + Math.max(0, Math.min(left, right) - loudness[t] - 10 * Math.log10(2))
  }
  const mu = Float64Array.from(new Set(observed)).sort()
  const u = mu.length
  if (u === 0) return []
  const beta = pitchHoldMs / 1000 / FRAME_PERIOD
  const vn = new Float64Array(u).fill(Infinity)
  const noteStart = new Int32Array(u)
  const back = new Int32Array(n + 1)
  const kind = new Int32Array(n + 1).fill(-1)
  let best = 0
  for (let t = 0; t < n; t++) {
    const start = best + beta
    let j = 0
    for (let k = 0; k < u; k++) {
      if (start < vn[k]) {
        vn[k] = start
        noteStart[k] = t
      }
      vn[k] += w[t] * Math.min(Math.abs(mu[k] - m[t]), 2) + q[t]
      if (vn[k] < vn[j]) j = k
    }
    if (vn[j] < best) {
      best = vn[j]
      back[t + 1] = noteStart[j]
      kind[t + 1] = j
    } else {
      back[t + 1] = t
    }
  }
  const notes: Note[] = []
  for (let b = n; b > 0; ) {
    const a = back[b]
    if (kind[b] >= 0) {
      notes.push({ start: a * FRAME_PERIOD, end: (b - 1) * FRAME_PERIOD + FRAME_PERIOD, pitch_hz: 440 * 2 ** ((mu[kind[b]] - 69) / 12) })
    }
    b = a
  }
  return notes.reverse()
}
