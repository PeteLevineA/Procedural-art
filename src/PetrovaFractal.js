/* =====================================================================
 * PetrovaFractal
 * ---------------------------------------------------------------------
 * A 100% procedural, OLED-friendly fractal-zoom animation rendered as
 * a single fullscreen WebGL2 fragment shader.
 *
 * Visual concept
 *   The viewer falls — slowly, continuously, hypnotically — into a
 *   recursive Julia-set boundary. Neon-blue, neon-purple and hot-magenta
 *   feathers branch outward against pure OLED black, with white-hot
 *   highlights where iteration density piles up. The camera target
 *   drifts along the boundary, the Julia parameter `c` slowly morphs,
 *   the plane gently rotates, and a domain-warp term injects organic
 *   wobble — so the fractal is never simply "scaling up", it is always
 *   revealing new recursive detail.
 *
 * Timeline (exactly 30 s)
 *   0 – 10 s   "Seahorse" Julia, sparse black voids, elegant slow zoom,
 *              moderate iteration count, lit purple/blue.
 *  10 – 20 s   Parameter `c` morphs toward a denser, more feathered
 *              quadratic Julia; warp strength rises; magenta dominates;
 *              iteration count grows; bloom thickens.
 *  20 – 30 s   Deep Misiurewicz-like region, peak iterations, hottest
 *              plasma intersections, white-hot highlights; the
 *              animation also smoothly cross-fades the iteration formula
 *              toward a Burning-Ship-style fold for extra structural
 *              variety. The final ~1 s gently dips and returns so the
 *              30-second loop boundary is invisible.
 *
 * No raster assets are used anywhere. Every pixel is computed from
 * fractal escape-time math in the fragment shader. There are no
 * textures, sprites, video, or spritesheets.
 * ===================================================================*/

const DEFAULTS = {
  /** Logarithmic zoom rate in "e-folds per second". 0.10 = one octave
   *  every ~6.9 s. Higher = faster dive. */
  zoomSpeed       : 0.16,

  /** Multiplier on the soft additive bloom that wraps bright edges. */
  bloomIntensity  : 1.0,

  /** Base iteration cap. The renderer scales this up over the timeline
   *  so deeper zooms still resolve fine boundary detail. */
  iterationCount  : 160,

  /** Linear-RGB colour stops keyed off the smoothed escape-time value.
   *  `hot` is the white-hot peak; the others are blended in order. */
  palette : {
    blue   : [0.18, 0.55, 1.00], // neon blue
    purple : [0.62, 0.22, 1.00], // neon purple
    magenta: [1.00, 0.22, 0.92], // hot magenta
    hot    : [1.00, 1.00, 1.00], // white-hot
  },

  /** Phase durations in seconds. Sum is the loop period; authored to
   *  add up to exactly 30 s. */
  morphTiming : {
    intro  : 10.0,  // 0–10s : initial fractal form
    bridge : 10.0,  // 10–20s: morph + densify
    deep   : 10.0,  // 20–30s: peak recursive intensity
  },

  /** Which iteration formula to use.
   *   'julia'        — z² + c (the default, fastest, smoothest)
   *   'burning-ship' — (|x| + i|y|)² + c (more jagged structures)
   *   'hybrid'       — cross-fades from julia toward burning-ship
   *                    over the timeline */
  fractalType    : 'hybrid',

  /** Multiplier on iteration count and warp depth — drives how dense
   *  the recursive structures look. 1.0 = author-intended. */
  recursionDensity: 1.0,

  /** Multiplier on overall brightness of the fractal lines. */
  glowIntensity  : 1.0,

  /** 'auto'   honour prefers-reduced-motion → render a static peak frame
   *  'off'    ignore the user preference; always animate
   *  'static' force the static peak frame
   *  'slow'   animate at 10 % speed */
  reducedMotion  : 'auto',

  /** Start playing immediately on mount. */
  autoStart      : true,

  /** Gallery-preview short loop: `true` (= 3 s) or `{ durationSeconds }`. */
  previewLoop    : false,
};

