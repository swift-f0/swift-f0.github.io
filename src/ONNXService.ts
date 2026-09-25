import type { Note } from './notes'

export interface InferenceResult {
  pitch_hz: Float32Array
  confidence: Float32Array
  loudness_db: Float64Array
  notes: Note[]
}

export const SAMPLE_RATE = 16000
export const HOP = 256
export const FRAME_PERIOD = HOP / SAMPLE_RATE
export const FMIN = 46.875
export const FMAX = 2093.75
export const MODEL_VERSION = '0.3.0'

const LOAD_TIMEOUT_MS = 180_000

// Raised for every request once the worker is gone, so the app can tell a dead worker from a failed request.
export class WorkerLostError extends Error {}

export class ONNXService {
  private worker: Worker | null = null
  private loaded = false
  private nextId = 0
  private pending = new Map<number, { resolve: (data: any) => void; reject: (error: Error) => void; onProgress?: (fraction: number) => void }>()
  msPerSecond = 18

  get ready() {
    return this.worker !== null && this.loaded
  }

  async load(onStage?: (stage: 'downloading' | 'preparing') => void): Promise<void> {
    if (this.ready) return
    this.fail(new WorkerLostError('Reloading'))
    const worker = new Worker(new URL('./onnx-worker.js', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'load-stage') {
        onStage?.(e.data.stage)
        return
      }
      if (e.data.type === 'progress') {
        this.pending.get(e.data.id)?.onProgress?.(e.data.done / e.data.total)
        return
      }
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
      await this.measureRate()
    } finally {
      clearTimeout(timer)
    }
  }

  setAudio(audio: Float32Array): Promise<void> {
    const copy = audio.slice()
    return this.request({ type: 'audio', audio: copy }, [copy.buffer])
  }

  async run(pitchHoldMs: number, fmin: number, fmax: number, onProgress?: (fraction: number) => void): Promise<InferenceResult> {
    const { pitch, confidence, loudness, notes } = await this.request({ type: 'run', fmin, fmax, pitchHoldMs }, [], onProgress)
    return { pitch_hz: pitch, confidence, loudness_db: loudness, notes }
  }

  async segment(pitch: ArrayLike<number>, confidence: ArrayLike<number>, loudness: ArrayLike<number>, holds: number[]): Promise<Note[][]> {
    const { notes } = await this.request({ type: 'segment', pitch, confidence, loudness, holds })
    return notes
  }

  // The rate is measured once on a short silent buffer so the estimate follows the machine.
  private async measureRate() {
    const seconds = 2
    const started = performance.now()
    await this.request({ type: 'live', audio: new Float32Array(seconds * SAMPLE_RATE), fmin: FMIN, fmax: FMAX })
    this.msPerSecond = Math.max(1, (performance.now() - started) / seconds)
  }

  live(audio: Float32Array, fmin: number, fmax: number): Promise<{ pitch: Float32Array; confidence: Float32Array; loudness: Float64Array }> {
    return this.request({ type: 'live', audio, fmin, fmax }, [audio.buffer])
  }

  terminate() {
    this.fail(new WorkerLostError('Worker terminated'))
  }

  private request(message: object, transfer: Transferable[] = [], onProgress?: (fraction: number) => void): Promise<any> {
    if (!this.worker) return Promise.reject(new WorkerLostError('Worker is not initialized'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress })
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
