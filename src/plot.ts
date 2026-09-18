import type { Note } from './notes'
import { FRAME_PERIOD } from './ONNXService'

export type View = 'hz' | 'st' | 'notes'

export interface Frames {
  pitch: ArrayLike<number>
  conf: ArrayLike<number>
}

export interface Range {
  lo: number
  hi: number
  median: number
}

export interface PlotModel {
  frames: Frames
  notes: Note[]
  view: View
  now: number
  live: boolean
  window: number
  width: number
  height: number
  range?: Range | null
}

export interface PlotHandle {
  setNow(t: number): void
  setHover(t: number | null): void
  timeAt(clientX: number): number
}

const L = 58
const R = 14
const T = 16
const B = 36
const GREEN = '#53d22c'
const NAME_CHAR = 6.3
const MIN_LANE = 15
const MAX_HEIGHT = 520
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const SHARPS = new Set([1, 3, 6, 8, 10])

export function plotHeight(width: number) {
  return width < 600 ? 260 : 340
}

export function midi(f: number) {
  return 69 + 12 * Math.log2(f / 440)
}

export function noteName(m: number) {
  const r = Math.round(m)
  return NOTE_NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1)
}

function quantile(sorted: number[], q: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]
}

function laneLow(m: number) {
  return 440 * 2 ** ((m - 0.5 - 69) / 12)
}

function laneHigh(m: number) {
  return 440 * 2 ** ((m + 0.5 - 69) / 12)
}

export function voicedPitches(frames: Frames) {
  const out: number[] = []
  for (let i = 0; i < frames.pitch.length; i++) {
    if (frames.conf[i] >= 0.5 && frames.pitch[i] > 0) out.push(frames.pitch[i])
  }
  return out.sort((a, b) => a - b)
}

export function fitRange(sorted: number[], view: View): Range {
  const median = sorted.length ? quantile(sorted, 0.5) : 261.63
  let lo = Math.log2(sorted.length ? quantile(sorted, 0.02) : 130.81) - 2 / 12
  let hi = Math.log2(sorted.length ? quantile(sorted, 0.98) : 523.25) + 2 / 12
  if (hi - lo < 8 / 12) {
    const m = (hi + lo) / 2
    lo = m - 4 / 12
    hi = m + 4 / 12
  }
  if (view === 'st') {
    const lm = Math.log2(median)
    const half = Math.max(lm - lo, hi - lm)
    lo = lm - half
    hi = lm + half
  } else if (view === 'notes') {
    const mlo = Math.floor(midi(2 ** lo))
    const mhi = Math.ceil(midi(2 ** hi))
    lo = Math.log2(laneLow(mlo))
    hi = Math.log2(laneHigh(mhi))
  }
  return { lo, hi, median }
}

function timeStep(span: number, px: number) {
  return [0.5, 1, 2, 5, 10, 30, 60].find((s) => (s * px) / span >= 60) ?? 60
}

