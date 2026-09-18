import type { Note } from './notes'
import c3 from './piano/C3.mp3?url'
import c4 from './piano/C4.mp3?url'
import c5 from './piano/C5.mp3?url'
import c6 from './piano/C6.mp3?url'

const SAMPLES = [
  { midi: 48, url: c3 },
  { midi: 60, url: c4 },
  { midi: 72, url: c5 },
  { midi: 84, url: c6 },
]
const RELEASE = 1.5
const PEAK = 0.25
const VOLUME = 0.8
const ORIGINAL_GAIN = 0.9
const SAMPLE_RATE = 16000

export type Source = 'original' | 'piano' | 'both'

interface Sample {
  midi: number
  buffer: AudioBuffer
  gain: number
}

interface Voice {
  source: AudioBufferSourceNode
  gain: GainNode
}

export function createPlayer(onTick: (t: number) => void, onEnd: () => void) {
  let ctx: AudioContext | null = null
  let master: GainNode | null = null
  let samples: Sample[] | null = null
  let loading: Promise<Sample[]> | null = null
  let voices: Voice[] = []
  let raf: number | null = null
  let session = 0
  let originalTake: Float32Array | null = null
  let originalBuffer: AudioBuffer | null = null

  async function load(context: AudioContext) {
    if (samples) return samples
    loading ??= Promise.all(
      SAMPLES.map(async ({ midi, url }) => {
        const buffer = await context.decodeAudioData(await (await fetch(url)).arrayBuffer())
        let peak = 0
        for (let c = 0; c < buffer.numberOfChannels; c++) {
          for (const v of buffer.getChannelData(c)) peak = Math.max(peak, Math.abs(v))
        }
        return { midi, buffer, gain: peak > 0 ? PEAK / peak : 0 }
      }),
    ).then((loaded) => (samples = loaded)).catch((error) => {
      loading = null
      throw error
    })
    return loading
  }

  function nearest(midi: number, loaded: Sample[]) {
    let best = loaded[0]
    for (const s of loaded) {
      const d = Math.abs(midi - s.midi)
      const bestD = Math.abs(midi - best.midi)
      if (d < bestD || (d === bestD && s.midi < best.midi)) best = s
    }
    return best
  }

  function stop() {
    session++
    if (raf !== null) cancelAnimationFrame(raf)
    raf = null
    if (ctx) {
      const now = ctx.currentTime
      for (const { source, gain } of voices) {
        gain.gain.cancelScheduledValues(now)
        gain.gain.setTargetAtTime(0, now, 0.01)
        source.stop(now + 0.05)
      }
    }
    voices = []
  }

  function original(context: AudioContext, take: Float32Array) {
    if (originalTake !== take || !originalBuffer) {
      originalBuffer = context.createBuffer(1, take.length, SAMPLE_RATE)
      originalBuffer.getChannelData(0).set(take)
      originalTake = take
    }
    return originalBuffer
  }

  async function start(notes: Note[], duration: number, from: number, take: Float32Array | null, source: Source) {
    stop()
    const mine = ++session
    ctx ??= new AudioContext()
    master ??= (() => {
      const g = ctx.createGain()
      g.gain.value = VOLUME
      g.connect(ctx.destination)
      return g
    })()
    const context = ctx
    const out = master
    const [loaded] = await Promise.all([source === 'original' ? [] : load(context), context.resume()])
    if (mine !== session) return
    const t0 = context.currentTime + 0.05
    if (source !== 'piano' && take && from < take.length / SAMPLE_RATE) {
      const node = context.createBufferSource()
      node.buffer = original(context, take)
      const gain = context.createGain()
      gain.gain.value = ORIGINAL_GAIN
      node.connect(gain)
      gain.connect(out)
      node.start(t0, from)
      voices.push({ source: node, gain })
    }
    for (const note of source === 'original' ? [] : notes) {
      if (note.end <= from) continue
      const sample = nearest(note.pitch_midi, loaded)
      const rate = 2 ** ((note.pitch_midi - sample.midi) / 12)
      const at = t0 + Math.max(0, note.start - from)
      const offset = Math.max(0, from - note.start) * rate
      const releaseAt = t0 + note.end - from
      const source = context.createBufferSource()
      source.buffer = sample.buffer
      source.playbackRate.value = rate
      const gain = context.createGain()
      gain.gain.setValueAtTime(sample.gain, at)
      gain.gain.setValueAtTime(sample.gain, releaseAt)
      gain.gain.exponentialRampToValueAtTime(sample.gain * 0.001, releaseAt + RELEASE)
      source.connect(gain)
      gain.connect(out)
      source.start(at, Math.min(offset, sample.buffer.duration))
      source.stop(releaseAt + RELEASE)
      voices.push({ source, gain })
    }
    const tick = () => {
      if (mine !== session) return
      const t = Math.min(duration, from + Math.max(0, context.currentTime - t0))
      onTick(t)
      if (t >= duration) {
        stop()
        onEnd()
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
  }

  return { start, stop, playing: () => raf !== null }
}
