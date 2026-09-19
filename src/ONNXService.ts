import type { Note } from './notes'

export interface InferenceResult {
  pitch_hz: Float32Array
  confidence: Float32Array
  notes: Note[]
}

export const SAMPLE_RATE = 16000
export const HOP = 256
export const FRAME_PERIOD = HOP / SAMPLE_RATE
export const FMIN = 46.875
export const FMAX = 2093.75
export const MODEL_VERSION = '0.2.0'

const LOAD_TIMEOUT_MS = 180_000

// Raised for every request once the worker is gone, so the app can tell a dead worker from a failed request.
export class WorkerLostError extends Error {}

export class ONNXService {
  private worker: Worker | null = null
  private loaded = false
  private nextId = 0
  private pending = new Map<number, { resolve: (data: any) => void; reject: (error: Error) => void }>()

  get ready() {
    return this.worker !== null && this.loaded
  }

  async load(): Promise<void> {
    if (this.ready) return
    this.fail(new WorkerLostError('Reloading'))
    const worker = new Worker(new URL('./onnx-worker.js', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent) => {
      const { id, ok, error, ...data } = e.data
      const request = this.pending.get(id)
      if (!request) return
      this.pending.delete(id)
      if (ok) request.resolve(data)
      else request.reject(new Error(error))
    }
    worker.onerror = (e: ErrorEvent) => {
      this.fail(new WorkerLostError(e.message || 'Worker error'))
    }
    this.worker = worker
    const timer = setTimeout(() => this.fail(new WorkerLostError('Model loading timed out')), LOAD_TIMEOUT_MS)
    try {
      await this.request({ type: 'load' })
      this.loaded = true
    } finally {
      clearTimeout(timer)
    }
  }

  setAudio(audio: Float32Array): Promise<void> {
    const copy = audio.slice()
    return this.request({ type: 'audio', audio: copy }, [copy.buffer])
  }

  async run(): Promise<InferenceResult> {
    const { pitch, confidence, notes } = await this.request({ type: 'run', fmin: FMIN, fmax: FMAX })
    return { pitch_hz: pitch, confidence, notes }
  }

  live(audio: Float32Array): Promise<{ pitch: Float32Array; confidence: Float32Array }> {
    return this.request({ type: 'live', audio, fmin: FMIN, fmax: FMAX }, [audio.buffer])
  }

  terminate() {
    this.fail(new WorkerLostError('Worker terminated'))
  }

  private request(message: object, transfer: Transferable[] = []): Promise<any> {
    if (!this.worker) return Promise.reject(new WorkerLostError('Worker is not initialized'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker!.postMessage({ id, ...message }, transfer)
    })
  }

  private fail(error: WorkerLostError) {
    this.loaded = false
    if (this.worker) {
      this.worker.terminate()
      this.worker = null
    }
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
  }
}
