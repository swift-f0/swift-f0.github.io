import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../src/capture-worklet.js', import.meta.url), 'utf8')

function createProcessor() {
  const messages = []
  let Processor
  runInNewContext(source, {
    Float32Array,
    AudioWorkletProcessor: class {
      port = {
        postMessage(data, transfer = []) {
          messages.push(structuredClone(data, { transfer }))
        },
      }
    },
    registerProcessor(_name, constructor) {
      Processor = constructor
    },
  })
  return { processor: new Processor(), messages }
}

for (const length of [0, 64, 1600, 2304, 4800, 4801]) {
  test(`Stop preserves all ${length} samples and acknowledges them in order`, () => {
    const { processor, messages } = createProcessor()
    const input = Float32Array.from({ length }, (_, i) => i / 8192)
    for (let i = 0; i < length; i += 128) {
      processor.process([[input.subarray(i, i + 128)]])
    }
    // Capture continues to batch audio until Stop requests the remaining samples.
    assert.equal(messages.length, Math.floor(length / 1600))
    processor.port.onmessage({ data: 'stop' })
    assert.equal(messages.at(-1), 'stopped')
    assert.deepEqual(messages.slice(0, -1).flatMap(chunk => Array.from(chunk)), Array.from(input))

    const count = messages.length
    processor.port.onmessage({ data: 'stop' })
    assert.equal(processor.process([[new Float32Array(128)]]), false)
    assert.equal(messages.length, count, 'stopped capture must not emit duplicate or new samples')
  })
}
