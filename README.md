# Procedural-art — OLED Petrova Scope Particles

A 100% procedural, OLED-friendly particle animation for the web. Inspired by the
moment in *Project Hail Mary* when the Petrova Scope activates: ultraviolet,
electric-blue and cyan particles approach from the right side of the screen,
flow through a turbulent curl-noise field, and gradually fill the scene with
luminous plasma clusters formed by additive overlap.

* **No raster assets, no sprites, no images.** The particle texture is computed
  procedurally in the fragment shader as a Gaussian falloff. The motion field is
  the curl of fbm simplex noise generated at runtime.
* **OLED-pure black** background, **additive blending** (`gl.ONE, gl.ONE`).
  Dense regions become brighter than sparse regions for free — additive
  accumulation of Gaussians *is* a kernel density estimate.
* **WebGL 2** with a single point-sprite pipeline, two passes per frame (soft
  halo + sharp core). No heavy dependencies, no build step.
* **Responsive**, DPR-aware (capped at 2× for performance), pauses when the tab
  is hidden, and honours `prefers-reduced-motion`.

## Run locally

It's pure static HTML/JS — pick any static server. For example:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

…or:

```sh
npx --yes serve .
```

## Embed it

There are two equally easy ways to drop the animation into any page.

### 1. As an ES module

```html
<div id="hero" style="position:fixed;inset:0;background:#000"></div>
<script type="module">
  import { createOLEDPetrovaParticles } from './src/OLEDPetrovaParticles.js';
  createOLEDPetrovaParticles(document.getElementById('hero'));
</script>
```

### 2. Auto-mount via `data-auto-mount`

```html
<div id="hero" style="position:fixed;inset:0;background:#000"></div>
<script
  type="module"
  src="./src/OLEDPetrovaParticles.js"
  data-auto-mount="#hero"
></script>
```

The component returns a small handle:

```js
const anim = createOLEDPetrovaParticles(hero, { particleCount: 8000 });
anim.setOption('speed', 0.6);          // live-tune
anim.setOption('particleCount', 4000); // resets the simulation
anim.destroy();                        // remove canvas + listeners
```

## Tuning the look

All options are optional. Pass any subset.

| Option            | Default  | What it does |
|-------------------|----------|--------------|
| `particleCount`   | `6000`   | Number of simulated particles. 2k–10k is the sweet spot on desktop; drop to ~2.5k for low-end mobile. |
| `speed`           | `1.0`    | Time multiplier for the whole simulation (curl strength + leftward drift). |
| `bloomStrength`   | `1.0`    | Scales the soft-halo pass — how much *glow* surrounds each particle and each cluster. |
| `clumpIntensity`  | `1.0`    | How aggressively local density boosts brightness and pushes color toward the hot magenta-white "plasma core" hue. |
| `densityRamp`     | `1.0`    | Scales the density estimate used by `clumpIntensity`. Raise it to make clusters bloom earlier. |
| `rightSpawnBias`  | `0.85`   | Initial fraction of new particles spawned at the right edge. Decays automatically through the timeline so the scene eventually fills. |
| `palette`         | violet / blue / cyan / hot magenta-white | Override any of the four colors (linear RGB triplets in 0..1). |
| `seed`            | `1337`   | Seeds the deterministic permutation used by the simplex noise. |
| `reducedMotion`   | `'auto'` | `'auto'` honours `prefers-reduced-motion` and renders a single static evolved frame. `'static'` forces that. `'slow'` runs at 10% speed. `'off'` ignores the preference. |

### Phases (built in, no config needed)

1. **0–6 s** — 80–90% black; a few sparse violet/cyan particles trickle in from the right.
2. **6–18 s** — streams arc, swirl, and braid; the right-edge bias is still high.
3. **18 s +** — full population; spawn bias relaxes so the screen fills with glowing clusters. The animation loops seamlessly via per-particle lifetime recycling.

### How density → glow works (in 90 seconds)

* Every frame, particles are binned into a coarse 2D grid (~32 cells across).
* For each particle we sum counts in its 3×3 neighbourhood → `density`.
* `density` drives two things:
  * `intensity` — multiplies the particle's color & alpha, so dense regions blaze.
  * `hotMix` — blends the base ultraviolet/cyan hue toward the `hot` magenta-white color, mimicking the white-hot core of an optically-thick plasma clump.
* On top of that, additive blending of soft Gaussian point-sprites *also* makes overlapping particles brighter automatically. The CPU-side density signal lets us add the *color* shift (cool → hot) that pure additive can't produce on its own.

### Files

```
index.html                       Demo homepage embedding the component
src/OLEDPetrovaParticles.js      The reusable WebGL2 component
```
