class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(1600)
    this.filled = 0
    this.stopped = false
    this.port.onmessage = ({ data }) => {
      if (data !== 'stop' || this.stopped) return
      this.stopped = true
      if (this.filled) {
        const tail = this.buffer.slice(0, this.filled)
        this.port.postMessage(tail, [tail.buffer])
        this.filled = 0
      }
      this.port.postMessage('stopped')
    }
  }

  process(inputs) {
    if (this.stopped) return false
    const input = inputs[0]?.[0]
    if (!input) return true
    let offset = 0
    while (offset < input.length) {
      const n = Math.min(input.length - offset, this.buffer.length - this.filled)
      this.buffer.set(input.subarray(offset, offset + n), this.filled)
      this.filled += n
      offset += n
      if (this.filled === this.buffer.length) {
        this.port.postMessage(this.buffer, [this.buffer.buffer])
        this.buffer = new Float32Array(1600)
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('capture', CaptureProcessor)
