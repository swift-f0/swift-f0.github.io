import workletUrl from './capture-worklet.js?url&no-inline'
import { SAMPLE_RATE } from './ONNXService'

export interface Capture {
  stop(): Promise<Float32Array>
  seconds(): number
  take(start: number, end: number): Float32Array
}

// Band-limited resampling for a browser that refuses a 16 kHz audio context: every output sample
// is a windowed-sinc interpolation of the input, low-passed at the output Nyquist so that content
// above it cannot alias into the pitch range. The kernel spans 16 zero crossings each side.
function resampler(from: number, to: number) {
  const ratio = from / to
  const cutoff = Math.min(0.5, 0.5 / ratio)
  const halfTaps = Math.ceil(8 / cutoff)
  let carry = new Float32Array(0)
  let phase = 0
  return (chunk: Float32Array) => {
    const x = new Float32Array(carry.length + chunk.length)
    x.set(carry)
    x.set(chunk, carry.length)
    const out: number[] = []
    let p = phase
    while (p + halfTaps < x.length) {
      let acc = 0
      const k1 = Math.floor(p + halfTaps)
      for (let k = Math.max(0, Math.ceil(p - halfTaps)); k <= k1; k++) {
        const d = k - p
        const sinc = d === 0 ? 1 : Math.sin(2 * Math.PI * cutoff * d) / (2 * Math.PI * cutoff * d)
        acc += x[k] * sinc * (1 + Math.cos((Math.PI * d) / halfTaps))
      }
      out.push(acc * cutoff)
      p += ratio
    }
    const keepFrom = Math.max(0, Math.ceil(p - halfTaps))
    carry = x.slice(keepFrom)
    phase = p - keepFrom
    return Float32Array.from(out)
  }
}

export async function startCapture(onChunk: () => void): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true },
  })
  let ctx: AudioContext | undefined
  let source: MediaStreamAudioSourceNode | undefined
  let node: AudioNode | undefined
  let worklet: AudioWorkletNode | undefined
  const cleanup = async () => {
    stream.getTracks().forEach((track) => track.stop())
    source?.disconnect()
    node?.disconnect()
    worklet?.port.close()
    await ctx?.close().catch(() => {})
  }

  try {
    try {
      ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
      source = ctx.createMediaStreamSource(stream)
    } catch {
      await ctx?.close().catch(() => {})
      ctx = new AudioContext()
      source = ctx.createMediaStreamSource(stream)
    }
    const convert = ctx.sampleRate === SAMPLE_RATE ? null : resampler(ctx.sampleRate, SAMPLE_RATE)
    let buffer = new Float32Array(SAMPLE_RATE * 30)
    let length = 0

    const append = (chunk: Float32Array) => {
      const samples = convert ? convert(chunk) : chunk
      if (length + samples.length > buffer.length) {
        const grown = new Float32Array(Math.max(buffer.length * 2, length + samples.length))
        grown.set(buffer.subarray(0, length))
        buffer = grown
      }
      buffer.set(samples, length)
      length += samples.length
      onChunk()
    }

    let acknowledgeStop: (() => void) | null = null
    if (ctx.audioWorklet) {
      await ctx.audioWorklet.addModule(workletUrl)
      worklet = new AudioWorkletNode(ctx, 'capture')
      worklet.port.onmessage = (e: MessageEvent<Float32Array | 'stopped'>) => {
        if (e.data === 'stopped') acknowledgeStop?.()
        else append(e.data)
      }
      source.connect(worklet)
      node = worklet
    } else {
      const processor = ctx.createScriptProcessor(4096, 1, 1)
      processor.onaudioprocess = (e) => append(e.inputBuffer.getChannelData(0).slice())
      const silent = ctx.createGain()
      silent.gain.value = 0
      source.connect(processor)
      processor.connect(silent)
      silent.connect(ctx.destination)
      node = processor
    }
    await ctx.resume()

    let stopping: Promise<Float32Array> | null = null
    return {
      stop() {
        stopping ??= (async () => {
          let timeout: ReturnType<typeof setTimeout> | undefined
          try {
            stream.getTracks().forEach((track) => track.stop())
            source!.disconnect()
            if (worklet) {
              // Port messages are ordered: all samples arrive before the acknowledgement.
              await new Promise<void>((resolve) => {
                acknowledgeStop = resolve
                timeout = setTimeout(resolve, 2000)
                worklet!.port.postMessage('stop')
              })
            }
            return buffer.slice(0, length)
          } finally {
            clearTimeout(timeout)
            acknowledgeStop = null
            await cleanup()
          }
        })()
        return stopping
      },
      seconds: () => length / SAMPLE_RATE,
      take: (start, end) => buffer.slice(start, Math.min(end, length)),
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}
