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
    tagline: 'Ultraviolet plasma streams from the edge of an OLED black.',
    description:
      'Charged ultraviolet, electric-blue and cyan particles approach from the right ' +
      'edge of the screen, flowing through a curl-noise turbulence into luminous plasma ' +
      'clusters. Pure black background, additive blending, zero raster assets — every ' +
      'pixel is computed from a Gaussian falloff in the fragment shader.',
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
  // Example skeleton:
  //
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
