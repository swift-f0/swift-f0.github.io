// ONNXService.ts
export interface InferenceFeeds {
  /** Must match the ONNX model's input name */
  input_audio: number[]
}

export interface InferenceResult {
  pitch_hz: Float32Array
  confidence: Float32Array
  timestamps: Float32Array
}

export class ONNXService {
  private worker: Worker | null = null
  private modelLoaded = false
  private requestQueue: {
    feeds: InferenceFeeds
    resolve: (result: InferenceResult) => void
    reject: (error: Error) => void
  }[] = []
  private processingRequest = false

  constructor(private _modelFileName: string) {}

  get modelFileName(): string {
    return this._modelFileName
  }

  async initializeSession(): Promise<void> {
    if (this.worker) return
    this.worker = new Worker('/onnx-worker.js')
    this.worker.onmessage = this.handleWorkerMessages.bind(this)
    const modelPath = `${window.location.origin}/${this._modelFileName}`

    return new Promise<void>((resolve, reject) => {
      this.worker!.postMessage({ type: 'loadModel', modelPath })
      const checkModelLoaded = setInterval(() => {
        if (this.modelLoaded) {
          clearInterval(checkModelLoaded)
          resolve()
        }
      }, 100)
      setTimeout(() => {
        clearInterval(checkModelLoaded)
        reject(new Error('Model loading timed out'))
      }, 50_000)
    })
  }

  async runInference(feeds: InferenceFeeds): Promise<InferenceResult> {
    if (!this.worker) {
      throw new Error('Worker is not initialized')
    }

    return new Promise((resolve, reject) => {
      this.requestQueue.push({ feeds, resolve, reject })
      this.processNextRequest()
    })
  }

  private processNextRequest() {
    if (this.processingRequest || this.requestQueue.length === 0) return
    this.processingRequest = true
    const { feeds, resolve, reject } = this.requestQueue.shift()!
    this.worker!.postMessage({ type: 'run', feeds })

    // NOTE: we re‑attach onmessage here so that runInference calls resolve/reject in order
    this.worker!.onmessage = (e: MessageEvent) => {
      const { type, status, error, result } = e.data
      if (type === 'run') {
        if (status === 'success') {
          // Calculate timestamps (matches Python's calculate_timestamps)
          const nFrames = result.pitch_hz.length
          const timestamps = new Float32Array(nFrames)
          for (let i = 0; i < nFrames; i++) {
            timestamps[i] = (i * 256 + 127.5) / 16000
          }

          resolve({
            pitch_hz: new Float32Array(result.pitch_hz),
            confidence: new Float32Array(result.confidence),
            timestamps,
          })
        } else {
          reject(new Error(error))
        }
        this.processingRequest = false
        this.processNextRequest()
      }
    }
  }

  terminateWorker() {
    if (this.worker) {
      this.worker.terminate()
      this.worker = null
      this.modelLoaded = false
    }
  }

  private handleWorkerMessages(e: MessageEvent) {
    const { type, status, error } = e.data
    if (type === 'loadModel') {
      if (status === 'success') {
        this.modelLoaded = true
      } else {
        console.error('Error loading model in Web Worker:', error)
      }
    }
  }
}
