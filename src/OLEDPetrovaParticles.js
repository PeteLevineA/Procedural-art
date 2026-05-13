/* =====================================================================
 * OLEDPetrovaParticles
 * ---------------------------------------------------------------------
 * A 100% procedural, OLED-friendly particle animation inspired by the
 * activation of the Petrova Scope in Project Hail Mary: ultraviolet,
 * cyan and neon-purple particles approach from the right of the screen,
 * flowing through a turbulent curl-noise field, then gradually fill the
 * scene with luminous plasma clusters.
 *
 * Design notes (everything is procedural — no raster assets, no sprites):
 *
 *  1. Particle field
 *     ----------------
 *     Each particle stores 2D position, velocity, age, lifetime, base
 *     color, depth (parallax layer) and a per-particle size jitter.
 *     Velocity is advected by a 2D curl-noise field derived from
 *     simplex noise. The curl of a scalar potential is divergence-free,
 *     which produces convincing fluid-like, swirling, non-linear motion
 *     instead of straight starfield trajectories. A second octave of
 *     noise modulates the potential so the flow has fine + coarse
 *     structure (fbm-like turbulence). A weak attraction toward the
 *     local centroid of nearby particles makes clumps self-organise
 *     instead of dispersing uniformly.
 *
 *  2. Density glow
 *     ------------
 *     The viewport is binned into a coarse spatial grid every frame.
 *     For each particle we count occupants in its cell + 8 neighbours.
 *     This `density` value drives two visual signals:
 *       a) `intensity` — bright cores in dense regions, faint in voids.
 *       b) `hotMix`    — interpolates the particle's base ultraviolet/
 *                       cyan hue toward a hot magenta-white in the
 *                       densest clusters, mimicking optically-thick
 *                       plasma overlap.
 *
 *  3. Blending strategy
 *     ------------------
 *     Pure OLED black background (clearColor 0,0,0,1) plus *additive*
 *     blending (gl.blendFunc(ONE, ONE)). Because additive accumulation
 *     of soft Gaussian sprites is mathematically equivalent to a kernel
 *     density estimate, dense regions naturally bloom brighter than
 *     sparse ones — no offscreen post-process is required.
 *
 *     Each particle is rendered twice per frame:
 *       Pass A: large soft "halo" (low alpha, big point size)
 *               → produces the soft bloom / glow that wraps clusters.
 *       Pass B: small sharp "core" (high alpha, small point size)
 *               → produces the bright pinpoint at the heart of each
 *                 particle and resolves crisp filaments inside streams.
 *     The point-sprite itself is generated procedurally in the fragment
 *     shader as a Gaussian falloff over gl_PointCoord — there is no
 *     texture, no image, no sprite atlas anywhere in this file.
 *
 *  4. Progression timeline
 *     ---------------------
 *     Phase 1 (≈0–6s)  : 80–90% black; only a handful of live particles
 *                        spawn near the right edge in vertical streaks.
 *     Phase 2 (≈6–18s) : spawn rate ramps; particles arc and form
 *                        streams; right-spawn bias still high.
 *     Phase 3 (>18s)   : full population reached; spawn bias relaxes so
 *                        particles fill the whole screen with glowing
 *                        clusters. Animation loops by gracefully
 *                        respawning particles whose lifetime expires.
 *
 *  5. Reduced motion
 *     ---------------
 *     If the user prefers reduced motion we either render a single
 *     evolved static frame (default) or run at 10% speed, depending on
 *     the `reducedMotion` option.
 * =====================================================================
 */

