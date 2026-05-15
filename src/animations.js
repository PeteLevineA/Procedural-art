/* =====================================================================
 * Animation registry
 * ---------------------------------------------------------------------
 * Single source of truth for every procedural animation in this site.
 * Add a new entry here, and it will automatically appear:
 *   - as a hero banner card on the gallery homepage (index.html)
 *   - as a standalone full-screen page (if you provide `fullRoute`)
 *
 * Each entry's `mount(container, { previewLoop })` is a factory that
 * creates the animation inside `container`. It must return an object
 * with `{ start, stop, destroy }`. Both the gallery cards and the
 * standalone page use the same factory — the only difference is
 * `previewLoop` (3-second modular loop) on the gallery cards.
 * =====================================================================
 */

import { createOLEDPetrovaParticles } from './OLEDPetrovaParticles.js';
import { createPatrovaWormhole }     from './PatrovaWormhole.js';
import { createAsteroidField }       from './AsteroidField.js';
import { createPetrovaFractal }      from './PetrovaFractal.js';

/**
 * @typedef {Object} AnimationEntry
 * @property {string} id          Stable slug used in URLs and DOM ids.
 * @property {string} title       Display title for the card and the page.
 * @property {string} tagline     One-line description shown on the card.
 * @property {string} description Longer prose for the standalone page.
 * @property {string[]} tags      Short labels (e.g. "WebGL2", "Curl noise").
 * @property {string} fullRoute   Relative href to the immersive standalone view.
 * @property {(container: HTMLElement, opts: { previewLoop?: boolean | { durationSeconds: number } })
 *           => { start(): void, stop(): void, destroy(): void }} mount
 */

