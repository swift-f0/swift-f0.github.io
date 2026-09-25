<script setup lang="ts">
import { defineAsyncComponent, h, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

const header = ref<HTMLElement | null>(null)
let headerResize: ResizeObserver | null = null
const pageOf = (path: string) => (path.startsWith('/how') ? 'how' : 'demo')
const page = ref(pageOf(location.pathname))
const visitedDemo = ref(page.value === 'demo')
const recording = ref(false)
const loadingPage = () => h('section', { class: 'card page-status', role: 'status' }, 'Loading…')
const errorPage = () => h('section', { class: 'card page-status', role: 'alert' }, [
  h('p', 'This page could not be loaded. Check your connection and try again.'),
  h('button', { class: 'text-button', onClick: () => location.reload() }, 'Reload page'),
])
const Demo = defineAsyncComponent({ loader: () => import('./Demo.vue'), loadingComponent: loadingPage, errorComponent: errorPage, delay: 120, timeout: 30000 })
const HowItWorks = defineAsyncComponent({ loader: () => import('./HowItWorks.vue'), loadingComponent: loadingPage, errorComponent: errorPage, delay: 120, timeout: 30000 })

watch(page, value => {
  document.title = value === 'how' ? 'How SwiftF0 works' : 'SwiftF0'
  if (value === 'demo') visitedDemo.value = true
}, { immediate: true })

async function navigate(path: string, event: MouseEvent) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
  event.preventDefault()
  if (location.pathname === path) return
  history.pushState(null, '', path)
  page.value = pageOf(path)
  await nextTick()
  window.scrollTo(0, 0)
}

function onPopState() {
  page.value = pageOf(location.pathname)
}

function focusContent() {
  document.getElementById('content')?.focus()
}
// The header is sticky, so the article rail and the heading anchors have to clear it.
function measureHeader() {
  const height = header.value?.offsetHeight ?? 0
  if (height) document.documentElement.style.setProperty('--header-h', `${Math.round(height)}px`)
}

onMounted(() => {
  window.addEventListener('popstate', onPopState)
  measureHeader()
  headerResize = new ResizeObserver(measureHeader)
  if (header.value) headerResize.observe(header.value)
})
onUnmounted(() => {
  window.removeEventListener('popstate', onPopState)
  headerResize?.disconnect()
})
</script>

<template>
  <a class="skip-link" href="#content" @click.prevent="focusContent">Skip to content</a>
  <div class="wrap">
    <header ref="header" class="site-header">
      <h1><a href="/" :aria-current="page === 'demo' ? 'page' : undefined" @click="navigate('/', $event)">SwiftF0<span v-if="recording" class="recording-badge"> · Recording</span></a></h1>
      <p class="intro">Pitch and notes of a voice or instrument, in your browser.</p>
      <nav class="links" aria-label="Main navigation">
        <a href="/how/" :aria-current="page === 'how' ? 'page' : undefined" @click="navigate('/how/', $event)">How it works</a>
        <a href="https://github.com/lars76/swift-f0" target="_blank" rel="noopener noreferrer">Python package</a>
        <a href="https://github.com/lars76/swift-f0-training" target="_blank" rel="noopener noreferrer">Training code</a>
        <a href="https://github.com/lars76/pitch-benchmark" target="_blank" rel="noopener noreferrer">Benchmark</a>
      </nav>
    </header>
    <main id="content" tabindex="-1">
      <Demo v-if="visitedDemo" v-show="page === 'demo'" :active="page === 'demo'" @recording="recording = $event" />
      <HowItWorks v-if="page === 'how'" />
    </main>
    <footer>
      <span>© 2025–2026 Lars Nieradzik · Audio is processed on your device and never sent to a server.</span>
      <span>Piano: <a href="https://github.com/Tonejs/audio/tree/master/salamander" rel="noopener">Salamander Grand Piano</a> by Alexander Holm (<a href="https://creativecommons.org/licenses/by/3.0/" rel="noopener">CC BY 3.0</a>)</span>
    </footer>
  </div>
</template>