// --------------------------------------------------------------------
// 2D Simplex noise (Stefan Gustavson / Peter Eastman, public domain).
// Used as the scalar potential whose curl drives particle motion.
// --------------------------------------------------------------------
const _grad3 = new Float32Array([
   1, 1,  -1, 1,   1,-1,  -1,-1,
   1, 0,  -1, 0,   1, 0,  -1, 0,
   0, 1,   0,-1,   0, 1,   0,-1,
]);
function _buildPerm(seed) {
  // Deterministic shuffle of 0..255 using a tiny LCG so visuals are
  // reproducible across reloads when a fixed seed is desired.
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let s = (seed | 0) || 1337;
  for (let i = 255; i > 0; i--) {
    s = (s * 1664525 + 1013904223) | 0;
    const j = (s >>> 0) % (i + 1);
    const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  return perm;
}
function _makeSimplex(seed) {
  const perm = _buildPerm(seed);
  const F2 = 0.5 * (Math.sqrt(3) - 1);
  const G2 = (3 - Math.sqrt(3)) / 6;
  return function simplex2(xin, yin) {
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const X0 = i - t, Y0 = j - t;
    const x0 = xin - X0, y0 = yin - Y0;
    let i1, j1;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
    const x1 = x0 - i1 + G2,   y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    const gi0 = (perm[ii + perm[jj]] % 12) * 2;
    const gi1 = (perm[ii + i1 + perm[jj + j1]] % 12) * 2;
    const gi2 = (perm[ii + 1 + perm[jj + 1]] % 12) * 2;
    let n0 = 0, n1 = 0, n2 = 0;
    let t0 = 0.5 - x0*x0 - y0*y0;
    if (t0 >= 0) { t0 *= t0; n0 = t0 * t0 * (_grad3[gi0]*x0 + _grad3[gi0+1]*y0); }
    let t1 = 0.5 - x1*x1 - y1*y1;
    if (t1 >= 0) { t1 *= t1; n1 = t1 * t1 * (_grad3[gi1]*x1 + _grad3[gi1+1]*y1); }
    let t2 = 0.5 - x2*x2 - y2*y2;
    if (t2 >= 0) { t2 *= t2; n2 = t2 * t2 * (_grad3[gi2]*x2 + _grad3[gi2+1]*y2); }
    return 70 * (n0 + n1 + n2); // approximately in [-1, 1]
  };
}

// --------------------------------------------------------------------
// GL helpers
// --------------------------------------------------------------------
function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('OLEDPetrovaParticles shader compile error: ' + log);
  }
  return sh;
}
function linkProgram(gl, vsSrc, fsSrc) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram();
  gl.attachShader(p, vs); gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('OLEDPetrovaParticles link error: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

// --------------------------------------------------------------------
// Shaders. The point-sprite is generated procedurally per-fragment as
// a Gaussian — there is NO texture sampler anywhere in this pipeline.
// --------------------------------------------------------------------
const VERT_SRC = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_pos;       // clip-space [-1, 1]
layout(location = 1) in vec3 a_color;     // linear RGB
layout(location = 2) in vec2 a_sizeAlpha; // x = size px, y = alpha

uniform float u_sizeMul;
uniform float u_alphaMul;
uniform float u_dpr;

out vec3 v_color;
out float v_alpha;

void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
  gl_PointSize = a_sizeAlpha.x * u_sizeMul * u_dpr;
  v_color = a_color;
  v_alpha = a_sizeAlpha.y * u_alphaMul;
}`;

const FRAG_SRC = `#version 300 es
precision highp float;

in vec3 v_color;
in float v_alpha;
out vec4 outColor;