/** @type {AnimationEntry[]} */
export const animations = [
  {
    id: 'petrova',
    title: 'Petrova Scope',
    tagline: 'Crimson astrophage particles burning white-hot in plasma clusters.',
    description:
      'Crimson astrophage particles drift in from the right edge of the screen, flowing ' +
      'through a curl-noise turbulence and clumping into luminous plasma clusters that ' +
      'burn white-hot at their cores with deep red coronas. Inspired by the Petrova Line ' +
      'in Project Hail Mary. Pure OLED black background, additive blending, zero raster ' +
      'assets — every pixel is computed from a Gaussian falloff in the fragment shader.',
    tags: ['WebGL2', 'Curl noise', 'Additive', 'OLED'],
    fullRoute: './animations/petrova.html',
    mount(container, { previewLoop = false } = {}) {
      // Preview cards use a smaller particle count for performance,
      // since they share the page with other live canvases.
      const isPreview = !!previewLoop;
      return createOLEDPetrovaParticles(container, {
        particleCount  : isPreview ? 2200 : 6000,
        speed          : isPreview ? 1.15 : 1.0,
        bloomStrength  : 1.0,
        clumpIntensity : 1.0,
        densityRamp    : 1.0,
        rightSpawnBias : 0.85,
        reducedMotion  : 'auto',
        autoStart      : !isPreview, // gallery cards stay paused until triggered
        previewLoop    : previewLoop, // false on the full page; { durationSeconds: 3 } on cards
      });
    },
  },

  // ---- Future animations: add another entry here. ----
  {
    id: 'petrova-wormhole',
    title: 'Petrova Wormhole',
    tagline: 'A neon roller-coaster ride through a 3D particle tunnel, then black.',
    description:
      'A fully 3D procedural OLED wormhole. The camera flies a parametric spline ' +
      'through a tube of neon-blue, magenta and purple particles arranged in ' +
      'rings, ribbons and bottom-up streamers. Instanced velocity-stretched ' +
      'quads streak past the viewer while distant particles form the luminous ' +
      'corridor ahead. A five-phase speed ramp — slow launch, aggressive ' +
      'acceleration, banked peak velocity, sudden landing slam, fade to black — ' +
      'choreographs the ride. 100% procedural: no images, sprites, or textures.',
    tags: ['WebGL2', '3D', 'Wormhole', 'OLED'],
    fullRoute: './animations/petrova-wormhole.html',
    mount(container, { previewLoop = false } = {}) {
      const isPreview = !!previewLoop;
      return createPatrovaWormhole(container, {
        // Lower particle count on gallery cards so multiple live
        // canvases share the page comfortably. Counts are slightly
        // reduced from the original tuning because each particle now
        // renders larger (with per-particle size jitter) — fewer
        // particles read as denser, clumpier neon ribbons.
        particleCount       : isPreview ? 3600 : 9000,
        tunnelRadius        : 6.0,
        speed               : isPreview ? 1.15 : 1.0,
        bloomStrength       : 1.0,
        streakLength        : 1.40,
        bottomOriginBias    : 0.45,
        landingFadeDuration : 3.0,
        palette : {
          blue   : [0.20, 0.55, 1.00],
          purple : [0.55, 0.25, 1.00],
          magenta: [1.00, 0.25, 0.95],
          hot    : [1.00, 1.00, 1.00],
        },
        pathCurvature : {
          ampX  : 4.5, freqX  : 0.06,
          ampY  : 2.5, freqY  : 0.045,
          ampX2 : 2.0, freqX2 : 0.14,
          ampY2 : 1.5, freqY2 : 0.11,
          bank  : 1.1,
        },
        reducedMotion : 'auto',
        autoStart     : !isPreview,
        previewLoop   : previewLoop,
      });
    },
  },

  {
    id: 'asteroid-field',
    title: 'Asteroid Field',
    tagline: 'Cartoon UV-lit rocks tumble past a stationary asteroid ring.',
    description:
      'A first-person fly-through of a neon cartoon asteroid belt. Tumbling black ' +
      'icosahedral rocks with neon-purple inverted-hull outlines streak past the ' +
      'camera, while a second ring of asteroids sits motionless in the background ' +
      'on the horizontal plane, each spinning on its own random axis. Every rock is ' +
      'a procedurally displaced icosahedron. No images, no sprites, no pre-rendered ' +
      'assets.',
    tags: ['Three.js', '3D', 'Toon outline', 'OLED'],
    fullRoute: './animations/asteroid-field.html',
    mount(container, { previewLoop = false } = {}) {
      const isPreview = !!previewLoop;
      return createAsteroidField(container, {
        // Smaller pool on the gallery card; the banner is tiny and we
        // want to keep the per-card cost low when another canvas is
        // already on the page.
        asteroidCount : isPreview ? 36 : 80,
        forwardSpeed  : isPreview ? 0.22 : 0.30,
        ringAsteroidCount: isPreview ? 18 : 32,
        autoStart     : !isPreview, // gallery cards wait for hover/scroll
        previewLoop   : previewLoop,
      });
    },
  },

  {
    id: 'petrova-fractal',
    title: 'Petrova Fractal',
    tagline: 'A hypnotic 30-second dive into a neon recursive Julia universe.',
    description:
      'A 100% procedural OLED fractal — pure GLSL escape-time math rendered ' +
      'as a single fullscreen shader. The camera falls logarithmically into a ' +
      'Julia-set boundary while the parameter c slowly morphs, the plane ' +
      'gently rotates, and a domain-warp term injects organic curl so the ' +
      'viewer feels they are travelling deeper into recursive detail rather ' +
      'than merely zooming in. Three phases (intro / bridge / deep) ramp ' +
      'iteration count, bloom and white-hot plasma intersections across an ' +
      'exact 30-second timeline; the loop boundary is masked by a soft alive ' +
      'fade so the dive feels infinite. Inky black voids, neon blue, neon ' +
      'purple and hot magenta filaments, with white-hot peaks where ' +
      'structures pile up. No images, sprites or pre-rendered assets.',
    tags: ['WebGL2', 'GLSL', 'Fractal', 'OLED'],
    fullRoute: './animations/petrova-fractal.html',
    mount(container, { previewLoop = false } = {}) {
      const isPreview = !!previewLoop;
      return createPetrovaFractal(container, {
        // Gallery cards run a slightly cheaper iteration cap to keep
        // multiple live canvases comfortable on one page; the full
        // immersive page uses the author-tuned count.
        iterationCount  : isPreview ? 120 : 160,
        zoomSpeed       : 0.16,
        bloomIntensity  : isPreview ? 0.85 : 1.0,
        glowIntensity   : 1.0,
        recursionDensity: 1.0,
        fractalType     : 'hybrid',
        reducedMotion   : 'auto',
        autoStart       : !isPreview,
        previewLoop     : previewLoop,
      });
    },
  },

  // Example skeleton for future animations:
  // {
  //   id: 'aurora',
  //   title: 'Aurora Curtain',
  //   tagline: 'Sheets of cold light folding over a dark horizon.',
  //   description: '...',
  //   tags: ['WebGL2', 'Domain warping'],
  //   fullRoute: './animations/aurora.html',
  //   mount(container, { previewLoop } = {}) {
  //     return createAuroraCurtain(container, { previewLoop, autoStart: !previewLoop });
  //   },
  // },
];

/** Look up an animation by id (used by the standalone page bootstrappers). */
export function getAnimation(id) {
  return animations.find(a => a.id === id);
}

export default animations;
