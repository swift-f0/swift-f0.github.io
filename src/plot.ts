import type { Note } from './notes'
import { FMAX, FMIN, FRAME_PERIOD } from './ONNXService'

export type View = 'hz' | 'st' | 'notes'

export interface Frames {
  pitch: ArrayLike<number>
  conf: ArrayLike<number>
  loud: ArrayLike<number>
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
const NAME_CHAR = 6.6
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

function snapLanes(lo: number, hi: number) {
  return { lo: Math.log2(laneLow(Math.floor(midi(2 ** lo)))), hi: Math.log2(laneHigh(Math.ceil(midi(2 ** hi)))) }
}

export function voicedPitches(frames: Frames) {
  const out: number[] = []
  for (let i = 0; i < frames.pitch.length; i++) {
    if (frames.conf[i] >= 0.5 && frames.pitch[i] > 0 && Number.isFinite(frames.pitch[i])) out.push(frames.pitch[i])
  }
  return out.sort((a, b) => a - b)
}

export function fitRange(sorted: number[], view: View): Range {
  const centre = Math.sqrt(FMIN * FMAX)
  const median = sorted.length ? quantile(sorted, 0.5) : centre
  let lo = Math.log2(centre) - 1
  let hi = Math.log2(centre) + 1
  if (sorted.length) {
    lo = Math.log2(sorted[0]) - 2 / 12
    hi = Math.log2(sorted[sorted.length - 1]) + 2 / 12
  }
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
    ;({ lo, hi } = snapLanes(lo, hi))
  }
  return { lo, hi, median }
}

function timeStep(span: number, px: number) {
  return [0.5, 1, 2, 5, 10, 30, 60].find((s) => (s * px) / span >= 60) ?? 60
}

