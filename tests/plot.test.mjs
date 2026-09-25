import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const service = moduleUrl(compile(await readFile(new URL('../src/ONNXService.ts', import.meta.url), 'utf8')))
const plotSource = compile(await readFile(new URL('../src/plot.ts', import.meta.url), 'utf8')).replace("'./ONNXService'", JSON.stringify(service))
const { renderPlot } = await import(moduleUrl(plotSource))

function render(frames) {
  const svg = { innerHTML: '', setAttribute() {}, querySelectorAll: () => [], querySelector: () => null }
  renderPlot(svg, { frames, notes: [], view: 'hz', now: 0, live: false, window: 6, width: 800, height: 340 })
  return svg.innerHTML
}

test('The compact pitch trace keeps unvoiced gaps instead of connecting across them', () => {
  const html = render({ pitch: [440, 441, 0, 523, 524], conf: [1, 1, 0, 1, 1] })
  const path = /class="pitch-line" d="([^"]*)"/.exec(html)[1]
  assert.equal((path.match(/M/g) ?? []).length, 2)
  assert.equal((path.match(/L/g) ?? []).length, 2)
})

test('A five-minute trace uses one path and preserves every connected frame', () => {
  const count = 18750
  const html = render({ pitch: new Float32Array(count).fill(440), conf: new Float32Array(count).fill(1) })
  const path = /class="pitch-line" d="([^"]*)"/.exec(html)[1]
  assert.equal((html.match(/class="pitch-line"/g) ?? []).length, 1)
  assert.equal((path.match(/L/g) ?? []).length, count - 1)
  assert.ok((html.match(/<line/g) ?? []).length < 20)
})