/* ---------- tiny utilities ---------- */
function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function mix(a, b, t) { return a + (b - a) * t; }

function deepMerge(base, over) {
  if (!over) return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over)) {
    const ov = over[k], bv = base[k];
    if (ov && typeof ov === 'object' && !Array.isArray(ov) && bv && typeof bv === 'object' && !Array.isArray(bv)) {
      out[k] = deepMerge(bv, ov);
    } else if (ov !== undefined) {
      out[k] = ov;
    }
  }
  return out;
}

/* ---------- GLSL ---------- */
const VERT_SRC = /* glsl */`#version 300 es
in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

/* The fragment shader is the entire piece. Every pixel:
 *   1. maps to a complex-plane coordinate transformed by a slowly
 *      rotating frame + logarithmic zoom around a drifting target;
 *   2. is iterated through a quadratic (and optionally burning-ship)
 *      map until escape;
 *   3. is coloured by smooth-iteration count through a 3-stop neon
 *      palette, with white-hot peaks at high density;
 *   4. is accumulated together with a wider, low-iter bloom sample
 *      so dense regions radiate without any post-process pass. */
const FRAG_SRC = /* glsl */`#version 300 es
precision highp float;
in  vec2 vUV;
out vec4 outColor;

uniform vec2  uResolution;
uniform float uTime;          // seconds within 0..duration
uniform float uDuration;      // full loop duration (default 30)

uniform vec2  uTarget;        // complex-plane target point we zoom toward
uniform float uZoom;          // current world-space half-extent
uniform float uRot;           // current rotation, radians
uniform vec2  uJuliaC;        // Julia parameter c
uniform float uWarp;          // domain-warp amplitude
uniform float uShipMix;       // 0..1, blend from pure julia → burning-ship fold
uniform int   uMaxIter;       // iteration cap (already scaled by density)
uniform float uBloom;         // bloom intensity multiplier
uniform float uGlow;          // overall brightness multiplier
uniform float uAlive;         // 0..1 fade for loop boundary
uniform float uHotBoost;      // 0..1, lifts the white-hot peaks late in timeline
uniform vec3  uPalA;          // neon blue
uniform vec3  uPalB;          // neon purple
uniform vec3  uPalC;          // hot magenta
uniform vec3  uPalHot;        // white-hot
uniform float uPaletteShift;  // continuous palette rotation

/* ----------------------------------------------------------
 * Smooth-iteration escape-time fractal. Returns:
 *   .x  = smoothed iteration count in [0, uMaxIter+1], or -1.0 inside
 *   .y  = "trap" value (min |z|^2 seen) — used for inner-glow shading
 * -------------------------------------------------------- */
vec2 fractalSample(vec2 z, vec2 c, float shipMix) {
  float trap = 1e9;
  // Domain warp: a low-frequency divergence-free swirl. Cheap, but
  // breaks the otherwise pure conformal scaling of Julia zooms and
  // is what makes the structures look "alive".
  float w = uWarp;
  z += w * vec2(sin(3.1 * z.y + 0.7), cos(2.7 * z.x - 0.4)) * 0.07;

  for (int i = 0; i < 1024; i++) {
    if (i >= uMaxIter) break;

    // Burning-ship fold (smoothly blended with pure julia via shipMix):
    // (|x| - x) * shipMix gives 0 at shipMix=0 (pure julia) and -2x
    // at shipMix=1 → x becomes |x|. Likewise for y.
    z.x = z.x + (abs(z.x) - z.x) * shipMix;
    z.y = z.y + (abs(z.y) - z.y) * shipMix;

    // z = z^2 + c (complex squaring)
    z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;

    float l = dot(z, z);
    trap = min(trap, l);
    if (l > 256.0) {
      // smooth iteration count: i + 1 - log2( log2( |z| ) )
      float smooth_n = float(i) + 1.0 - log2(log2(l) * 0.5);
      return vec2(smooth_n, trap);
    }
  }
  return vec2(-1.0, trap);
}