export function renderPlot(svg: SVGSVGElement, m: PlotModel): PlotHandle {
  const { frames, view, width: W, height: H } = m
  const duration = frames.pitch.length * FRAME_PERIOD
  const x0 = m.live ? Math.max(0, duration - m.window) : 0
  const x1 = m.live ? Math.max(m.window, duration) : Math.max(duration, 1e-9)
  const plotW = W - L - R
  const x = (t: number) => L + (plotW * (t - x0)) / (x1 - x0)
  const voiced = voicedPitches(frames)
  const sparse = voiced.length < 3
  const { lo, hi, median } = m.range ?? fitRange(voiced, view)
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
      const labelled = lanes <= 18 && laneH >= 11 ? true : laneH >= 17 ? !sharp : laneH >= 9 ? [0, 2, 4, 7, 9].includes(pc) : laneH >= 6 ? pc === 0 || pc === 7 : pc === 0
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
    // The axis is log spaced, so an even step crowds its rungs into the top once the span grows.
    // The decade ladder is tried first and kept when it has enough rungs to read.
    const ticks: number[] = []
    for (let e = 10 ** Math.floor(Math.log10(fmin)); e <= fmax; e *= 10) {
      for (const m of [1, 2, 5]) {
        if (m * e >= fmin && m * e <= fmax) ticks.push(m * e)
      }
    }
    if (ticks.length < 4) {
      ticks.length = 0
      const unit = 10 ** Math.floor(Math.log10((fmax - fmin) / 8))
      const step = [1, 2, 2.5, 5, 10].map((m) => m * unit).find((v) => (fmax - fmin) / v <= 8)!
      for (let k = Math.ceil(fmin / step); k <= Math.floor(fmax / step); k++) ticks.push(k * step)
    }
    for (const f of ticks) {
      const yy = y(f).toFixed(1)
      s += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="#232b21"/>`
      s += `<text x="${L - 8}" y="${(+yy + 4).toFixed(1)}" text-anchor="end" class="tick">${f} Hz</text>`
    }
  }

  s += `<clipPath id="plotclip"><rect x="${L}" y="${T}" width="${plotW}" height="${H - T - B}"/></clipPath><g clip-path="url(#plotclip)">`
  const labelRight = new Map<number, number>()
  let labels = ''
  for (const note of m.notes) {
    const n = Math.round(midi(note.pitch_hz))
    const cents = Math.round(100 * (midi(note.pitch_hz) - n))
    const top = y(laneHigh(n))
    const left = x(note.start) + 1
    const w = Math.max(1, x(note.end) - left - 1)
    const laneH = y(laneLow(n)) - top
    const inset = Math.min(1, laneH / 4)
    const boxH = laneH - 2 * inset
    s += `<rect data-start="${note.start}" data-end="${note.end}" x="${left.toFixed(1)}" y="${(top + inset).toFixed(1)}" width="${w.toFixed(1)}" height="${boxH.toFixed(1)}" rx="3" fill="#ffffff" fill-opacity="0.08" stroke="#ffffff" stroke-opacity="0.25"/>`
    const full = `${noteName(n)} ${cents >= 0 ? '+' : ''}${cents} c`
    const label = full.length * NAME_CHAR + 10 <= w ? full : noteName(n).length * NAME_CHAR + 8 <= w ? noteName(n) : ''
    if (!label || left < (labelRight.get(n) ?? -Infinity)) continue
    const inside = boxH >= 12
    // Thin lanes put labels above the note, or below it if the top edge has no room.
    const ty = inside ? top + inset + boxH / 2 + 3.5 : top - 4 >= T + 10 ? top - 4 : top + laneH + 12
    labels += `<text x="${(left + 5).toFixed(1)}" y="${ty.toFixed(1)}" class="name">${label}</text>`
    labelRight.set(n, left + 5 + label.length * NAME_CHAR + 6)
  }
  s += '</g>'
  const ts = timeStep(x1 - x0, plotW)
  for (let t = Math.ceil(x0 / ts) * ts; t <= x1 + 1e-6; t += ts) {
    const edge = x(t) + 20 > W
    s += `<text x="${(edge ? W - 2 : x(t)).toFixed(1)}" y="${H - 12}" text-anchor="${edge ? 'end' : 'middle'}" class="tick">${t.toFixed(ts < 1 ? 1 : 0)} s</text>`
  }

  const { pitch, conf } = frames
  s += '<g clip-path="url(#plotclip)">'
  let trace = ''
  let connected = false
  const drawn = (i: number) => i >= 0 && i < pitch.length && conf[i] >= 0.5 && pitch[i] > 0 && Number.isFinite(pitch[i])
  for (let i = 0; i < pitch.length; i++) {
    const t = i * FRAME_PERIOD
    if (t < x0 - FRAME_PERIOD) continue
    const inside = drawn(i)
    if (inside && drawn(i - 1)) {
      if (!connected) trace += `M${x(t - FRAME_PERIOD).toFixed(1)},${y(pitch[i - 1]).toFixed(1)}`
      trace += `L${x(t).toFixed(1)},${y(pitch[i]).toFixed(1)}`
      connected = true
    } else {
      connected = false
      // A frame with no drawn neighbour would otherwise be a line with nothing to join, so it is
      // a dot: a zero-length segment under the round cap the trace already uses.
      if (inside && !drawn(i + 1)) trace += `M${x(t).toFixed(1)},${y(pitch[i]).toFixed(1)}L${x(t).toFixed(1)},${y(pitch[i]).toFixed(1)}`
    }
  }
  s += `<path class="pitch-line" d="${trace}" fill="none" stroke="${GREEN}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`
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
  const midis = notes.map((note) => midi(note.pitch_hz))
  const cents = midis.map((v) => Math.abs(100 * (v - Math.round(v))))
  const low = sorted.length ? quantile(sorted, 0.05) : 0
  const high = sorted.length ? quantile(sorted, 0.95) : 0
  const span = Math.round(12 * Math.log2(high / low))
  const median = sorted.length ? quantile(sorted, 0.5) : 0
  const off = cents.reduce((a, b) => a + b, 0) / (cents.length || 1)
  return [
    {
      label: 'Median',
      value: sorted.length ? `${median.toFixed(0)} Hz` : '-',
      detail: sorted.length ? noteName(Math.round(midi(median))) : '',
    },
    {
      label: 'Spread',
      value: sorted.length ? `${low.toFixed(0)}\u2013${high.toFixed(0)} Hz` : '-',
      detail: sorted.length ? (span === 1 ? 'one semitone' : `${span} semitones`) : '',
    },
    {
      label: 'Notes',
      value: String(notes.length),
      detail: !notes.length
        ? ''
        : noteName(Math.min(...midis)) === noteName(Math.max(...midis))
          ? `at ${noteName(midis[0])}`
          : `${noteName(Math.min(...midis))} to ${noteName(Math.max(...midis))}`,
    },
    {
      label: 'Tuning',
      value: notes.length ? `${off.toFixed(0)} cents` : '-',
      detail: notes.length ? 'off the nearest note' : '',
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
    return { main: `${noteName(r)} ${cents >= 0 ? '+' : ''}${cents} c`, small: `${f.toFixed(0)} Hz`, low }
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
