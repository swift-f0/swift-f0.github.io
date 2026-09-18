import * as ort from './ort/ort.wasm.min.mjs'
import loaderUrl from './ort/ort-wasm-simd-threaded.mjs?url'
import wasmUrl from './ort/ort-wasm-simd-threaded.wasm?url'
import modelUrl from './model.onnx?url'
import { segmentNotes } from './notes'

ort.env.wasm.numThreads = 1
ort.env.wasm.wasmPaths = { mjs: loaderUrl, wasm: wasmUrl }

let session = null
let audio = null

async function infer(samples, fmin, fmax) {
  if (!session) throw new Error('Model not loaded')
  const output = await session.run({
    audio: new ort.Tensor('float32', samples, [1, samples.length]),
    fmin: new ort.Tensor('float32', Float32Array.of(fmin), []),
    fmax: new ort.Tensor('float32', Float32Array.of(fmax), []),
  })
  return { pitch: Float32Array.from(output.pitch.data), confidence: new Float32Array(output.confidence.data) }
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
      session = await ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] })
      self.postMessage({ id, ok: true })
    } else if (type === 'audio') {
      audio = data.audio
      self.postMessage({ id, ok: true })
    } else if (type === 'run') {
      if (!audio) throw new Error('No audio loaded')
      const { pitch, confidence } = await infer(audio, data.fmin, data.fmax)
      gate(audio, confidence)
      const notes = segmentNotes(audio, pitch, confidence)
      self.postMessage({ id, ok: true, pitch, confidence, notes }, [pitch.buffer, confidence.buffer])
    } else if (type === 'live') {
      const { pitch, confidence } = await infer(data.audio, data.fmin, data.fmax)
      gate(data.audio, confidence)
      self.postMessage({ id, ok: true, pitch, confidence }, [pitch.buffer, confidence.buffer])
    } else {
      throw new Error(`Unknown message type ${type}`)
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
