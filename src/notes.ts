export interface Note {
  start: number
  end: number
  pitch_median: number
  pitch_midi: number
}

const SAMPLE_RATE = 16000
const FRAME_PERIOD = 256 / SAMPLE_RATE

function roundHalfEven(x: number) {
  const f = Math.floor(x)
  const r = x - f
  if (r < 0.5) return f
  if (r > 0.5) return f + 1
  return f % 2 === 0 ? f : f + 1
}

function median(values: number[]) {
  const s = [...values].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function framePeriod(t: Float64Array) {
  if (t.length < 2) return FRAME_PERIOD
  const diffs: number[] = []
  for (let i = 1; i < t.length; i++) diffs.push(t[i] - t[i - 1])
  const fp = median(diffs)
  if (fp <= 0 || diffs.some((d) => Math.abs(d - fp) > 1e-9 + 1e-7 * fp)) {
    throw new Error('timestamps must be strictly increasing and uniformly spaced')
  }
  return fp
}

function runs(indices: number[]) {
  const out: number[][] = []
  let current: number[] = []
  for (const i of indices) {
    if (current.length && i - current[current.length - 1] > 1) {
      out.push(current)
      current = []
    }
    current.push(i)
  }
  if (current.length) out.push(current)
  return out
}

function medianRuns(midi: Float64Array, width: number) {
  const out = Float64Array.from(midi)
  const finite: number[] = []
  for (let i = 0; i < midi.length; i++) if (Number.isFinite(midi[i])) finite.push(i)
  for (const run of runs(finite)) {
    if (run.length < 3) continue
    const k = Math.min(width, run.length | 1)
    if (k <= 1) continue
    const half = k >> 1
    const values = run.map((i) => midi[i])
    const padded = [...Array(half).fill(values[0]), ...values, ...Array(half).fill(values[values.length - 1])]
    for (let j = 0; j < run.length; j++) out[run[j]] = median(padded.slice(j, j + k))
  }
  return out
}

function riseGates(audio: Float32Array, t: Float64Array, fp: number) {
  const n = t.length
  let w = Math.max(2, roundHalfEven(0.064 * SAMPLE_RATE))
  if (w % 2) w += 1
  const half = w >> 1
  const power = new Float64Array(audio.length + w)
  for (let i = 0; i < audio.length; i++) power[half + i] = audio[i] * audio[i]
  const sums = new Float64Array(power.length + 1)
  for (let i = 0; i < power.length; i++) sums[i + 1] = sums[i] + power[i]
  const rms = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const start = Math.min(Math.max(roundHalfEven(t[i] * SAMPLE_RATE), 0), power.length - w)
    rms[i] = Math.sqrt(Math.max(0, (sums[start + w] - sums[start]) / w))
  }
  const lag = Math.max(1, roundHalfEven(0.032 / fp))
  const rising = new Uint8Array(n)
  for (let i = lag; i < n; i++) rising[i] = rms[i - lag] <= 0.6 * rms[i] && rms[i] > 1e-12 ? 1 : 0
  const gates = new Uint8Array(n)
  for (let i = 0; i < n; i++) gates[i] = rising[i] && !(i > 0 && rising[i - 1]) ? 1 : 0
  return gates
}

function changepoints(x: Float64Array, penalty: number): [number, number][] {
  const m = x.length
  if (m === 0) return []
  const s1 = new Float64Array(m + 1)
  const s2 = new Float64Array(m + 1)
  for (let i = 0; i < m; i++) {
    const v = x[i] - x[0]
    s1[i + 1] = s1[i] + v
    s2[i + 1] = s2[i] + v * v
  }
  const cost = new Float64Array(m + 1).fill(Infinity)
  cost[0] = 0
  const back = new Int32Array(m + 1)
  for (let end = 1; end <= m; end++) {
    let best = Infinity
    let k = 0
    for (let start = 0; start < end; start++) {
      const d = s1[end] - s1[start]
      const sse = Math.max(0, s2[end] - s2[start] - (d * d) / (end - start))
      const candidate = cost[start] + sse + penalty
      if (candidate < best) {
        best = candidate
        k = start
      }
    }
    cost[end] = best
    back[end] = k
  }
  const out: [number, number][] = []
  let end = m
  while (end) {
    const start = back[end]
    out.push([start, end])
    end = start
  }
  return out.reverse()
}