/* Map smoothed iteration count → neon palette. The escape value is
 * rescaled to a 0..1 band, with a logarithmic squash so dense filaments
 * don't all wash to the same colour. */
vec3 palette(float n) {
  // Map iteration depth to a palette parameter. The mod() folds large
  // values back so deeper structures keep cycling through the neon
  // band (gives the appearance of recursive colour repetition).
  float u = log2(n + 2.0) * 0.42 + uPaletteShift;
  u = fract(u);

  vec3 col;
  // Smooth three-stop ramp blue → purple → magenta → (back to blue at wrap).
  if (u < 0.45) {
    col = mix(uPalA, uPalB, smoothstep(0.0, 0.45, u));
  } else if (u < 0.85) {
    col = mix(uPalB, uPalC, smoothstep(0.45, 0.85, u));
  } else {
    col = mix(uPalC, uPalA, smoothstep(0.85, 1.0, u));
  }
  return col;
}

/* World-space coordinate for a given pixel offset (in screen-pixel
 * units). Combines: pixel → centred unit-radius square → rotation →
 * logarithmic zoom → translate by target. */
vec2 worldFor(vec2 pix) {
  vec2 res = uResolution;
  vec2 p = (pix - 0.5 * res) / min(res.x, res.y);
  float c = cos(uRot), s = sin(uRot);
  p = mat2(c, -s, s, c) * p;
  return uTarget + p * uZoom;
}

