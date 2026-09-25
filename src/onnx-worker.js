import * as ort from './ort/ort.wasm.min.mjs'
import loaderUrl from './ort/ort-wasm-simd-threaded.mjs?url'
import wasmUrl from './ort/ort-wasm-simd-threaded.wasm?url'
import modelUrl from './model.onnx?url'
import { segmentNotes } from './notes'

ort.env.wasm.numThreads = 1
ort.env.wasm.wasmPaths = { mjs: loaderUrl, wasm: wasmUrl }

let session = null
let audio = null

// The model's receptive field reaches 11 frames back and 10 frames forward, so a window fed with
// that much context returns the same frames a single pass would. Windows keep the wasm heap flat,
// which otherwise grows by 2.6 MB per second of audio and never shrinks.
const HOP = 256
const LEFT_FRAMES = 11
const LOOKAHEAD_FRAMES = 10
const WINDOW_FRAMES = 18750

async function download(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to load pitch detector (${response.status}). Please try again.`)
  return new Uint8Array(await response.arrayBuffer())
}

async function infer(samples, fmin, fmax) {
  if (!session) throw new Error('Model not loaded')
  const output = await session.run({
    audio: new ort.Tensor('float32', samples, [1, samples.length]),
    fmin: new ort.Tensor('float32', Float32Array.of(fmin), []),
    fmax: new ort.Tensor('float32', Float32Array.of(fmax), []),
  })
  return { pitch: Float32Array.from(output.pitch.data), confidence: new Float32Array(output.confidence.data) }
}

async function inferWindowed(samples, fmin, fmax, onProgress) {
  const total = Math.floor(samples.length / HOP)
  if (total <= WINDOW_FRAMES) {
    onProgress(total, total)
    return infer(samples, fmin, fmax)
  }
  const pitch = new Float32Array(total)
  const confidence = new Float32Array(total)
  for (let first = 0; first < total; first += WINDOW_FRAMES) {
    const last = Math.min(total, first + WINDOW_FRAMES)
    const left = Math.min(first, LEFT_FRAMES)
    const start = (first - left) * HOP
    const end = Math.min(samples.length, (last + LOOKAHEAD_FRAMES) * HOP)
    const part = await infer(samples.subarray(start, end), fmin, fmax)
    pitch.set(part.pitch.subarray(left, left + last - first), first)
    confidence.set(part.confidence.subarray(left, left + last - first), first)
    onProgress(last, total)
  }
  return { pitch, confidence }
}

function frameLoudness(samples, n) {
  const out = new Float64Array(n)
  let previous = 0
  for (let t = 0; t < n; t++) {
    let power = 0
    const end = Math.min(samples.length, (t + 1) * HOP)
    for (let i = t * HOP; i < end; i++) power += samples[i] * samples[i]
    out[t] = 20 * Math.log10(Math.max(Math.sqrt((previous + power) / 512), 1e-7))
    previous = power
  }
  return out
}

function gate(samples, confidence) {
  for (let i = 0; i < confidence.length; i++) {
    let peak = 0
    const end = Math.min(samples.length, (i + 1) * 256)
    for (let j = i * 256; j < end; j++) peak = Math.max(peak, Math.abs(samples[j]))
    if (peak < 1e-3) confidence[i] = 0
  }
}

self.onmessage = async ({ data }) => {
  const { id, type } = data
  try {
    if (type === 'load') {
      self.postMessage({ type: 'load-stage', stage: 'downloading' })
      const [model, wasm] = await Promise.all([download(modelUrl), download(wasmUrl)])
      self.postMessage({ type: 'load-stage', stage: 'preparing' })
      ort.env.wasm.wasmBinary = wasm
      session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] })
      delete ort.env.wasm.wasmBinary
      self.postMessage({ id, ok: true })
    } else if (type === 'audio') {
      audio = data.audio
      self.postMessage({ id, ok: true })
    } else if (type === 'run') {
      if (!audio) throw new Error('No audio loaded')
      const samples = audio
      const { pitch, confidence } = await inferWindowed(samples, data.fmin, data.fmax, (done, total) =>
        self.postMessage({ type: 'progress', id, done, total }))
      gate(samples, confidence)
      const loudness = frameLoudness(samples, pitch.length)
      const notes = segmentNotes(pitch, confidence, loudness, data.pitchHoldMs)
      self.postMessage({ id, ok: true, pitch, confidence, loudness, notes }, [pitch.buffer, confidence.buffer, loudness.buffer])
    } else if (type === 'live') {
      const { pitch, confidence } = await infer(data.audio, data.fmin, data.fmax)
      gate(data.audio, confidence)
      const loudness = frameLoudness(data.audio, pitch.length)
      self.postMessage({ id, ok: true, pitch, confidence, loudness }, [pitch.buffer, confidence.buffer, loudness.buffer])
    } else if (type === 'segment') {
      const notes = data.holds.map(hold => segmentNotes(data.pitch, data.confidence, data.loudness, hold))
      self.postMessage({ id, ok: true, notes })
    } else {
      throw new Error(`Unknown message type ${type}`)
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
