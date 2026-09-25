<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import article from './how-it-works.article.html?article'

const root = ref<HTMLElement | null>(null)
const copyStatus = ref('')
const copyTimers = new WeakMap<HTMLButtonElement, number>()
let ticking = false
let marked: HTMLAnchorElement | null = null

async function followSection() {
  const id = decodeURIComponent(location.hash.slice(1))
  if (!id) return
  await nextTick()
  const target = document.getElementById(id)
  if (!target || !root.value?.contains(target)) return
  root.value.classList.add('settling')
  let last = NaN
  for (let i = 0; i < 10; i++) {
    target.scrollIntoView({ block: 'start' })
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const top = target.getBoundingClientRect().top
    if (Math.abs(top - last) < 1) break
    last = top
  }
  root.value?.classList.remove('settling')
  target.focus({ preventScroll: true })
}

// The current entry is the last heading above the reading line. An IntersectionObserver would
// wake up less often, but a band thin enough to name one heading is skipped on a fast scroll.
function markCurrent() {
  ticking = false
  const el = root.value
  if (!el) return
  const links = el.querySelectorAll<HTMLAnchorElement>('.article-toc a')
  const bar = window.matchMedia('(max-width: 900px)').matches ? el.querySelector('.article-toc') : document.querySelector('.site-header')
  const line = (bar?.getBoundingClientRect().bottom ?? 56) + 40
  let current: HTMLAnchorElement | null = null
  for (const link of links) {
    const heading = document.getElementById(link.hash.slice(1))
    if (heading && heading.getBoundingClientRect().top <= line) current = link
  }
  if (current === marked) return
  marked?.removeAttribute('aria-current')
  current?.setAttribute('aria-current', 'location')
  marked = current
  if (current && window.matchMedia('(max-width: 900px)').matches) {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const chip = current.offsetParent ? current : current.closest('li')?.parentElement?.closest('li')?.querySelector('a')
    chip?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: reduced ? 'auto' : 'smooth' })
  }
}

async function onCopy(event: MouseEvent) {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button.copy')
  const code = button?.closest('.code')?.querySelector('code')
  if (!button || !code) return
  copyStatus.value = ''
  let copied = true
  try {
    await navigator.clipboard.writeText(code.textContent ?? '')
  } catch {
    copied = false
    const range = document.createRange()
    range.selectNodeContents(code)
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(range)
  }
  await nextTick()
  copyStatus.value = copied ? 'Code copied' : 'Code selected, press Ctrl+C to copy'
  if (!copied) return
  button.classList.add('done')
  clearTimeout(copyTimers.get(button))
  copyTimers.set(button, window.setTimeout(() => button.classList.remove('done'), 2000))
}

function onScroll() {
  if (ticking) return
  ticking = true
  requestAnimationFrame(markCurrent)
}

onMounted(() => {
  void followSection()
  markCurrent()
  window.addEventListener('hashchange', followSection)
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', onScroll)
})
onUnmounted(() => {
  window.removeEventListener('hashchange', followSection)
  window.removeEventListener('scroll', onScroll)
  window.removeEventListener('resize', onScroll)
})
</script>

<template>
  <article ref="root" class="card article" aria-labelledby="how-title" v-html="article" @click="onCopy"></article>
  <p class="copy-status" aria-live="polite">{{ copyStatus }}</p>
</template>

