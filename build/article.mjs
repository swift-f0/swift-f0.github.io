import { readdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { parse } from '@vue/compiler-dom'

const require = createRequire(import.meta.url)
let engine
let queue = Promise.resolve()
const sources = new URL('../src/', import.meta.url)
const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function inline(src, kind, style, label) {
  const svg = readFileSync(new URL(src, sources), 'utf8').trim()
  return svg.replace(/^<svg\b([^>]*)>/, (_, attrs) => {
    const own = /\sstyle="([^"]*)"/.exec(attrs)?.[1]
    const rest = attrs.replace(/\sstyle="[^"]*"/, '').replace(/\saria-label="[^"]*"/, '')
    return `<svg class="${kind}" style="${[own, style].filter(Boolean).join(';')}" aria-label="${label}"${rest}>`
  })
}

function highlight(source) {
  const tokens = /(#[^\n]*)|("[^"]*")|\b(def|return|for|in|if|else|and|or|not|lambda|range)\b|\b(\d+(?:\.\d+)?(?:e-?\d+)?)\b/g
  let result = '', last = 0
  for (const match of source.matchAll(tokens)) {
    const kind = match[1] ? 'cm' : match[2] ? 'str' : match[3] ? 'kw' : 'num'
    result += escape(source.slice(last, match.index)) + `<span class="${kind}">${escape(match[0])}</span>`
    last = match.index + match[0].length
  }
  return result + escape(source.slice(last))
}

// Only repository-owned content is accepted. MathJax runs in Node, never in the browser.
export function renderArticle(source) {
  const render = async () => {
    engine ??= require('mathjax').init({
      loader: { load: ['input/tex', 'output/svg', 'a11y/assistive-mml'] },
      tex: { packages: { '[-]': ['noundefined'] } },
      svg: { fontCache: 'global' },
      startup: { typeset: false },
    })
    const math = await engine
    const adaptor = math.startup.adaptor
    math.startup.output.fontCache.clearCache()
    const edits = []
    const figures = new Map()
    const headings = new Map()
    const levels = []
    const attribute = (node, name) => node.props?.find(prop => prop.type === 6 && prop.name === name)?.value?.content
    function number(node) {
      if (node.type === 1 && node.tag === 'figure' && attribute(node, 'id')) figures.set(attribute(node, 'id'), figures.size + 1)
      if (node.type === 1 && node.tag === 'h3') {
        const section = /^\s*(\d+)\./.exec(node.children.map(child => child.content ?? '').join(''))
        levels.length = 0
        if (section) levels.push(Number(section[1]))
      }
      if (node.type === 1 && node.tag === 'h4' && levels.length && attribute(node, 'id')) {
        levels[1] = (levels[1] ?? 0) + 1
        headings.set(attribute(node, 'id'), levels.join('.'))
      }
      for (const child of node.children ?? []) number(child)
    }
    let figure = 0
    function visit(node) {
      const img = node.type === 1 && node.tag === 'picture' ? node.children.find(child => child.tag === 'img') : node.type === 1 && node.tag === 'img' ? node : undefined
      if (img && attribute(img, 'src')?.startsWith('./figures/')) {
        const style = attribute(img, 'style'), label = attribute(img, 'alt')
        const source = node.tag === 'picture' ? node.children.find(child => child.tag === 'source') : undefined
        const tall = source ? inline(attribute(source, 'srcset'), 'fig-tall', style, label) : ''
        edits.push({ start: node.loc.start.offset, end: node.loc.end.offset, html: inline(attribute(img, 'src'), 'fig-wide', style, label) + tall })
        return
      }
      if (node.type === 1 && node.tag === 'figure' && attribute(node, 'id')) figure = figures.get(attribute(node, 'id'))
      if (node.type === 1 && node.tag === 'figcaption' && figure) {
        const at = source.indexOf('>', node.loc.start.offset) + 1
        edits.push({ start: at, end: at, html: `<span class="fignum">Figure ${figure}.</span> ` })
      }
      if (node.type === 1 && node.tag === 'h4' && headings.has(attribute(node, 'id'))) {
        const at = source.indexOf('>', node.loc.start.offset) + 1
        edits.push({ start: at, end: at, html: `<span class="secnum">${headings.get(attribute(node, 'id'))}</span> ` })
      }
      const target = node.type === 1 && node.tag === 'a' ? attribute(node, 'href') : undefined
      if (target?.startsWith('#') && headings.has(target.slice(1)) && node.children.length) {
        const at = source.indexOf('>', node.loc.start.offset) + 1
        edits.push({ start: at, end: at, html: `${headings.get(target.slice(1))} ` })
      }
      if (target?.startsWith('#fig-')) {
        if (!figures.has(target.slice(1))) throw new Error(`Unknown figure reference: ${target}`)
        if (!node.children.length) {
          const at = node.loc.end.offset - '</a>'.length
          edits.push({ start: at, end: at, html: `Figure ${figures.get(target.slice(1))}` })
        }
      }
      if (node.type === 1 && node.tag === 'pre') {
        const text = node.children.map(child => child.content ?? '').join('')
        edits.push({ start: node.loc.start.offset, end: node.loc.end.offset,
          html: `<div class="code"><button type="button" class="copy" aria-label="Copy code" title="Copy code"><svg class="clip" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><svg class="check" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></button><pre tabindex="0" aria-label="Python example"><code>${highlight(text)}</code></pre></div>` })
        return
      }
      if (node.type === 2 && /\\[([]/.test(node.content)) {
        let result = '', last = 0
        for (const match of node.content.matchAll(/\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g)) {
          const tex = match[1] ?? match[2]
          const display = match[2] !== undefined
          let svg = adaptor.outerHTML(math.tex2svg(tex, { display }))
          if (/data-mjx-error|<merror/.test(svg)) throw new Error(`Cannot typeset article formula: ${tex}`)
          if (display) svg = svg.replace('<mjx-container ', '<mjx-container tabindex="0" ')
          result += escape(node.content.slice(last, match.index)) + svg
          last = match.index + match[0].length
        }
        result += escape(node.content.slice(last))
        edits.push({ start: node.loc.start.offset, end: node.loc.end.offset, html: result })
      }
      for (const child of node.children ?? []) visit(child)
    }
    const tree = parse(source, { comments: true })
    number(tree)
    visit(tree)
    for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
      source = source.slice(0, edit.start) + edit.html + source.slice(edit.end)
    }
    const styles = adaptor.outerHTML(math.startup.output.styleSheet(math.startup.document))
    const glyphs = adaptor.outerHTML(math.startup.output.fontCache.getCache())
    return `${styles}<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:none">${glyphs}</svg>${source}`
  }
  // Serialize rebuilds: each output must include a complete shared glyph cache.
  const result = queue.then(render)
  queue = result.catch(() => {})
  return result
}

export function articlePlugin() {
  return {
    name: 'static-article',
    enforce: 'pre',
    async load(id) {
      if (!id.endsWith('.article.html?article')) return
      const filename = id.slice(0, -'?article'.length)
      this.addWatchFile(filename)
      for (const name of readdirSync(resolve(dirname(filename), 'figures'))) this.addWatchFile(resolve(dirname(filename), 'figures', name))
      const html = await renderArticle(await readFile(filename, 'utf8'))
      const assets = new Map()
      const parts = html.split(/((?:src|srcset|href)="\.\/figures\/[^"<>]+")/g)
      const expression = parts.map(part => {
        const match = /^(src|srcset|href)="(.+)"$/.exec(part)
        if (!match) return JSON.stringify(part)
        const file = resolve(dirname(filename), match[2])
        if (!assets.has(file)) assets.set(file, `asset${assets.size}`)
        return `${JSON.stringify(`${match[1]}="`)} + ${assets.get(file)} + '\"'`
      }).join(' + ')
      const imports = [...assets].map(([file, name]) => `import ${name} from ${JSON.stringify(file + '?url&no-inline')};`).join('\n')
      return `${imports}\nexport default ${expression};`
    },
  }
}