void main() {
  vec2 pix = vUV * uResolution;
  vec2 z   = worldFor(pix);

  vec2 r = fractalSample(z, uJuliaC, uShipMix);
  float n    = r.x;
  float trap = r.y;

  vec3 col = vec3(0.0);
  float lum = 0.0;
  if (n >= 0.0) {
    // Outside the set: bright neon line.
    // Brightness ramps with escape rate but is squashed so we keep
    // dynamic range for the white-hot peaks.
    float v = clamp(n / float(uMaxIter), 0.0, 1.0);
    float bright = pow(1.0 - v, 0.55);     // bright near boundary, dim in voids

    vec3 base = palette(n);

    // White-hot highlights where structures pile up (near the set
    // boundary AND with a small orbit trap). These create the
    // "plasma intersections" requirement.
    float hot = smoothstep(0.55, 0.95, bright) * smoothstep(0.5, 0.0, trap);
    hot = pow(hot, 1.4) * uHotBoost;

    col = base * bright + uPalHot * hot * 0.9;
    lum = bright + hot;
  }
  // Inside the set stays pure black — this is the inky negative space.

  /* ----------- in-shader bloom (multi-tap, no post-process) -----------
     We sample 8 neighbours at two radii, run the same escape-time
     evaluation with a much lower iteration cap, and additively
     accumulate their brightness. This is a poor man's gaussian bloom:
     because the inside of the set is exactly black, the contribution
     is zero everywhere except near bright boundary pixels, so the
     result reads as a soft glow wrapping luminous filaments. Total
     cost is bounded by the small inner iteration cap. */
  if (uBloom > 0.001) {
    const int BL = 8;
    // Two-octave kernel — inner ring 1.5 px, outer ring 4.5 px.
    vec2 offs[BL] = vec2[BL](
      vec2( 1.5, 0.0), vec2(-1.5, 0.0), vec2(0.0,  1.5), vec2(0.0, -1.5),
      vec2( 3.2, 3.2), vec2(-3.2, 3.2), vec2(3.2, -3.2), vec2(-3.2,-3.2)
    );
    // Reduced iteration count for the bloom taps. Boundary detail
    // gets fuzzier with depth — which is exactly what bloom should do.
    int bloomIter = min(uMaxIter / 3, 64);
    float scale = 0.5 * (uBloom);
    vec3 accum = vec3(0.0);
    for (int i = 0; i < BL; i++) {
      vec2 q  = worldFor(pix + offs[i]);
      // We don't need the full sample function — just a brightness
      // estimate. Reuse fractalSample with a smaller cap by clamping
      // via a uniform replacement: cheaper to just call again.
      // (uMaxIter is uniform; we cheat by manually unrolling here.)
      vec2 zz = q;
      vec2 cc = uJuliaC;
      float bn = -1.0;
      for (int k = 0; k < 64; k++) {
        if (k >= bloomIter) break;
        zz.x = zz.x + (abs(zz.x) - zz.x) * uShipMix;
        zz.y = zz.y + (abs(zz.y) - zz.y) * uShipMix;
        zz = vec2(zz.x*zz.x - zz.y*zz.y, 2.0*zz.x*zz.y) + cc;
        float l = dot(zz, zz);
        if (l > 256.0) { bn = float(k) + 1.0 - log2(log2(l)*0.5); break; }
      }
      if (bn >= 0.0) {
        float v = clamp(bn / float(bloomIter), 0.0, 1.0);
        float bright = pow(1.0 - v, 0.55);
        accum += palette(bn) * bright;
      }
    }
    accum *= (scale / float(BL));
    col += accum;
    lum += dot(accum, vec3(0.299, 0.587, 0.114));
  }

  // Final tone: alive fade for seamless loop boundaries; glow
  // multiplier; a tiny gamma for richer neons; clamp at 1 to keep
  // the screen-space additive look (no HDR display assumed).
  col *= uGlow * uAlive;
  // Soft saturation lift on bright pixels for extra neon punch.
  col = mix(col, col * (0.7 + 0.6 * lum), 0.35);
  outColor = vec4(col, 1.0);
}
`;

/* =====================================================================
 * Factory
 * ===================================================================*/
export function createPetrovaFractal(container, userOpts = {}) {
  const opts = deepMerge(DEFAULTS, userOpts);

  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.setAttribute('aria-hidden', 'true');
  container.appendChild(canvas);

  const gl = canvas.getContext('webgl2', {
    alpha            : false,
    antialias        : false,
    premultipliedAlpha: false,
    powerPreference  : 'high-performance',
    preserveDrawingBuffer: false,
  });
  if (!gl) return makeNoopHandle(canvas, container);

  /* ---- program ---- */
  const program = compileProgram(gl, VERT_SRC, FRAG_SRC);
  if (!program) return makeNoopHandle(canvas, container);
  gl.useProgram(program);

  /* ---- fullscreen triangle pair ---- */
  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,   1, -1,  -1,  1,
    -1,  1,   1, -1,   1,  1,
  ]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, 'aPos');
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  /* ---- uniforms ---- */
  const loc = {};
  for (const name of [
    'uResolution', 'uTime', 'uDuration',
    'uTarget', 'uZoom', 'uRot',
    'uJuliaC', 'uWarp', 'uShipMix',
    'uMaxIter', 'uBloom', 'uGlow', 'uAlive', 'uHotBoost',
    'uPalA', 'uPalB', 'uPalC', 'uPalHot',
    'uPaletteShift',
  ]) {
    loc[name] = gl.getUniformLocation(program, name);
  }

  /* ---- resize handling ---- */
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  function resize() {
    const rect = container.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width  * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(resize);
    ro.observe(container);
  }
  window.addEventListener('resize', resize);
  resize();

  /* =====================================================================
   * Timeline / parameter evolution
   *
   * The 30 s timeline (or whatever opts.morphTiming sums to) is split
   * into three phases. Within each phase every animated parameter
   * smoothly interpolates from its phase-start value to its phase-end
   * value — this guarantees C¹ continuity at every phase boundary, so
   * the morph never reads as a hard cut.
   *
   * Phase parameters were chosen aesthetically:
   *   - Julia c values drift along the "seahorse → spiral feather →
   *     Misiurewicz dense" axis (all near the main bulb boundary, all
   *     producing connected sets full of recursive filaments).
   *   - target points are a slow drift along a small ellipse so the
   *     viewer is not zooming into a fixed centre — combined with log
   *     zoom this gives an "off-axis dive" feel.
   *   - warp ramps from gentle wobble to noticeable curl.
   *   - iteration count rises with depth so fine boundary stays sharp.
   *   - hotBoost stays near zero in the intro then peaks in the deep
   *     phase to produce the "plasma intersection" highlights.
   * ===================================================================*/
  const tm = opts.morphTiming;
  const T1 = tm.intro;
  const T2 = T1 + tm.bridge;
  const T3 = T2 + tm.deep;          // total duration

  // Three keyframes (start of intro, start of bridge, start of deep, end).
  const KEYS = [
    // 0 s — gentle seahorse Julia, sparse, low warp
    {
      c   : [-0.7269,  0.1889],
      tgt : [ 0.0,     0.0   ],
      warp: 0.04,
      iter: 120,
      hot : 0.15,
      ship: 0.0,
      glow: 0.85,
      bloom: 0.75,
    },
    // ~10 s — denser feathered Julia, more warp, more iterations
    {
      c   : [-0.8000,  0.1560],
      tgt : [ 0.05,   -0.03  ],
      warp: 0.18,
      iter: 200,
      hot : 0.55,
      ship: 0.05,
      glow: 1.00,
      bloom: 1.10,
    },
    // ~20 s — deep Misiurewicz-ish region; peak intensity
    {
      c   : [-0.745429, 0.113008],
      tgt : [-0.02,    0.04   ],
      warp: 0.32,
      iter: 280,
      hot : 1.20,
      ship: 0.18,
      glow: 1.20,
      bloom: 1.40,
    },
    // 30 s — same family as deep, slightly different so the loop
    // boundary lands on a fresh-but-familiar pose (alive fade hides
    // any residual mismatch).
    {
      c   : [-0.751000, 0.107000],
      tgt : [ 0.01,     0.02   ],
      warp: 0.30,
      iter: 280,
      hot : 1.00,
      ship: 0.22,
      glow: 1.15,
      bloom: 1.30,
    },
  ];

  // Fractal-type override.
  function shipMixOverride() {
    if (opts.fractalType === 'julia')        return 0.0;
    if (opts.fractalType === 'burning-ship') return 1.0;
    return -1.0; // hybrid → use timeline-driven value
  }

  /** Cubic-smooth (smootherstep) interpolation between key i and key i+1. */
  function lerpKeys(t01, a, b) {
    const e = smoothstep(0.0, 1.0, t01);
    return {
      c   : [mix(a.c[0],   b.c[0],   e), mix(a.c[1],   b.c[1],   e)],
      tgt : [mix(a.tgt[0], b.tgt[0], e), mix(a.tgt[1], b.tgt[1], e)],
      warp: mix(a.warp, b.warp, e),
      iter: mix(a.iter, b.iter, e),
      hot : mix(a.hot,  b.hot,  e),
      ship: mix(a.ship, b.ship, e),
      glow: mix(a.glow, b.glow, e),
      bloom: mix(a.bloom, b.bloom, e),
    };
  }

  function sampleTimeline(t) {
    if (t < T1)              return lerpKeys(t / T1,           KEYS[0], KEYS[1]);
    if (t < T2)              return lerpKeys((t - T1) / tm.bridge, KEYS[1], KEYS[2]);
    return                          lerpKeys((t - T2) / tm.deep,   KEYS[2], KEYS[3]);
  }

  /* =====================================================================
   * Animation loop
   * ===================================================================*/
  // Preview-mode time compression.
  const previewDuration =
    (opts.previewLoop && opts.previewLoop.durationSeconds) ||
    (opts.previewLoop ? 3.0 : 0);
  const usePreview = previewDuration > 0;

  let raf = 0;
  let wantsRunning = false;
  let startWall = 0;
  let pausedAt = 0;          // accumulated paused time, in real seconds
  let timeOffset = 0;        // shifts the visible t (useful for static frames)

  // For zoom continuity across the loop we just let zoom = baseZoom *
  // exp(-zoomSpeed * tInside). At t = duration the zoom has shrunk by
  // exp(-zoomSpeed * duration). With the default 0.16 × 30 ≈ 4.8 e-folds
  // (~120×) — a satisfying dive. The alive-fade at the loop boundary
  // hides the jump back to t=0.
  const BASE_ZOOM = 1.6;
  const ZOOM_SPEED = opts.zoomSpeed;
  const DURATION = T3;

  /** Compute the timeline-driven uniforms for a given absolute time
   *  in seconds, and write them. */
  function uploadFrame(absSec) {
    // Map wall time → timeline t (0 .. DURATION).
    let t;
    if (usePreview) {
      const u = (absSec % previewDuration) / previewDuration;
      t = u * DURATION;
    } else {
      t = absSec % DURATION;
    }

    // Alive-fade window: dip near 0 and near DURATION so the loop is
    // seamless. ~0.6 s on either side.
    const fadeWin = 0.6;
    const aliveIn  = smoothstep(0.0,     fadeWin,           t);
    const aliveOut = smoothstep(0.0,     fadeWin, DURATION - t);
    const alive = Math.min(aliveIn, aliveOut);

    const k = sampleTimeline(t);

    // Continuous rotation tied to log(zoom). This is the trick that
    // turns a static "zoom into Julia" into a true dive: the world
    // is gently rolling around the target as it falls deeper, so the
    // viewer's frame is never the same twice.
    const rot = -t * 0.08;

    // Logarithmic zoom: zoom = BASE * exp(-rate * t). Constant rate
    // in log-zoom means constant *perceptual* dive speed — the
    // hypnotic, never-accelerating fall the spec asks for.
    const zoom = BASE_ZOOM * Math.exp(-ZOOM_SPEED * t);

    // Iteration scaling: ramp with both timeline depth and zoom level
    // so deeper zooms keep resolving boundary detail.
    const iterBase = k.iter * opts.recursionDensity * (opts.iterationCount / 160);
    const zoomFactor = 1.0 + Math.log2(BASE_ZOOM / Math.max(zoom, 1e-6)) * 0.10;
    let maxIter = Math.floor(iterBase * zoomFactor);
    maxIter = Math.max(40, Math.min(maxIter, 480));

    // Fractal-type handling.
    const shipOver = shipMixOverride();
    const ship = shipOver >= 0 ? shipOver : k.ship;

    // Slow secondary drift of c so two consecutive loops never trace
    // exactly the same path — keeps repeated viewings feeling fresh.
    const cDriftX = Math.sin(t * 0.05) * 0.003;
    const cDriftY = Math.cos(t * 0.07) * 0.003;

    gl.uniform2f(loc.uResolution, canvas.width, canvas.height);
    gl.uniform1f(loc.uTime,       t);
    gl.uniform1f(loc.uDuration,   DURATION);
    gl.uniform2f(loc.uTarget,     k.tgt[0], k.tgt[1]);
    gl.uniform1f(loc.uZoom,       zoom);
    gl.uniform1f(loc.uRot,        rot);
    gl.uniform2f(loc.uJuliaC,     k.c[0] + cDriftX, k.c[1] + cDriftY);
    gl.uniform1f(loc.uWarp,       k.warp * opts.recursionDensity);
    gl.uniform1f(loc.uShipMix,    ship);
    gl.uniform1i(loc.uMaxIter,    maxIter);
    gl.uniform1f(loc.uBloom,      k.bloom * opts.bloomIntensity);
    gl.uniform1f(loc.uGlow,       k.glow * opts.glowIntensity);
    gl.uniform1f(loc.uAlive,      alive);
    gl.uniform1f(loc.uHotBoost,   k.hot);
    gl.uniform1f(loc.uPaletteShift, t * 0.012);

    gl.uniform3fv(loc.uPalA,   opts.palette.blue);
    gl.uniform3fv(loc.uPalB,   opts.palette.purple);
    gl.uniform3fv(loc.uPalC,   opts.palette.magenta);
    gl.uniform3fv(loc.uPalHot, opts.palette.hot);
  }

  function renderAt(absSec) {
    resize();
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    uploadFrame(absSec);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  /* ----- reduced motion ----- */
  const mql = (window.matchMedia)
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;
  function resolveMotionMode() {
    const rm = opts.reducedMotion;
    if (rm === 'off') return 'animate';
    if (rm === 'static') return 'static';
    if (rm === 'slow')   return 'slow';
    // auto
    return (mql && mql.matches) ? 'static' : 'animate';
  }
  let mode = resolveMotionMode();
  const SLOW_RATE = 0.10;

  function frame(ts) {
    raf = 0;
    if (!wantsRunning) return;
    if (!startWall) startWall = ts;
    let elapsed = (ts - startWall) / 1000 - pausedAt;
    elapsed = mode === 'slow' ? elapsed * SLOW_RATE : elapsed;
    renderAt(elapsed + timeOffset);
    raf = requestAnimationFrame(frame);
  }

  function renderStaticFrame() {
    // Representative still: peak of the deep phase.
    const stillT = T2 + tm.deep * 0.55;
    renderAt(stillT);
  }

  /* ----- public API ----- */
  function start() {
    if (wantsRunning) return;
    if (document.hidden) return;
    mode = resolveMotionMode();
    if (mode === 'static') { renderStaticFrame(); return; }
    wantsRunning = true;
    startWall = 0;
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function stop() {
    wantsRunning = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }
  function onVis() {
    if (document.hidden) stop();
    else if (opts.autoStart || wantsRunning) start();
  }
  document.addEventListener('visibilitychange', onVis);
  if (mql && mql.addEventListener) {
    mql.addEventListener('change', () => {
      const was = wantsRunning;
      stop();
      if (was) start();
      else if (resolveMotionMode() === 'static') renderStaticFrame();
    });
  }

  // Draw a representative still so the canvas isn't a black flash
  // before the first user interaction (matches other animations).
  renderStaticFrame();
  if (opts.autoStart) start();

  return {
    canvas,
    start,
    stop,
    reset() {
      stop();
      startWall = 0;
      pausedAt = 0;
      timeOffset = 0;
      renderStaticFrame();
    },
    setOption(key, value) {
      if (key === 'palette' && value && typeof value === 'object') {
        opts.palette = { ...opts.palette, ...value };
      } else if (key in opts) {
        opts[key] = value;
      }
      // Re-render an immediate frame so changes are visible even when paused.
      if (!wantsRunning) renderStaticFrame();
    },
    destroy() {
      stop();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('resize', resize);
      if (ro) ro.disconnect();
      try {
        gl.deleteBuffer(quadBuf);
        gl.deleteVertexArray(vao);
        gl.deleteProgram(program);
      } catch (_) { /* context already lost */ }
      try { container.removeChild(canvas); } catch (_) {}
    },
  };
}

/* ---------- GL helpers (kept small and local on purpose) ---------- */
function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    // eslint-disable-next-line no-console
    console.warn('[PetrovaFractal] shader compile failed:',
      gl.getShaderInfoLog(sh), '\n---\n', src);
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}
function compileProgram(gl, vsSrc, fsSrc) {
  const vs = compileShader(gl, gl.VERTEX_SHADER,   vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return null;
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    // eslint-disable-next-line no-console
    console.warn('[PetrovaFractal] program link failed:', gl.getProgramInfoLog(p));
    gl.deleteProgram(p);
    return null;
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return p;
}
function makeNoopHandle(canvas, container) {
  return {
    canvas,
    start() {}, stop() {}, reset() {}, setOption() {},
    destroy() { try { container.removeChild(canvas); } catch (_) {} },
  };
}

export default createPetrovaFractal;