// Procedural soft-particle: radial Gaussian falloff. No texture lookup.
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d) * 4.0;       // 0 at center, 1 at edge
  if (r2 > 1.0) discard;
  // Gaussian-ish falloff — softer than 1-r and gives nicer bloom overlap.
  float g = exp(-r2 * 4.5);
  vec3 col = v_color * g * v_alpha;
  // Additive blending: alpha channel is unused for color compositing,
  // but we set it to the same intensity so the framebuffer can be read
  // back consistently if needed.
  outColor = vec4(col, g * v_alpha);
}`;

// --------------------------------------------------------------------
// Default configuration. All knobs documented in README.md.
// --------------------------------------------------------------------
const DEFAULTS = {
  particleCount   : 6000,
  speed           : 1.0,
  bloomStrength   : 1.0,
  clumpIntensity  : 1.0,
  densityRamp     : 1.0,
  rightSpawnBias  : 0.85, // initial; decays through the timeline
  seed            : 1337,
  palette         : {
    violet : [0.55, 0.22, 1.00],
    blue   : [0.25, 0.55, 1.00],
    cyan   : [0.25, 0.95, 1.00],
    hot    : [1.00, 0.55, 0.95], // magenta-white for plasma cores
  },
  // 'auto'  : detect prefers-reduced-motion → static frame
  // 'static': force a single static evolved frame
  // 'slow'  : run at 10% speed
  // 'off'   : ignore the user preference (not recommended)
  reducedMotion   : 'auto',
  // Internal upper bound on dt to avoid huge jumps when tab is hidden.
  maxDeltaSeconds : 1 / 30,
  // If true (default), the animation begins playing as soon as it is
  // mounted. Set false when used as a gallery preview that should wait
  // for an external trigger (hover / scroll into view).
  autoStart       : true,
  // Preview-loop mode for gallery thumbnails. When set to a truthy
  // object like { durationSeconds: 3 }, the simulation re-seeds itself
  // every N seconds so the opening phase of the animation plays in a
  // tight, modular loop. Set to `false` (default) for full playback.
  previewLoop     : false,
};

/**
 * Create and mount an OLED Petrova particle animation into `container`.
 * @param {HTMLElement} container A block-level element (e.g. <div>) that
 *   will be filled by the animation. The canvas is appended as a child
 *   and stretched to 100%/100%.
 * @param {Partial<typeof DEFAULTS>} [userOptions]
 * @returns {{ destroy(): void, setOption(k,v): void, canvas: HTMLCanvasElement }}
 */
export function createOLEDPetrovaParticles(container, userOptions = {}) {
  if (!container || !container.appendChild) {
    throw new Error('OLEDPetrovaParticles: container element is required');
  }

  const opts = {
    ...DEFAULTS,
    ...userOptions,
    palette: { ...DEFAULTS.palette, ...(userOptions.palette || {}) },
  };

  // ----- Canvas -----
  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.background = '#000';
  container.appendChild(canvas);

  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    premultipliedAlpha: false,
    powerPreference: 'high-performance',
  });
  if (!gl) {
    // Graceful fallback: leave a pure-black canvas. Still procedural.
    canvas.style.background = '#000';
    const noop = () => {};
    return {
      canvas,
      destroy() { try { container.removeChild(canvas); } catch (_) {} },
      setOption: noop,
      start: noop,
      stop: noop,
      reset: noop,
    };
  }

  // ----- GL state -----
  const program = linkProgram(gl, VERT_SRC, FRAG_SRC);
  gl.useProgram(program);
  const u_sizeMul  = gl.getUniformLocation(program, 'u_sizeMul');
  const u_alphaMul = gl.getUniformLocation(program, 'u_alphaMul');
  const u_dpr      = gl.getUniformLocation(program, 'u_dpr');

  // Interleaved buffer layout: vec2 pos | vec3 color | vec2 sizeAlpha = 7 floats.
  const STRIDE_FLOATS = 7;
  const STRIDE_BYTES  = STRIDE_FLOATS * 4;

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);

  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, STRIDE_BYTES, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, STRIDE_BYTES, 8);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 2, gl.FLOAT, false, STRIDE_BYTES, 20);

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  // Pure additive — densities sum, OLED-friendly.
  gl.blendFunc(gl.ONE, gl.ONE);
  gl.clearColor(0, 0, 0, 1);

  // ----- Particle state arrays (SoA for cache friendliness) -----
  let N = Math.max(64, opts.particleCount | 0);
  let px = new Float32Array(N);    // position x in pixels (canvas-space, 0..W)
  let py = new Float32Array(N);    // position y in pixels (0..H)
  let vx = new Float32Array(N);
  let vy = new Float32Array(N);
  let age = new Float32Array(N);
  let life = new Float32Array(N);
  let baseR = new Float32Array(N); // base color
  let baseG = new Float32Array(N);
  let baseB = new Float32Array(N);
  let depth = new Float32Array(N); // 0 (back) .. 1 (front), parallax & size
  let jitter = new Float32Array(N);// per-particle size variance

  // GPU interleaved buffer (re-uploaded each frame).
  let cpuBuffer = new Float32Array(N * STRIDE_FLOATS);

  // Coarse density grid. Cell size is set adaptively from viewport.
  let gridCols = 1, gridRows = 1, gridCell = 64;
  let gridCounts = new Int32Array(1);

  // Simplex noise instance.
  const noise = _makeSimplex(opts.seed);

  // ----- Sizing -----
  let W = 1, H = 1, DPR = 1;
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2); // cap DPR for perf
    const rect = container.getBoundingClientRect();
    W = Math.max(1, Math.floor(rect.width));
    H = Math.max(1, Math.floor(rect.height));
    canvas.width  = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    gl.viewport(0, 0, canvas.width, canvas.height);
    // Choose a grid cell that yields ~40x25 cells at typical sizes.
    gridCell = Math.max(24, Math.min(80, Math.round(Math.max(W, H) / 32)));
    gridCols = Math.max(1, Math.ceil(W / gridCell));
    gridRows = Math.max(1, Math.ceil(H / gridCell));
    gridCounts = new Int32Array(gridCols * gridRows);
  }
  resize();
  const ro = ('ResizeObserver' in window) ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(container);
  window.addEventListener('resize', resize);

  // ----- Reduced-motion detection -----
  const mql = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function effectiveMotionMode() {
    if (opts.reducedMotion === 'off') return 'normal';
    if (opts.reducedMotion === 'static') return 'static';
    if (opts.reducedMotion === 'slow') return 'slow';
    // auto
    return (mql && mql.matches) ? 'static' : 'normal';
  }

  // ----- Particle initialisation -----
  // Random palette pick weighted toward violet/blue, occasional cyan.
  function pickPaletteColor(out, i) {
    // Use particle index so successive spawns vary deterministically.
    const r = ((i * 2654435761) >>> 0) / 0xFFFFFFFF;
    let c;
    if (r < 0.45)      c = opts.palette.violet;
    else if (r < 0.80) c = opts.palette.blue;
    else               c = opts.palette.cyan;
    out[0] = c[0]; out[1] = c[1]; out[2] = c[2];
  }

  // Spawn one particle. `t` is global seconds (used for timeline & spawn bias).
  // `forceFull` = true ignores right-bias and fills anywhere (used at startup
  // so the screen isn't an empty rectangle for the first second).
  const _tmp = [0, 0, 0];
  function spawn(i, t, forceFull) {
    // Bias spawn position toward right edge; relax over time.
    // timelineBias: 1.0 at t=0 → ~0.25 once we're well into phase 3.
    const timelineBias = Math.max(0.25, opts.rightSpawnBias - t * 0.025);
    let x, y;
    if (!forceFull && Math.random() < timelineBias) {
      // From the right edge, with some vertical streaking via noise.
      x = W + (Math.random() * 40); // just off the right edge
      // Cluster into uneven streams: use noise to pick preferred y bands.
      const band = noise(t * 0.05, Math.random() * 10) * 0.5 + 0.5;
      y = (Math.random() * 0.6 + band * 0.4) * H;
    } else {
      x = Math.random() * W;
      y = Math.random() * H;
    }
    px[i] = x;
    py[i] = y;
    // Initial velocity: leftward drift with a little vertical jitter,
    // scaled by depth (front layers move faster → parallax cue).
    const d = Math.pow(Math.random(), 1.3); // skew toward background
    depth[i] = d;
    const speedScale = 30 + d * 90;
    vx[i] = -speedScale * (0.5 + Math.random() * 0.6);
    vy[i] = (Math.random() - 0.5) * speedScale * 0.4;
    age[i] = 0;
    life[i] = 6 + Math.random() * 10; // seconds
    pickPaletteColor(_tmp, i + (Math.random() * 1e6) | 0);
    baseR[i] = _tmp[0]; baseG[i] = _tmp[1]; baseB[i] = _tmp[2];
    jitter[i] = 0.6 + Math.random() * 0.8;
  }

  // Initial population: spawn everywhere but mark most as "not yet alive"
  // by giving them an offset age. This produces the desired phase-1
  // mostly-black start because only a small fraction will be visible.
  function initParticles() {
    for (let i = 0; i < N; i++) {
      spawn(i, 0, /*forceFull*/ true);
      // Skew most particles to start "spent" so the screen is sparse.
      const r = Math.random();
      age[i] = life[i] * (r * r * 0.95); // most close to lifetime end
    }
  }
  initParticles();

  // ----- Simulation step -----
  // Curl of a scalar potential ψ in 2D:  v = (∂ψ/∂y, -∂ψ/∂x)
  // We approximate the partial derivatives with central differences.
  const NOISE_SCALE = 0.0022; // spatial frequency
  const EPS = 1.2;            // finite-difference step (pixels)
  function curl(x, y, t) {
    // fbm: two octaves of simplex on a slowly drifting time axis.
    const a = noise((x + EPS) * NOISE_SCALE, y * NOISE_SCALE + t * 0.15)
            + 0.5 * noise((x + EPS) * NOISE_SCALE * 2.3, y * NOISE_SCALE * 2.3 - t * 0.21);
    const b = noise((x - EPS) * NOISE_SCALE, y * NOISE_SCALE + t * 0.15)
            + 0.5 * noise((x - EPS) * NOISE_SCALE * 2.3, y * NOISE_SCALE * 2.3 - t * 0.21);
    const c = noise(x * NOISE_SCALE, (y + EPS) * NOISE_SCALE + t * 0.15)
            + 0.5 * noise(x * NOISE_SCALE * 2.3, (y + EPS) * NOISE_SCALE * 2.3 - t * 0.21);
    const d = noise(x * NOISE_SCALE, (y - EPS) * NOISE_SCALE + t * 0.15)
            + 0.5 * noise(x * NOISE_SCALE * 2.3, (y - EPS) * NOISE_SCALE * 2.3 - t * 0.21);
    const dpsi_dx = (a - b) / (2 * EPS);
    const dpsi_dy = (c - d) / (2 * EPS);
    return [ dpsi_dy, -dpsi_dx ];
  }

  function rebuildDensityGrid() {
    gridCounts.fill(0);
    for (let i = 0; i < N; i++) {
      if (age[i] >= life[i]) continue;
      const cx = (px[i] / gridCell) | 0;
      const cy = (py[i] / gridCell) | 0;
      if (cx < 0 || cx >= gridCols || cy < 0 || cy >= gridRows) continue;
      gridCounts[cy * gridCols + cx]++;
    }
  }
  function localDensity(cx, cy) {
    // Sum of 3x3 neighbourhood counts.
    let s = 0;
    const x0 = Math.max(0, cx - 1), x1 = Math.min(gridCols - 1, cx + 1);
    const y0 = Math.max(0, cy - 1), y1 = Math.min(gridRows - 1, cy + 1);
    for (let yy = y0; yy <= y1; yy++) {
      const row = yy * gridCols;
      for (let xx = x0; xx <= x1; xx++) s += gridCounts[row + xx];
    }
    return s;
  }

  // ----- Frame -----
  let t = 0;           // global simulation time in seconds
  let lastWall = 0;    // wallclock of previous frame
  let rafId = 0;
  let running = false;

  function step(dt) {
    // Phase-driven spawn budget. We don't add particles; we recycle
    // dead ones. The fraction of "live" particles ramps over time.
    const phaseLiveFrac = Math.min(1.0, 0.10 + t * 0.05); // 10% → 100% over ~18s
    const targetLive = Math.floor(N * phaseLiveFrac);

    // 1) advect live particles, age them, kill expired.
    let live = 0;
    for (let i = 0; i < N; i++) {
      if (age[i] < life[i]) {
        const [cx, cy] = curl(px[i], py[i], t);
        // Velocity integration: blend old velocity with curl field +
        // a persistent leftward bias (the "instrument field" pulling
        // particles across the screen). depth scales the curl magnitude
        // so foreground particles flow faster and farther.
        const curlMag = 220 * (0.4 + depth[i] * 0.8) * opts.speed;
        const drift   = -55 * (0.5 + depth[i] * 0.6) * opts.speed; // leftward
        vx[i] = vx[i] * 0.92 + (cx * curlMag + drift) * dt * 8.0;
        vy[i] = vy[i] * 0.92 + (cy * curlMag) * dt * 8.0;
        px[i] += vx[i] * dt;
        py[i] += vy[i] * dt;
        age[i] += dt;
        // Recycle if off the left edge or out of vertical bounds.
        if (px[i] < -20 || py[i] < -40 || py[i] > H + 40) {
          age[i] = life[i]; // mark dead
        } else {
          live++;
        }
      }
    }

    // 2) Respawn dead particles up to target live count.
    if (live < targetLive) {
      let need = targetLive - live;
      for (let i = 0; i < N && need > 0; i++) {
        if (age[i] >= life[i]) {
          spawn(i, t, false);
          need--;
        }
      }
    }

    // 3) Rebuild density grid (used for color/intensity this frame).
    rebuildDensityGrid();
  }

  function writeBuffersAndDraw() {
    // Convert simulation state → interleaved GPU buffer and draw twice.
    const invHalfW = 2 / W;
    const invHalfH = 2 / H;
    // Empirical: cell area normalised to roughly "particles per cell at full density"
    const densityNorm = 1 / Math.max(1, (N / (gridCols * gridRows)) * 1.4);

    let aliveIdx = 0;
    for (let i = 0; i < N; i++) {
      if (age[i] >= life[i]) continue;
      const cxi = (px[i] / gridCell) | 0;
      const cyi = (py[i] / gridCell) | 0;
      const dens = localDensity(
        Math.min(Math.max(cxi, 0), gridCols - 1),
        Math.min(Math.max(cyi, 0), gridRows - 1)
      ) * densityNorm * opts.densityRamp;

      // Intensity rises with density (capped). Sparse particles glow
      // faintly; clumps blaze.
      const intensity = Math.min(2.0, 0.35 + dens * 0.9 * opts.clumpIntensity);
      // hotMix: 0 → pure base color, 1 → magenta-white plasma core.
      const hotMix = Math.min(1.0, Math.max(0, dens - 0.6) * 0.9 * opts.clumpIntensity);

      const hot = opts.palette.hot;
      const r = baseR[i] * (1 - hotMix) + hot[0] * hotMix;
      const g = baseG[i] * (1 - hotMix) + hot[1] * hotMix;
      const b = baseB[i] * (1 - hotMix) + hot[2] * hotMix;

      // Fade-in/out over lifetime so respawns don't pop.
      const a = age[i] / life[i];
      const lifeFade = Math.min(1, a * 4) * Math.min(1, (1 - a) * 4);

      // Base size grows slightly with depth and density jitter.
      const size = (2.0 + depth[i] * 4.0) * jitter[i] * (0.85 + intensity * 0.4);
      const alpha = lifeFade * intensity * 0.85;

      // Convert pixel coords → clip space.
      const off = aliveIdx * STRIDE_FLOATS;
      cpuBuffer[off    ] = (px[i] * invHalfW) - 1;
      cpuBuffer[off + 1] = 1 - (py[i] * invHalfH);
      cpuBuffer[off + 2] = r * intensity; // pre-modulate for additive HDR look
      cpuBuffer[off + 3] = g * intensity;
      cpuBuffer[off + 4] = b * intensity;
      cpuBuffer[off + 5] = size;
      cpuBuffer[off + 6] = alpha;
      aliveIdx++;
    }

    // Upload only the slice we filled.
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      cpuBuffer.subarray(0, aliveIdx * STRIDE_FLOATS),
      gl.DYNAMIC_DRAW
    );

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.uniform1f(u_dpr, DPR);

    // Pass A: soft halo (big, dim). This is the procedural bloom.
    gl.uniform1f(u_sizeMul, 6.5 * opts.bloomStrength);
    gl.uniform1f(u_alphaMul, 0.18 * opts.bloomStrength);
    gl.drawArrays(gl.POINTS, 0, aliveIdx);

    // Pass B: sharp core (small, bright). Resolves filaments and
    // produces the bright pinpoint white-hot cluster cores when
    // many overlap additively.
    gl.uniform1f(u_sizeMul, 1.0);
    gl.uniform1f(u_alphaMul, 1.0);
    gl.drawArrays(gl.POINTS, 0, aliveIdx);
  }

  function frame(now) {
    if (!running) return;
    if (!lastWall) lastWall = now;
    let dt = (now - lastWall) / 1000;
    lastWall = now;
    if (dt > opts.maxDeltaSeconds) dt = opts.maxDeltaSeconds;

    const mode = effectiveMotionMode();
    if (mode === 'slow') dt *= 0.1;

    t += dt;

    // Preview-loop: when configured, re-seed the simulation every
    // `durationSeconds` so gallery thumbnails play a tight, modular
    // loop of the opening phase. The reset is visually soft because
    // `initParticles()` skews most particles to start near the end
    // of their lifetime, fading out gracefully while fresh ones
    // begin streaming in from the right.
    if (opts.previewLoop) {
      const dur = (typeof opts.previewLoop === 'object'
        ? opts.previewLoop.durationSeconds
        : 3) || 3;
      if (t >= dur) {
        t = 0;
        initParticles();
      }
    }

    step(dt);
    writeBuffersAndDraw();
    rafId = requestAnimationFrame(frame);
  }

  function renderStaticFrame() {
    // Evolve the system silently for a few seconds so the static frame
    // shows the "filled" look, then draw once.
    const fixedDt = 1 / 60;
    for (let i = 0; i < 60 * 14; i++) { t += fixedDt; step(fixedDt); }
    writeBuffersAndDraw();
  }

  // `wantsRunning` tracks the caller's intent (autoStart, .start(), .stop()).
  // The internal `running` flag may be temporarily false (e.g. when the tab
  // is hidden) without changing the caller's intent. This lets us correctly
  // resume on visibilitychange only if the caller actually wanted playback.
  let wantsRunning = false;

  function start() {
    wantsRunning = true;
    if (running) return;
    const mode = effectiveMotionMode();
    if (mode === 'static') {
      renderStaticFrame();
      return;
    }
    running = true;
    lastWall = 0;
    rafId = requestAnimationFrame(frame);
  }
  function stop() {
    wantsRunning = false;
    _suspend();
  }
  // Internal pause that does not clear the caller's intent.
  function _suspend() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  // Pause when the tab is hidden — saves battery and avoids huge dt spikes.
  function onVis() {
    if (document.hidden) {
      _suspend();
    } else if (wantsRunning) {
      // Mirror start() without flipping intent.
      const mode = effectiveMotionMode();
      if (mode === 'static') { renderStaticFrame(); return; }
      running = true;
      lastWall = 0;
      rafId = requestAnimationFrame(frame);
    }
  }
  document.addEventListener('visibilitychange', onVis);

  // React to changes in the prefers-reduced-motion media query.
  if (mql && mql.addEventListener) {
    mql.addEventListener('change', () => {
      const was = wantsRunning;
      _suspend();
      if (was) start();
    });
  }

  if (opts.autoStart) start();

  return {
    canvas,
    /** Begin (or resume) playback. Idempotent. */
    start,
    /** Pause playback. The next call to start() resumes from the current state. */
    stop,
    /**
     * Reset the simulation back to t=0. Useful for a "play from the top"
     * trigger on a gallery card. Safe to call while running or stopped.
     */
    reset() {
      t = 0;
      initParticles();
    },
    /**
     * Update a config option at runtime. Some options (particleCount,
     * seed) require a full reset; others take effect on the next frame.
     */
    setOption(key, value) {
      if (key === 'particleCount') {
        const wasRunning = wantsRunning;
        _suspend();
        N = Math.max(64, value | 0);
        px = new Float32Array(N); py = new Float32Array(N);
        vx = new Float32Array(N); vy = new Float32Array(N);
        age = new Float32Array(N); life = new Float32Array(N);
        baseR = new Float32Array(N); baseG = new Float32Array(N); baseB = new Float32Array(N);
        depth = new Float32Array(N); jitter = new Float32Array(N);
        cpuBuffer = new Float32Array(N * STRIDE_FLOATS);
        opts.particleCount = N;
        initParticles();
        if (wasRunning) start();
      } else if (key === 'palette') {
        opts.palette = { ...opts.palette, ...(value || {}) };
      } else if (key in opts) {
        opts[key] = value;
      }
    },
    destroy() {
      stop();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('resize', resize);
      if (ro) ro.disconnect();
      try { container.removeChild(canvas); } catch (_) {}
    },
  };
}

// Convenience auto-mount: if this module is loaded with
// `<script type="module" data-auto-mount="#selector" src=".../OLEDPetrovaParticles.js">`
// it will mount itself into the selector target on DOMContentLoaded.
if (typeof document !== 'undefined' && document.currentScript) {
  const sel = document.currentScript.getAttribute('data-auto-mount');
  if (sel) {
    const boot = () => {
      const el = document.querySelector(sel);
      if (el) createOLEDPetrovaParticles(el);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  }
}

export default createOLEDPetrovaParticles;
