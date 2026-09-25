import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { renderArticle } from '../build/article.mjs'

test('All article equations retain their glyphs and accessible MathML across rebuilds', async () => {
  const source = await readFile(new URL('../src/how-it-works.article.html', import.meta.url), 'utf8')
  for (let i = 0; i < 2; i++) {
    const html = await renderArticle(source)
    assert.equal([...html.matchAll(/<mjx-container\b/g)].length, 226)
    assert.equal([...html.matchAll(/<mjx-assistive-mml\b/g)].length, 226)
    assert.equal([...html.matchAll(/<svg class="fig-wide"/g)].length, 8)
    assert.equal([...html.matchAll(/<svg class="fig-tall"/g)].length, 3)
    assert.equal([...html.matchAll(/<pre\b/g)].length, 5)
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]))
    for (const [, target] of html.matchAll(/xlink:href="#([^"]+)"/g)) {
      assert.ok(ids.has(target), `Missing SVG glyph ${target} on build ${i + 1}`)
    }
    assert.doesNotMatch(html, /data-mjx-error|<script\b/)
  }
})

test('Article generation escapes code and fails the build on invalid math', async () => {
  const html = await renderArticle('<pre>if x &lt; 2:\n  return "&lt;b&gt;"</pre>')
  assert.match(html, /&lt;b&gt;/)
  assert.doesNotMatch(html, /<b>/)
  await assert.rejects(renderArticle('<p>\\(\\notARealCommand{x}\\)</p>'), /Cannot typeset/)
  assert.match(await renderArticle('<p>\\(x^2\\)</p>'), /<mjx-container/)
})
