// onnx-worker.js
importScripts('ort.min.js')

let ortSession = null

self.onmessage = async ({ data }) => {
  const { type, modelPath, feeds } = data

  try {
    if (type === 'loadModel') {
      // 1) create the session
      ortSession = await ort.InferenceSession.create(modelPath, {executionProviders: ['wasm']})

      // 2) tell the main thread we’re ready
      self.postMessage({ type: 'loadModel', status: 'success' })
    } else if (type === 'run' && ortSession) {
      // 3) run the model
      //    `feeds` must be an object like { input_audio: number[] }
      const results = await ortSession.run({
        input_audio: new ort.Tensor('float32', Float32Array.from(feeds.input_audio), [
          1,
          feeds.input_audio.length,
        ]),
      })

      // 4) send back exactly pitch_hz & confidence
      //    (and transfer their ArrayBuffers for zero copy)
      self.postMessage(
        {
          type: 'run',
          status: 'success',
          result: {
            pitch_hz: results.pitch_hz.data,
            confidence: results.confidence.data,
          },
        },
        [results.pitch_hz.data.buffer, results.confidence.data.buffer],
      )
    }
  } catch (err) {
    // bubble up any error
    self.postMessage({ type, status: 'error', error: err.message })
  }
}