function finiteMedian(values: Float64Array, a: number, b: number) {
  const x: number[] = []
  for (let i = a; i < b; i++) if (Number.isFinite(values[i])) x.push(values[i])
  return x.length ? median(x) : NaN
}

export function segmentNotes(
  audio: Float32Array,
  pitch: ArrayLike<number>,
  confidence: ArrayLike<number>,
  lam = 250,
  minNoteDuration = 0.05,
): Note[] {
  const n = pitch.length
  if (n === 0) return []
  const t = new Float64Array(n)
  for (let i = 0; i < n; i++) t[i] = i * FRAME_PERIOD
  const fp = framePeriod(t)
  const medianWidth = 2 * roundHalfEven(0.032 / fp) + 1
  const startGuard = Math.max(1, roundHalfEven(0.032 / fp))
  const endGuard = Math.max(1, roundHalfEven(0.016 / fp))
  const maxGap = Math.floor(0.08 / fp + 1e-9)
  const minFrames = Math.max(1, Math.ceil(minNoteDuration / fp - 1e-9))
  const penalty = (lam * 0.016 ** 2) / fp

  const voiced = new Uint8Array(n)
  let on = false
  for (let i = 0; i < n; i++) {
    const valid = Number.isFinite(pitch[i]) && pitch[i] > 0 && Number.isFinite(confidence[i])
    on = valid && confidence[i] >= (on ? 0.3 : 0.5)
    voiced[i] = on ? 1 : 0
  }
  let midi = new Float64Array(n).fill(NaN)
  for (let i = 0; i < n; i++) if (voiced[i]) midi[i] = 69 + 12 * Math.log2(pitch[i] / 440)
  midi = medianRuns(midi, medianWidth)

  const gates = riseGates(audio, t, fp)

  const intervals: [number, number][] = []
  const voicedIdx: number[] = []
  for (let i = 0; i < n; i++) if (voiced[i]) voicedIdx.push(i)
  for (const run of runs(voicedIdx)) {
    const start = run[0]
    const end = run[run.length - 1] + 1
    const bounds = [start]
    for (let q = start + startGuard; q < end - endGuard; q++) if (gates[q]) bounds.push(q)
    bounds.push(end)
    for (let j = 0; j + 1 < bounds.length; j++) {
      const left = bounds[j]
      for (const [a, b] of changepoints(midi.subarray(left, bounds[j + 1]), penalty)) {
        intervals.push([left + a, left + b])
      }
    }
  }

  const merged: [number, number][] = []
  for (const [a, b] of intervals) {
    if (merged.length) {
      const [left, end] = merged[merged.length - 1]
      const p1 = finiteMedian(midi, left, end)
      const p2 = finiteMedian(midi, a, b)
      let contradicts = false
      for (let i = end; i < a; i++) {
        if (Number.isFinite(midi[i]) && Math.abs(midi[i] - p1) >= 0.5) contradicts = true
      }
      let isProtected = false
      for (let i = Math.max(left + 1, end - 1); i < Math.min(n, a + 2); i++) if (gates[i]) isProtected = true
      if (a - end <= maxGap && Math.abs(p1 - p2) < 0.5 && !contradicts && !isProtected) {
        merged[merged.length - 1] = [left, b]
        continue
      }
    }
    merged.push([a, b])
  }

  const notes: Note[] = []
  for (const [a, b] of merged) {
    const x: number[] = []
    for (let i = a; i < b; i++) if (Number.isFinite(midi[i])) x.push(midi[i])
    if (x.length < minFrames) continue
    const midiMedian = median(x)
    notes.push({
      start: t[a],
      end: t[b - 1] + fp,
      pitch_median: 440 * 2 ** ((midiMedian - 69) / 12),
      pitch_midi: roundHalfEven(midiMedian),
    })
  }
  return notes
}
