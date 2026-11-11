# RepoRealm - third-party notices

RepoRealm is original code by the KENSEI / RepoRealm project. It borrows
mechanics, not assets. Every notice below is reproduced in full in the exported
single-file build (`scripts/build_web.py` inlines them as a comment at the top of
the document), so a standalone `game.html` carries its own attribution and needs
no companion file.

## 1. Portal traversal, aperture fitting and held-object transforms

Adapted from **mwpenny/portal64-still-alive** (MIT), a clean-room reimplementation
of Portal mechanics for the Nintendo 64.

- Upstream: <https://github.com/mwpenny/portal64-still-alive>
- Upstream licence: MIT (SPDX: MIT)
- What was taken: the *ideas* - a portal as a pair of oriented frames, the
  portal-to-portal transform applied to position and velocity, momentum kept and
  direction turned, re-entry suppression after exiting, and objects carried
  through an aperture using the same transform as the body.
- What was rewritten: all of it. The implementation here is JavaScript
  (`web/src/04-portals.js`, `web/src/05-player.js`, `web/src/03-physics.js`,
  `web/src/07-sim.js`). No upstream source file, assembly listing, asset, model,
  texture, sound or map is copied, translated or served.

### Upstream licence text (verbatim)

```text
MIT License

Copyright (c) 2023 James D. Lambert
Copyright (c) 2026 Matthew Penny and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 2. Rendering engine

**three.js r137** (MIT), vendored at `web/vendor/three.min.js`. Full licence text
in `web/vendor/THREE-LICENSE.txt`. It is inlined into the build; nothing is
fetched from a CDN at runtime.

## 3. Mechanical references that were read, not copied

These were consulted for puzzle grammar and camera feel. No code, text or asset
from them is reproduced here.

- Portal Escape (browser portal-puzzle reference)
- torinmr/cs148 (Portal-style course structure)
- mwpenny/portal64-still-alive (see section 1 - the only licensed source used)

## 4. Valve / Portal trademark boundary

Portal is a Valve Corporation property. RepoRealm uses **no** Valve asset,
voice recording, script line, map, model, texture, logo or name. The facility
narration is original text written for this project, spoken by whatever local
text-to-speech voice the user's browser already has installed (or not at all -
subtitles work without any voice). The art, chamber geometry, textures, signage
and sounds are generated in code by this project.

## 5. Original content in this build

- Game code: this repository (`web/src/*.js`, `scripts/build_web.py`).
- Art: procedural textures and text plates drawn in `web/src/08-render.js`, plus
  the owner-supplied RepoRealm poster at `web/assets/reporealm/RepoRealm.png`.
- Type: Space Grotesk (400, 700) and JetBrains Mono (400) woff2 files under
  `web/assets/reporealm/`, embedded under the SIL Open Font License 1.1. The OFL
  texts ship beside them (`OFL-Space-Grotesk.txt`, `OFL-JetBrains-Mono.txt`) and
  are inlined into every export by the same builder.
- Audio: synthesised oscillators and a generated noise buffer in
  `web/src/10-audio.js`. No audio files, no network.
- Chamber content: generated from the analysed repository's own import graph
  (`sourcedrive/`, the internal backend package, analyser payload). Repository
  snippets shown in the evidence terminal come from the repository the user
  asked to analyse, displayed with their real paths and line numbers.
