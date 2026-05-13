# Procedural-art

A growing collection of 100% procedural, OLED-friendly web animations,
presented in an awwwards-style gallery. No images, no sprites, no
pre-rendered video — every pixel is generated at runtime.

## Live

When GitHub Pages is enabled (see below), the site is served from the
repo root:

* **Homepage / gallery** — `index.html`
* **Petrova Scope (immersive)** — `animations/petrova.html`

## Project layout

```
index.html                       Awwwards-style gallery homepage
animations/petrova.html          Immersive standalone view of Petrova Scope
styles.css                       Shared styles + 3 breakpoints (mobile/desktop/4K)
src/
  OLEDPetrovaParticles.js        Reusable WebGL2 particle component
  animations.js                  Animation registry (add new entries here)
  gallery.js                     Gallery controller (hover / scroll triggers)
.nojekyll                        Tell GitHub Pages to skip Jekyll processing
```

## Run locally

It's plain static HTML/JS — any static server works:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

…or:

```sh
npx --yes serve .
```

## Adding a new animation

Animations are registered in **one** place — `src/animations.js`. Add an
entry like:

```js
{
  id: 'aurora',
  title: 'Aurora Curtain',
  tagline: 'Sheets of cold light folding over a dark horizon.',
  description: '…',
  tags: ['WebGL2', 'Domain warping'],
  fullRoute: './animations/aurora.html',
  mount(container, { previewLoop } = {}) {
    return createAuroraCurtain(container, {
      previewLoop,
      autoStart: !previewLoop,
    });
  },
}
```

A few rules every animation factory must follow so the gallery can drive
it:

1. Accept `{ previewLoop }` in its options. When truthy (the gallery
   passes `{ durationSeconds: 3 }`), seamlessly re-seed the simulation at
   that interval — see `OLEDPetrovaParticles.js` for the reference
   implementation.
2. Accept an `autoStart` flag and **stay paused** when it's `false`.
3. Return an object exposing `{ start(), stop(), destroy() }`. The
   gallery will call `start()` on the trigger (hover / scroll-into-view)
   and `stop()` when the trigger ends.

That's all — the gallery card and the standalone page will appear
automatically from the registry entry.

## Hero banner trigger behaviour

This is automatic, controlled by the user's device capabilities:

| Device                                | Trigger to play         |
|---------------------------------------|-------------------------|
| Mobile / touch (`hover: none`)        | Banner scrolls into view (IntersectionObserver, threshold 35%) |
| Desktop / 4K (`hover: hover` + `pointer: fine`) | Hover or keyboard-focus the banner |

Each preview loops the **first 3 seconds** of the animation in a tight,
modular cycle. Click the "View full piece" CTA on any banner to open the
immersive standalone page, where the animation plays in full (no loop).

## CSS breakpoints

Three checkpoints, exactly as the brief asks:

| Range                                | Target           |
|--------------------------------------|------------------|
| `max-width: 767px`                   | Mobile           |
| `min-width: 768px, max-width: 2559px`| Desktop laptop   |
| `min-width: 2560px`                  | 4K monitor / TV  |

At 4K the typography, paddings and stage aspect ratios all scale up so
the page reads correctly from across the room.

## Petrova Scope component reference

`createOLEDPetrovaParticles(container, options) → { canvas, start, stop, reset, setOption, destroy }`

| Option           | Default  | Notes |
|------------------|----------|-------|
| `particleCount`  | `6000`   | 2k–10k sweet spot on desktop; gallery cards use 2200. |
| `speed`          | `1.0`    | Time multiplier for the simulation. |
| `bloomStrength`  | `1.0`    | Scales the soft-halo additive pass. |
| `clumpIntensity` | `1.0`    | Density → brightness + magenta-white core mix. |
| `densityRamp`    | `1.0`    | Scales the local-density estimate. |
| `rightSpawnBias` | `0.85`   | Initial fraction of new particles spawned at the right edge. |
| `palette`        | violet / blue / cyan / hot magenta-white | Linear RGB triplets in 0..1. |
| `seed`           | `1337`   | Seeds the deterministic noise permutation. |
| `reducedMotion`  | `'auto'` | `auto` / `static` / `slow` / `off`. |
| `autoStart`      | `true`   | Set `false` for gallery previews. |
| `previewLoop`    | `false`  | `{ durationSeconds: 3 }` for a tight modular loop. |

## How density → glow works

* Every frame, particles are binned into a coarse 2D grid (~32 cells across).
* For each particle we sum counts in its 3×3 neighbourhood → `density`.
* `density` drives both `intensity` (multiplies color and alpha) and
  `hotMix` (blends base ultraviolet/cyan toward magenta-white).
* On top of that, additive blending of soft Gaussian point-sprites
  *also* makes overlapping particles brighter automatically — additive
  accumulation of Gaussians *is* a kernel density estimate.

## GitHub Pages

The site is structured to serve as static files from a branch root, with
a `.nojekyll` marker so Pages won't try to process the JS via Jekyll.

To turn it on:

1. Open the repo on github.com → **Settings → Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**.
3. Pick the branch you want to publish:
   * **Recommended:** dedicate a `gh-pages` branch to the published
     site. Create it from the latest `main` with everything in this
     repo at the branch root:
     ```sh
     git checkout -b gh-pages main
     git push origin gh-pages
     ```
   * **Or:** publish straight from `main` once this PR is merged — pick
     `main` and the `/ (root)` folder.
4. Save. The site will be available at
   `https://petelevinea.github.io/Procedural-art/`.

> Note from the agent that built this: I can only push to the Copilot
> PR branch from this sandbox, so I couldn't create a `gh-pages` branch
> for you directly. The structure above is ready to publish from any
> branch root the moment Pages is enabled.
