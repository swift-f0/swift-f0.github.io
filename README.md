# SwiftF0 website

Run `npm ci` and `npm run dev` for local development. `npm run build` creates the static site in `dist`, which `npm run preview` serves locally. GitHub Actions publishes `dist` to the root of `swift-f0.github.io`.

The demo and article load independently. The demo retains its recording and analysis state when switching pages. Its pitch detector runs locally in a dedicated worker. Piano samples load on first playback.

Edit the article in `src/how-it-works.article.html`, using `\(...\)` for inline equations and `\[...\]` for display equations. `build/article.mjs` renders its math and highlights Python examples during development and production builds. MathJax is a build dependency only. Generated equations include shared SVG glyphs and assistive MathML. Diagrams live in `src/figures` and are inlined into the page as SVG at build time, so their text can be selected and searched. The build also numbers the figures and adds a copy button to each code block. Invalid equations fail the build.

Run `npm test` and `npm run type-check` before publishing. When changing audio or interaction code, also verify upload, microphone capture, playback, all three exports, page switching, and the layout on a narrow screen. For loading changes, check a cold visit to both `/` and `/how/`. The article must not download the pitch engine.

## Licenses

The site's code is MIT licensed (`LICENSE`). Third-party assets keep their own licenses:

- Piano samples in `src/piano`: [Salamander Grand Piano](https://github.com/Tonejs/audio/tree/master/salamander) by Alexander Holm, as hosted by Tone.js, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/), unmodified.
- Fonts in `src/fonts`: Manrope and JetBrains Mono, [SIL Open Font License 1.1](https://openfontlicense.org/).
- ONNX Runtime Web in `src/ort`: MIT, see `src/ort/LICENSE.txt` and `src/ort/ThirdPartyNotices.txt`.