<style>
.article { --measure: 680px; --kicker: 200px; --gap: 32px; display: grid; grid-template-columns: var(--kicker) minmax(0, 1fr); column-gap: var(--gap); }
.article > h2, .article > .how { grid-column: 2; }
.article > h2 { max-width: var(--measure); }
.article-toc { grid-column: 1; grid-row: 1 / span 2; align-self: start; position: sticky; top: calc(var(--header-h, 56px) + 16px); display: flex; flex-direction: column; gap: 10px; font-size: 14px; max-height: calc(100vh - var(--header-h, 56px) - 40px); overflow-y: auto; scrollbar-width: thin; }
.toc-title { margin: 0; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 4px; }
.article .toc-list, .article .toc-sub { display: flex; flex-direction: column; gap: 0; list-style: none; margin: 0; padding: 0; }
.article .toc-list { border-left: 2px solid var(--line); }
.article .toc-sub { display: none; font-size: 13px; }
.article .toc-list > li:has(a[aria-current]) .toc-sub { display: flex; }
.article .article-toc a { display: block; color: var(--ink-soft); text-decoration: none; padding: 5px 0 5px 14px; margin-left: -2px; border-left: 2px solid transparent; }
.article .toc-list > li > a { font-weight: 600; }
.article .toc-sub a { padding-left: 26px; font-weight: 400; color: var(--muted); }
.article-toc a:hover { color: var(--ink); border-color: var(--muted); }
.article-toc a[aria-current] { color: var(--ink); border-color: var(--green); }
.article .toc-list > li:has(.toc-sub a[aria-current]) > a { color: var(--ink); }
.how-section { display: grid; grid-template-columns: [text-start] minmax(0, var(--measure)) [text-end gutter-start] minmax(0, 1fr) [gutter-end]; column-gap: var(--gap); }
.how-section > * { grid-column: text; min-width: 0; }
.how-section > .diagram { grid-column: text-start / gutter-end; max-width: 100%; }
@media (max-width: 900px) {
  .article, .how-section { display: block; }
  .article .toc-list { flex-direction: row; gap: 0 16px; border-left: 0; }
  .article .toc-list > li:has(a[aria-current]) .toc-sub { display: none; }
  .article-toc { position: sticky; top: var(--header-h, 56px); z-index: 2; flex-direction: row; gap: 0 16px; max-height: none; margin: 0 calc(-1 * clamp(18px, 3vw, 32px)) 24px; padding: 12px clamp(18px, 3vw, 32px); background: var(--panel); border-bottom: 1px solid var(--line); overflow-x: auto; white-space: nowrap; scrollbar-width: none; }
  .toc-title { display: none; }
  .article .article-toc a { padding: 0 0 2px; margin-left: 0; border-left: 0; border-bottom: 2px solid transparent; }
  .article .article-toc a[aria-current],
  .article .toc-list > li:has(.toc-sub a[aria-current]) > a { color: var(--ink); border-bottom-color: var(--green); }
}
.how-section { content-visibility: auto; contain-intrinsic-size: auto 1600px; }
.how-section.overview, .settling .how-section { content-visibility: visible; }
.how p, .how ol, .how ul { margin: 0 0 18px; color: var(--ink-soft); font-size: 16px; line-height: 1.75; overflow-wrap: break-word; }
.how ul, .how ol { padding-left: 24px; }
.how ol { list-style: decimal; }
.how ul { list-style: disc; }
.how li { margin: 5px 0; }
.how h3 { font-size: 22px; font-weight: 700; margin: 36px 0 18px; padding-top: 20px; border-top: 1px solid var(--line); scroll-margin-top: calc(var(--header-h, 56px) + 16px); }
.how h4 { font-size: 17px; font-weight: 600; color: var(--ink); margin: 30px 0 14px; scroll-margin-top: calc(var(--header-h, 56px) + 16px); }
.how h3 + h4 { margin-top: 24px; }
.how .secnum { color: var(--ink-soft); font-variant-numeric: tabular-nums; }
.article a { text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 4px; }
.article a:hover { text-decoration-color: var(--green); color: var(--ink); }
.how p a { color: var(--ink); }
.diagram { margin: 24px 0; scroll-margin-top: calc(var(--header-h, 56px) + 16px); }
@media (max-width: 900px) {
  .how h3, .how h4, .diagram { scroll-margin-top: calc(var(--header-h, 56px) + 56px); }
}
.diagram-scroll { overflow-x: auto; overscroll-behavior-x: contain; border-radius: 8px; scrollbar-width: thin; }
.diagram svg { display: block; width: min(100%, var(--diagram-width)); min-width: var(--diagram-min); max-width: none; height: auto; }
.diagram .fig-tall { display: none; }
.diagram figcaption { max-width: var(--measure); margin-top: 10px; font-size: 13px; line-height: 1.5; color: var(--muted); }
.diagram figcaption .fignum { color: var(--ink); }
.how table.steps tr.hl td { background: var(--raised); color: var(--ink); }
.how table.steps { display: block; overflow-x: auto; width: max-content; max-width: min(100%, var(--measure)); border-collapse: collapse; font-size: 14px; color: var(--ink-soft); margin: 20px 0; font-variant-numeric: tabular-nums; }
.how table.steps th, .how table.steps td { padding: 8px 14px; text-align: right; white-space: nowrap; border-bottom: 1px solid var(--line); }
.how table.steps th { font-weight: 600; color: var(--ink); }
.how table.steps th[colspan] { text-align: center; }
.how .code { position: relative; margin: 24px 0; }
.how .copy { position: absolute; top: 6px; right: 6px; display: grid; place-items: center; width: 30px; height: 30px; padding: 0; color: var(--muted); background: color-mix(in srgb, var(--inset) 72%, transparent); backdrop-filter: blur(3px); border: 1px solid var(--line); border-radius: 6px; cursor: pointer; }
.how .copy:hover { color: var(--ink); border-color: var(--muted); }
.how .copy { opacity: 0; transition: opacity 0.15s; }
.how .code:hover .copy, .how .code:focus-within .copy, .how .copy.done { opacity: 1; }
@media (hover: none) { .how .copy { opacity: 1; } }
.how .copy .check, .how .copy.done .clip { display: none; }
.how .copy.done .check { display: block; }
.how .copy.done { color: var(--green); }
.copy-status { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
.how pre { margin: 0; padding: 18px; background: var(--inset); border: 1px solid var(--line); border-radius: 10px; font-family: var(--mono); font-size: 13px; line-height: 1.65; color: var(--ink-soft); overflow-x: auto; tab-size: 4; font-variant-ligatures: none; }
.how pre .kw { color: #86b7ff; }
.how pre .num { color: #e9b552; }
.how pre .cm { color: var(--muted); }
.how pre .str { color: #62c7bc; }
.how code { font-family: var(--mono); font-size: .9em; color: var(--ink); }
.how pre code { font-size: inherit; color: inherit; }
.how mjx-container { color: var(--ink); }
.how p mjx-container, .how li mjx-container { font-size: .92em; }
.how mjx-container[display="true"] { margin: 22px 0 !important; padding-block: 4px; overflow-x: auto; overflow-y: hidden; text-align: left !important; }
.how mjx-container svg { display: inline-block; }
.how mjx-assistive-mml { position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
@media (max-width: 640px) {
  .diagram:has(.fig-tall) .fig-wide { display: none; }
  .diagram .fig-tall { display: block; min-width: 0; max-width: 380px; }
  .how p, .how ol, .how ul { font-size: 15.5px; line-height: 1.7; }
  .how h3 { font-size: 20px; }
  .how pre { padding: 14px; }
}
</style>