export function renderPlot(svg: SVGSVGElement, m: PlotModel): PlotHandle {
  const { frames, view, width: W } = m
  const duration = frames.pitch.length * FRAME_PERIOD
  const x0 = m.live ? Math.max(0, duration - m.window) : 0
  const x1 = m.live ? Math.max(m.window, duration) : Math.max(duration, 1e-9)
  const plotW = W - L - R
  const x = (t: number) => L + (plotW * (t - x0)) / (x1 - x0)
  const voiced = voicedPitches(frames)
  const sparse = voiced.length < 3
  const { lo, hi, median } = m.range ?? fitRange(sparse ? [] : voiced, view)
  const lanesRange = view === 'notes' ? { lo, hi } : fitRange(sparse ? [] : voiced, 'notes')
  const laneCount = Math.round(midi(2 ** lanesRange.hi) - 0.5) - Math.round(midi(2 ** lanesRange.lo) + 0.5) + 1
  const H = m.live || sparse ? m.height : Math.max(m.height, Math.min(MAX_HEIGHT, laneCount * MIN_LANE + T + B))
  const y = (f: number) => T + ((H - T - B) * (hi - Math.log2(f))) / (hi - lo)
  let s = `<rect x="${L}" y="${T}" width="${plotW}" height="${H - T - B}" fill="#131712"/>`

  if (view === 'notes') {
    const mlo = Math.round(midi(2 ** lo) + 0.5)
    const mhi = Math.round(midi(2 ** hi) - 0.5)
    const lanes = mhi - mlo + 1
    const laneH = (H - T - B) / lanes
    for (let n = mlo; n <= mhi; n++) {
      const pc = ((n % 12) + 12) % 12
      const sharp = SHARPS.has(pc)
      const top = y(laneHigh(n))
      s += `<rect x="${L}" y="${top.toFixed(1)}" width="${plotW}" height="${(y(laneLow(n)) - top).toFixed(1)}" fill="${sharp ? '#111510' : '#1a1f17'}"/>`
      s += `<line x1="${L}" x2="${W - R}" y1="${top.toFixed(1)}" y2="${top.toFixed(1)}" stroke="#232b21"/>`
      const labelled = lanes <= 18 ? true : laneH >= 17 ? !sharp : laneH >= 9 ? [0, 2, 4, 7, 9].includes(pc) : laneH >= 6 ? pc === 0 || pc === 7 : pc === 0
      if (labelled) {
        s += `<text x="${L - 8}" y="${(y(440 * 2 ** ((n - 69) / 12)) + 4).toFixed(1)}" text-anchor="end" class="tick">${noteName(n)}</text>`
      }
    }
  } else if (view === 'st') {
    const span = 12 * (hi - lo)
    const step = span > 24 ? 4 : span > 12 ? 2 : 1
    const smin = Math.ceil(12 * (lo - Math.log2(median)))
    const smax = Math.floor(12 * (hi - Math.log2(median)))
    for (let st = Math.ceil(smin / step) * step; st <= smax; st += step) {
      const yy = y(median * 2 ** (st / 12)).toFixed(1)
      s += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="#232b21"/>`
      s += `<text x="${L - 8}" y="${(+yy + 4).toFixed(1)}" text-anchor="end" class="tick">${st > 0 ? '+' : ''}${st} st</text>`
    }
    if (!sparse) {
      const ym = y(median).toFixed(1)
      s += `<line x1="${L}" x2="${W - R}" y1="${ym}" y2="${ym}" stroke="#b79bd6" stroke-dasharray="6 4"/>`
      s += `<text x="${W - R - 4}" y="${(+ym - 5).toFixed(1)}" text-anchor="end" class="tick" fill="#b79bd6">median ${median.toFixed(0)} Hz</text>`
    }
  } else {
    const fmin = 2 ** lo
    const fmax = 2 ** hi
    const step = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((v) => (fmax - fmin) / v <= 8) ?? 1000
    for (let f = Math.ceil(fmin / step) * step; f <= fmax; f += step) {
      const yy = y(f).toFixed(1)
      s += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="#232b21"/>`
      s += `<text x="${L - 8}" y="${(+yy + 4).toFixed(1)}" text-anchor="end" class="tick">${f} Hz</text>`
    }
  }

  s += `<clipPath id="plotclip"><rect x="${L}" y="${T}" width="${plotW}" height="${H - T - B}"/></clipPath><g clip-path="url(#plotclip)">`
  const labelRight = new Map<number, number>()
  let labels = ''
  for (const note of m.notes) {
    const n = Math.round(midi(note.pitch_median))
    const cents = Math.round(100 * (midi(note.pitch_median) - n))
    const top = y(laneHigh(n))
    const left = x(note.start)
    const w = x(note.end) - left
    const boxH = y(laneLow(n)) - top - 2
    s += `<rect data-start="${note.start}" data-end="${note.end}" x="${left.toFixed(1)}" y="${(top + 1).toFixed(1)}" width="${w.toFixed(1)}" height="${boxH.toFixed(1)}" rx="3" fill="#ffffff" fill-opacity="0.08" stroke="#ffffff" stroke-opacity="0.25"/>`
    const full = `${noteName(n)} ${cents >= 0 ? '+' : ''}${cents}c`
    const label = full.length * NAME_CHAR + 10 <= w ? full : noteName(n).length * NAME_CHAR + 8 <= w ? noteName(n) : ''
    if (!label || left < (labelRight.get(n) ?? -Infinity)) continue
    const inside = boxH >= 12
    const ty = inside ? top + 1 + boxH / 2 + 3.5 : top - 4
    labels += `<text x="${(left + 5).toFixed(1)}" y="${ty.toFixed(1)}" class="name">${label}</text>`
    labelRight.set(n, left + 5 + label.length * NAME_CHAR + 6)
  }
  s += '</g>'
  const ts = timeStep(x1 - x0, plotW)
  for (let t = Math.ceil(x0 / ts) * ts; t <= x1 + 1e-6; t += ts) {
    s += `<text x="${x(t).toFixed(1)}" y="${H - 12}" text-anchor="middle" class="tick">${t.toFixed(ts < 1 ? 1 : 0)} s</text>`
  }

  const { pitch, conf } = frames
  s += '<g clip-path="url(#plotclip)">'
  for (let i = 0; i < pitch.length; i++) {
    const t = i * FRAME_PERIOD
    if (t < x0 - FRAME_PERIOD) continue
    const voiced = conf[i] >= 0.5 && pitch[i] > 0
    if (i > 0 && voiced && conf[i - 1] >= 0.5 && pitch[i - 1] > 0) {
      s += `<line x1="${x(t - FRAME_PERIOD).toFixed(1)}" y1="${y(pitch[i - 1]).toFixed(1)}" x2="${x(t).toFixed(1)}" y2="${y(pitch[i]).toFixed(1)}" stroke="${GREEN}" stroke-width="2.2" stroke-linecap="round"/>`
    }
  }
  s += labels + '</g>'

  const cursor = m.live ? duration : m.now
  s += `<line id="hover" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="#e9efe4" stroke-opacity="0.35" visibility="hidden"/>`
  if (pitch.length > 0) {
    s += `<line id="playhead" x1="${x(cursor).toFixed(1)}" x2="${x(cursor).toFixed(1)}" y1="${T - 4}" y2="${H - B + 4}" stroke="${m.live ? '#d1442f' : '#e9efe4'}" stroke-width="1.5"/>`
  }

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.setAttribute('width', String(W))
  svg.setAttribute('height', String(H))
  svg.innerHTML = s

  const boxes = [...svg.querySelectorAll<SVGRectElement>('rect[data-start]')].map((el) => ({
    el,
    start: +el.dataset.start!,
    end: +el.dataset.end!,
  }))
  const handle: PlotHandle = {
    setNow(t) {
      const line = svg.querySelector('#playhead')
      if (!line) return
      const px = x(t)
      line.setAttribute('x1', px.toFixed(1))
      line.setAttribute('x2', px.toFixed(1))
      for (const box of boxes) {
        const on = t >= box.start && t < box.end
        box.el.setAttribute('fill', on ? GREEN : '#ffffff')
        box.el.setAttribute('fill-opacity', on ? '0.35' : '0.08')
        box.el.setAttribute('stroke', on ? GREEN : '#ffffff')
        box.el.setAttribute('stroke-opacity', on ? '0.9' : '0.25')
      }
    },
    setHover(t) {
      const line = svg.querySelector('#hover')
      if (!line) return
      if (t === null) {
        line.setAttribute('visibility', 'hidden')
        return
      }
      const px = x(t).toFixed(1)
      line.setAttribute('x1', px)
      line.setAttribute('x2', px)
      line.setAttribute('visibility', 'visible')
    },
    timeAt(clientX) {
      const r = svg.getBoundingClientRect()
      return x0 + (((clientX - r.left) / r.width) * W - L) * ((x1 - x0) / plotW)
    },
  }
  handle.setNow(m.live ? cursor - FRAME_PERIOD / 2 : cursor)
  return handle
}

