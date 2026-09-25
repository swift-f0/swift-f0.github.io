import type { Plugin } from 'vite'
export function articlePlugin(): Plugin
export function renderArticle(source: string): Promise<string>