export function tiles(frames: Frames, notes: Note[]) {
  const sorted = voicedPitches(frames)
  const midis = notes.map((note) => midi(note.pitch_median))
  const cents = midis.map((v) => Math.abs(100 * (v - Math.round(v))))
  return [
    { label: 'Median', value: sorted.length ? `${quantile(sorted, 0.5).toFixed(0)} Hz` : '-', hint: 'Median of the voiced pitch' },
    {
      label: 'Range',
      value: sorted.length ? `${(12 * Math.log2(quantile(sorted, 0.95) / quantile(sorted, 0.05))).toFixed(1)} st (${quantile(sorted, 0.05).toFixed(0)} to ${quantile(sorted, 0.95).toFixed(0)} Hz)` : '-',
      hint: 'Spread of the voiced pitch, from the 5th to the 95th percentile',
    },
    { label: 'Notes', value: String(notes.length), hint: 'Detected notes (at least 50 ms of steady pitch)' },
    { label: 'Lowest', value: notes.length ? noteName(Math.min(...midis)) : '-', hint: 'Lowest detected note' },
    { label: 'Highest', value: notes.length ? noteName(Math.max(...midis)) : '-', hint: 'Highest detected note' },
    {
      label: 'Off pitch',
      value: notes.length ? `${(cents.reduce((a, b) => a + b, 0) / cents.length).toFixed(0)} c` : '-',
      hint: 'Average distance of the notes from the nearest equal-tempered pitch at A = 440 Hz, in cents',
    },
  ]
}

export function readout(f: number, conf: number, view: View, median: number) {
  const low = conf < 0.5
  if (low || !(f > 0)) return { main: '-', small: '', low: true }
  if (view === 'notes') {
    const m = midi(f)
    const r = Math.round(m)
    const cents = Math.round(100 * (m - r))
    return { main: `${noteName(r)} ${cents >= 0 ? '+' : ''}${cents}c`, small: `${f.toFixed(0)} Hz`, low }
  }
  if (view === 'st') {
    const st = 12 * Math.log2(f / median)
    return { main: `${st >= 0 ? '+' : ''}${st.toFixed(1)} st`, small: `re ${median.toFixed(0)} Hz`, low }
  }
  return { main: `${f.toFixed(0)} Hz`, small: `conf ${conf.toFixed(2)}`, low }
}

export function medianPitch(frames: Frames) {
  const sorted = voicedPitches(frames)
  return sorted.length ? quantile(sorted, 0.5) : 200
}
