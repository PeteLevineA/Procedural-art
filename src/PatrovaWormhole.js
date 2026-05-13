/* =====================================================================
 * PatrovaWormhole
 * ---------------------------------------------------------------------
 * A 100% procedural, OLED-friendly 3D wormhole ride implemented in raw
 * WebGL2 with custom shaders, additive blending, and instanced
 * velocity-stretched streak quads.
 *
 * This module is *intentionally* a fresh, isolated implementation: it
 * does not import or depend on `OLEDPetrovaParticles.js`. The visual
 * grammar is different — instead of a 2D curl-noise field, the camera
 * literally flies along a 3D parametric spline through a tube of
 * neon-coloured particles arranged in rings, ribbons, and bottom-up
 * streamers.
 *
 * High-level architecture
 * -----------------------
 *  1. Parametric path
 *     `pathPoint(s)` returns a 3D position for any scalar `s` along the
 *     wormhole. Built from a small sum of out-of-phase sinusoids so the
 *     track curves and banks like a roller-coaster — never a straight
 *     starfield. The camera advances along this path; particles live
 *     at fixed (longitudinal-offset, tube-angle, radius) positions
 *     relative to it, so the camera is moving through them in 3D space.
 *
 *  2. Particles
 *     Stored in a single GPU-side `ArrayBuffer` of per-instance
 *     attributes (no per-frame CPU upload). The vertex shader places
 *     each particle in world space every frame from these static
 *     attributes plus the current `cameraS` uniform — that gives us a
 *     stable, recycling tube where particles "behind" the camera wrap
 *     to the front automatically.
 *
 *  3. Velocity-stretched streaks
 *     Each particle is rendered as an *instanced quad*, not a point
 *     sprite. The vertex shader computes the particle's previous-frame
 *     world position from the previous `cameraS`, projects both points
 *     to NDC, and stretches the quad along that screen-space velocity
 *     vector. Length scales with speed × streakLength × depth, so near
 *     particles streak past the camera and distant particles read as a
 *     luminous corridor ahead. This is *real* depth-aware motion, not a
 *     scaled point sprite.
 *
 *  4. Two-pass bloom-without-postprocess
 *     Each frame the same particle buffer is drawn twice with additive
 *     blending:
 *       - "halo" pass: large, low-alpha Gaussian — the soft bloom that
 *         wraps clusters and forms the glowing tunnel walls.
 *       - "core" pass: small, high-alpha sharp dot — the bright pinpoint
 *         at the heart of each streak, plus occasional white-hot cores.
 *     Additive accumulation of soft Gaussians is mathematically
 *     equivalent to a kernel density estimate, so dense ribbons bloom
 *     brighter than sparse regions *for free*, with no offscreen FBO.
 *
 *  5. Five-phase speed ramp
 *     A single `phase(t)` function returns:
 *       speed  — forward velocity along the path
 *       bank   — left/right banking strength
 *       streak — streak length multiplier
 *       alive  — global brightness (0 during the fade-to-black)
 *     The phases are: slow launch → aggressive acceleration → peak
 *     velocity → sudden landing (decel slam) → fade to black. Smooth-
 *     step easing between phases. After the fade, the cycle restarts.
 *
 *  6. Reduced motion
 *     `prefers-reduced-motion: reduce` renders a single evolved still
 *     of the peak-velocity frame and does not animate.
 *
 * Every pixel is generated at runtime in the shaders. There are no
 * raster images, sprites, textures, or video assets anywhere in this
 * file — the particle sprite itself is a Gaussian computed from
 * gl_FragCoord-derived UVs in the fragment shader.
 * =====================================================================
 */

/* ---------------------------------------------------------------------
 * Defaults — also documents every configurable knob.
 * ------------------------------------------------------------------- */
const DEFAULTS = {
  /** How many particles populate the tube. Halo + core = 2 draws each. */
  particleCount  : 8000,

  /** Average radius of the tube in world units. */
  tunnelRadius   : 6.0,

  /** Linear playback speed multiplier; 1.0 = author-intended pace. */
  speed          : 1.0,

  /**
   * Phase durations in seconds. Sum is the full loop period and is
   * authored to total exactly 30s so the timeline reads as:
   *   0– 6 s  slow entry
   *   6–18 s  aggressive acceleration
   *  18–25 s  peak-speed tunnel ride
   *  25–28 s  sudden landing / deceleration
   *  28–30 s  particles dissipate into black
   * The fade phase ends in pure black so the loop boundary is invisible,
   * and `hold` is zero — there is no inky pause padding the 30 s window.
   */
  speedRamp : {
    launch  : 6.0,    // 0– 6 s : slow drift, sparse rise from bottom
    accel   : 12.0,   // 6–18 s : aggressive ramp toward peak; banking awakens
    peak    : 7.0,    // 18–25 s : dense neon ribbons whip past at peak velocity
    landing : 3.0,    // 25–28 s : sudden decel slam; new spawns suppressed
    fade    : 2.0,    // 28–30 s : remaining particles dissipate to OLED black
    hold    : 0.0,    // no pause — fade lands exactly at 30 s
  },

  /** Overall bloom/halo brightness multiplier. */
  bloomStrength  : 1.0,

  /**
   * Maximum streak length in NDC units at peak velocity. Distant
   * particles stay short even at peak; near particles take the full
   * length.
   */
  streakLength   : 0.55,

  /**
   * Colour palette. Each entry is linear RGB in 0..1. The renderer
   * picks one band per particle and mixes toward `hot` for the densest
   * cores. Tuned for OLED: pure black background, saturated neons.
   */
  palette : {
    blue   : [0.20, 0.55, 1.00], // electric neon blue
    purple : [0.55, 0.25, 1.00], // neon purple
    magenta: [1.00, 0.25, 0.95], // hot magenta
    hot    : [1.00, 1.00, 1.00], // white-hot core
  },

  /**
   * Curvature of the camera spline. Larger amplitudes = more
   * pronounced roller-coaster turns. Frequencies are in cycles per
   * world unit along `s`.
   */
  pathCurvature : {
    ampX  : 4.5, freqX  : 0.06,
    ampY  : 2.5, freqY  : 0.045,
    ampX2 : 2.0, freqX2 : 0.14,
    ampY2 : 1.5, freqY2 : 0.11,
    bank  : 1.1, // multiplier on the auto-computed roll
  },

  /**
   * Fraction (0..1) of particles biased to originate near the bottom
   * of the tube ring. They emerge from below the camera and stream up
   * into the corridor — the "particles rise from the front-bottom"
   * requirement.
   */
  bottomOriginBias : 0.45,

  /** Duration in seconds of the landing fade-to-black. */
  landingFadeDuration : 3.0,

  /**
   * 'auto'   detect prefers-reduced-motion → render a static peak frame
   * 'off'    ignore the user preference; always animate
   * 'static' force the static peak frame
   * 'slow'   animate at 10% speed
   */
  reducedMotion  : 'auto',

  /** Start playing immediately on mount. */
  autoStart      : true,

  /**
   * If truthy, animate a short modular loop suitable for a gallery
   * card preview. Accepts `true` (defaults to 3 s) or
   * `{ durationSeconds: number }`.
   */
  previewLoop    : false,
};

/* ---------------------------------------------------------------------
 * Tiny utilities. We avoid pulling in a matrix library — the path of
 * needed operations is short enough to write inline.
 * ------------------------------------------------------------------- */
function hash(i, seed) {
  // Cheap deterministic per-particle pseudo-random (0..1). Two
  // independent hashes are produced by varying `seed`.
  let x = ((i + 1) * 0x9E3779B1) ^ (seed * 0x85EBCA6B);
  x = Math.imul(x ^ (x >>> 16), 0x7FEB352D);
  x = Math.imul(x ^ (x >>> 15), 0x846CA68B);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Build a perspective projection matrix in column-major order.
 * @param {number} fovy radians
 */
function perspective(out, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  out[0]  = f / aspect; out[1]  = 0; out[2]  = 0;                       out[3]  = 0;
  out[4]  = 0;          out[5]  = f; out[6]  = 0;                       out[7]  = 0;
  out[8]  = 0;          out[9]  = 0; out[10] = (far + near) * nf;       out[11] = -1;
  out[12] = 0;          out[13] = 0; out[14] = 2 * far * near * nf;     out[15] = 0;
  return out;
}

/** Right-handed look-at view matrix, column-major. */
function lookAt(out, ex, ey, ez, cx, cy, cz, ux, uy, uz) {
  let zx = ex - cx, zy = ey - cy, zz = ez - cz;
  let zl = 1 / Math.hypot(zx, zy, zz);
  zx *= zl; zy *= zl; zz *= zl;
  // x = up × z
  let xx = uy * zz - uz * zy;
  let xy = uz * zx - ux * zz;
  let xz = ux * zy - uy * zx;
  const xl = 1 / Math.hypot(xx, xy, xz);
  xx *= xl; xy *= xl; xz *= xl;
  // y = z × x  (orthonormal, accounts for roll baked into `ux,uy,uz`)
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  out[0]=xx; out[1]=yx; out[2]=zx;  out[3]=0;
  out[4]=xy; out[5]=yy; out[6]=zy;  out[7]=0;
  out[8]=xz; out[9]=yz; out[10]=zz; out[11]=0;
  out[12]=-(xx*ex + xy*ey + xz*ez);
  out[13]=-(yx*ex + yy*ey + yz*ez);
  out[14]=-(zx*ex + zy*ey + zz*ez);
  out[15]=1;
  return out;
}

function mul4x4(out, a, b) {
  const a00=a[0],a01=a[1],a02=a[2],a03=a[3];
  const a10=a[4],a11=a[5],a12=a[6],a13=a[7];
  const a20=a[8],a21=a[9],a22=a[10],a23=a[11];
  const a30=a[12],a31=a[13],a32=a[14],a33=a[15];
  for (let i = 0; i < 4; i++) {
    const b0 = b[i*4], b1 = b[i*4+1], b2 = b[i*4+2], b3 = b[i*4+3];
    out[i*4  ] = b0*a00 + b1*a10 + b2*a20 + b3*a30;
    out[i*4+1] = b0*a01 + b1*a11 + b2*a21 + b3*a31;
    out[i*4+2] = b0*a02 + b1*a12 + b2*a22 + b3*a32;
    out[i*4+3] = b0*a03 + b1*a13 + b2*a23 + b3*a33;
  }
  return out;
}

/* ---------------------------------------------------------------------
 * Shader sources
 * -------------------------------------------------------------------
 * The vertex shader does ALL the heavy lifting:
 *   - reconstructs the camera-relative tube position for each particle
 *   - reconstructs the *previous* frame's position
 *   - projects both, builds a screen-space velocity basis, and
 *     stretches the per-vertex quad corner along it
 * The fragment shader is a procedural Gaussian times the particle's
 * RGB — no textures, no sampling.
 * ------------------------------------------------------------------- */
const VERT_SRC = /* glsl */ `#version 300 es
precision highp float;

// Per-vertex (4 corners of the unit quad, in [-1, +1] x [-1, +1])
in vec2 aCorner;

// Per-instance, packed into two vec4 streams to keep attribute count low.
//   aTubeA = vec4(longitudinalOffset, theta, radialJitter, sizeJitter)
//   aTubeB = vec4(rotateRate, colorMix, hotMix, bottomFlag)
//   aColor = vec3(baseR, baseG, baseB)
in vec4 aTubeA;
in vec4 aTubeB;
in vec3 aColor;

// Camera + state.
uniform mat4  uProj;
uniform mat4  uView;
uniform mat4  uViewPrev;        // last frame's view, for streak direction
uniform float uCameraS;         // current arc-length along the path
uniform float uCameraSPrev;     // previous-frame arc-length
uniform float uTunnelRadius;
uniform float uTime;
uniform float uBank;            // bank angle in radians at the camera
uniform float uBankPrev;
uniform float uStreakLength;    // 0..1 ish, multiplier on screen-space stretch
uniform float uSizeScale;       // base point size (in NDC units) for this pass
uniform float uIsCorePass;      // 1.0 for sharp core pass, 0.0 for halo
uniform float uAlive;           // global brightness (0..1)
uniform vec2  uViewport;        // pixel resolution

uniform vec4  uPathFreqs;       // x,y,x2,y2 frequencies
uniform vec4  uPathAmps;        // x,y,x2,y2 amplitudes

// Output to fragment shader.
out vec2 vUV;        // quad-local UV in [-1, +1] for the sprite mask
out vec3 vColor;     // final tinted colour
out float vAlpha;    // depth/distance-modulated alpha

// 3D point on the camera spline. Designed to read as a roller-coaster:
// a primary low-frequency S-curve plus a higher-frequency rider for
// micro-banks. Forward axis is +Z; the camera looks toward -Z so we
// negate when placing world geometry ahead of it.
vec3 pathPoint(float s) {
  float x = sin(s * uPathFreqs.x) * uPathAmps.x
          + sin(s * uPathFreqs.z + 1.7) * uPathAmps.z;
  float y = sin(s * uPathFreqs.y + 0.9) * uPathAmps.y
          + cos(s * uPathFreqs.w + 0.3) * uPathAmps.w;
  // Camera flies toward -Z; let s grow with travelled distance and place
  // the world at -s so larger s = further "down the track".
  return vec3(x, y, -s);
}

// Analytic-ish tangent via finite difference. Cheap and stable.
vec3 pathTangent(float s) {
  vec3 p1 = pathPoint(s + 0.05);
  vec3 p0 = pathPoint(s - 0.05);
  return normalize(p1 - p0);
}

// Build an orthonormal tube frame at arc-length s with banking
// applied. bank is the desired roll angle around the tangent.
void tubeFrame(float s, float bank, out vec3 T, out vec3 N, out vec3 B) {
  T = pathTangent(s);
  // Reference up = world Y, projected away from T then renormalised.
  vec3 refUp = vec3(0.0, 1.0, 0.0);
  vec3 N0 = normalize(refUp - T * dot(refUp, T));
  vec3 B0 = cross(T, N0);
  float c = cos(bank), si = sin(bank);
  N =  N0 * c + B0 * si;
  B = -N0 * si + B0 * c;
}

// World position of this particle for a given cameraS and bank.
vec3 particleWorldPos(float cameraS, float bank) {
  float sOffset = aTubeA.x;       // longitudinal offset ahead of camera
  float theta   = aTubeA.y + aTubeB.x * uTime; // gentle theta rotation
  float rJ      = aTubeA.z;       // radial jitter
  float bottom  = aTubeB.w;       // 0 or 1 — bottom-origin bias flag

  // Particles live "ahead" of the camera. We add their sOffset to
  // cameraS and read pathPoint there. When sOffset goes negative
  // (behind), wrap so the tube recycles seamlessly.
  float sLen = 60.0; // visible length of tube ahead/behind
  float sLocal = sOffset;
  // wrap into [-sLen*0.25, sLen*0.75] so 1/4 of the tube extends behind
  float lo = -sLen * 0.25;
  sLocal = lo + mod(sLocal - lo, sLen);

  float s = cameraS + sLocal;

  // Bottom-bias particles emerge from below: their radius shrinks the
  // closer they are to the camera (so the stream "spreads upward into"
  // the corridor instead of clipping). Top-tube particles use a stable
  // radius. Both have a small low-frequency wobble for organic ribbons.
  float t01   = clamp(sLocal / sLen + 0.25, 0.0, 1.0); // 0 near camera, 1 far ahead
  float wobble = 0.6 * sin(s * 0.35 + theta * 2.0) +
                 0.4 * cos(s * 0.18 + aTubeB.y * 6.28);
  float r = uTunnelRadius + rJ + wobble * 0.7;

  // Bottom stream: bias theta toward the lower arc and reduce radius as
  // we approach the camera so streamers fold in toward the corridor.
  if (bottom > 0.5) {
    // pull theta toward -pi/2 (bottom)
    float bias = mix(theta, -1.5707963, 0.65);
    theta = bias + 0.5 * sin(s * 0.4 + aTubeB.y * 4.0);
    r *= mix(0.55, 1.05, t01); // small near camera, larger far ahead
  }

  vec3 T, N, B;
  tubeFrame(s, bank, T, N, B);

  vec3 c = pathPoint(s);
  return c + (cos(theta) * N + sin(theta) * B) * r;
}

void main() {
  vec3 wp     = particleWorldPos(uCameraS,     uBank);
  vec3 wpPrev = particleWorldPos(uCameraSPrev, uBankPrev);

  vec4 clip     = uProj * uView     * vec4(wp,     1.0);
  vec4 clipPrev = uProj * uViewPrev * vec4(wpPrev, 1.0);

  // Skip particles behind the camera or too close (clip.w <= 0).
  if (clip.w <= 0.05) {
    // Collapse the quad to a point off-screen so it discards cheaply.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0;
    vColor = vec3(0.0);
    vUV = vec2(0.0);
    return;
  }

  // NDC and the screen-space velocity vector.
  vec2 ndc     = clip.xy / clip.w;
  vec2 ndcPrev = clipPrev.xy / max(clipPrev.w, 0.05);
  vec2 vel     = ndc - ndcPrev;

  // Cap stretch and scale by streak length. Distance falloff: nearby
  // particles (small clip.w) have large screen velocity and streak the
  // most; distant ones (large clip.w) barely move on screen and read
  // as luminous pinpoints.
  float velLen = length(vel);
  float maxStreak = uStreakLength * (uIsCorePass > 0.5 ? 0.7 : 1.0);
  float streakAmt = clamp(velLen, 0.0, maxStreak);
  vec2  streakDir = velLen > 1e-5 ? vel / velLen : vec2(1.0, 0.0);
  vec2  perpDir   = vec2(-streakDir.y, streakDir.x);

  // Base sprite size scales with 1/clip.w so faraway particles look
  // small. We also widen the halo by uSizeScale.
  float aspect = uViewport.x / max(uViewport.y, 1.0);
  float baseSize = uSizeScale / max(clip.w, 0.5);

  // Build the corner offset in NDC.
  // aCorner.x ∈ [-1, +1] is the *along-streak* axis.
  // aCorner.y ∈ [-1, +1] is the *across-streak* axis.
  vec2 offset = streakDir * (aCorner.x * (baseSize + streakAmt))
              + perpDir   * (aCorner.y * baseSize);
  // Anisotropic correction so the *across-streak* axis stays circular
  // in pixels regardless of viewport aspect. The along-streak axis is
  // intentionally left in NDC so streak lengths read consistently.
  offset.y *= aspect;

  vec2 finalNDC = ndc + offset;
  gl_Position = vec4(finalNDC * clip.w, clip.z, clip.w);

  vUV = aCorner; // pass corner as UV so frag can mask the Gaussian

  // ---- Colour & alpha ----
  // Depth-based brightness: things close to the camera burn brighter
  // for the "near streak past your face" feel, distant tunnel walls
  // fade toward black to give the corridor a real vanishing point.
  float dist = clip.w;
  float nearF = smoothstep(35.0, 2.0, dist);   // 1 near, 0 far
  float farF  = smoothstep(60.0, 10.0, dist);  // 1 well-inside the tube

  // Hot core mix: a small fraction of particles burst white-hot when
  // densely clustered. aTubeB.z is the per-particle hot-mix factor.
  float hotMix = aTubeB.z;
  vec3 hot = vec3(1.0, 1.0, 1.0);
  vec3 col = mix(aColor, hot, hotMix * (0.4 + 0.6 * nearF));

  // Streak makes the core pass brighter (denser additive contribution).
  float alpha = (uIsCorePass > 0.5 ? 0.95 : 0.18) * farF;
  alpha *= mix(0.5, 1.0, nearF);
  alpha *= uAlive;

  vColor = col * (uIsCorePass > 0.5 ? 1.0 : 0.55);
  vAlpha = alpha;
}
`;

const FRAG_SRC = /* glsl */ `#version 300 es
precision highp float;

in vec2  vUV;
in vec3  vColor;
in float vAlpha;

uniform float uBloomStrength;
uniform float uIsCorePass;

out vec4 fragColor;

void main() {
  // Quad-local distance from centre, normalised so the streak is an
  // ellipse: tight across, loose along.
  float along  = vUV.x;
  float across = vUV.y;

  // Soft Gaussian across-axis; cosine-shaped along-axis so the tail
  // fades to black at the ends of the streak.
  float gAcross = exp(-3.0 * across * across);
  float gAlong  = exp(-1.6 * along * along);
  float mask    = gAcross * gAlong;

  // Sharper core for the core pass; broader for the halo pass.
  if (uIsCorePass > 0.5) {
    mask = pow(mask, 2.0);
  } else {
    mask = pow(mask, 0.75);
  }

  // Additive accumulation: no real alpha blending against background,
  // we just push light into the framebuffer.
  vec3 lit = vColor * mask * vAlpha * uBloomStrength;
  fragColor = vec4(lit, 1.0);
}
`;

/* ---------------------------------------------------------------------
 * Main factory.
 * ------------------------------------------------------------------- */
export function createPatrovaWormhole(container, userOpts = {}) {
  if (!container) throw new Error('createPatrovaWormhole: container required');

  // Deep-ish merge for the nested config objects.
  const opts = {
    ...DEFAULTS,
    ...userOpts,
    speedRamp     : { ...DEFAULTS.speedRamp,     ...(userOpts.speedRamp     || {}) },
    palette       : { ...DEFAULTS.palette,       ...(userOpts.palette       || {}) },
    pathCurvature : { ...DEFAULTS.pathCurvature, ...(userOpts.pathCurvature || {}) },
  };

  /* ----------------- Canvas + GL context ----------------- */
  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width  = '100%';
  canvas.style.height = '100%';
  // OLED-black backdrop. Both CSS *and* the GL clearColor are black so
  // there is no flash before the first frame is drawn.
  canvas.style.background = '#000';
  container.appendChild(canvas);

  const gl = canvas.getContext('webgl2', {
    alpha             : false, // we own the background; cheaper compositing
    antialias         : false, // soft Gaussians don't need MSAA
    premultipliedAlpha: false,
    powerPreference   : 'high-performance',
    preserveDrawingBuffer: false,
  });

  if (!gl) {
    // Graceful fallback: leave the container black. This matches the
    // "OLED" spirit and never throws into the host page.
    canvas.style.background = '#000';
    return makeNoopHandle(canvas, container);
  }

  /* ----------------- Shader program ----------------- */
  const program = compileProgram(gl, VERT_SRC, FRAG_SRC);
  if (!program) {
    return makeNoopHandle(canvas, container);
  }

  const loc = {
    aCorner   : gl.getAttribLocation(program, 'aCorner'),
    aTubeA    : gl.getAttribLocation(program, 'aTubeA'),
    aTubeB    : gl.getAttribLocation(program, 'aTubeB'),
    aColor    : gl.getAttribLocation(program, 'aColor'),

    uProj         : gl.getUniformLocation(program, 'uProj'),
    uView         : gl.getUniformLocation(program, 'uView'),
    uViewPrev     : gl.getUniformLocation(program, 'uViewPrev'),
    uCameraS      : gl.getUniformLocation(program, 'uCameraS'),
    uCameraSPrev  : gl.getUniformLocation(program, 'uCameraSPrev'),
    uTunnelRadius : gl.getUniformLocation(program, 'uTunnelRadius'),
    uTime         : gl.getUniformLocation(program, 'uTime'),
    uBank         : gl.getUniformLocation(program, 'uBank'),
    uBankPrev     : gl.getUniformLocation(program, 'uBankPrev'),
    uStreakLength : gl.getUniformLocation(program, 'uStreakLength'),
    uSizeScale    : gl.getUniformLocation(program, 'uSizeScale'),
    uIsCorePass   : gl.getUniformLocation(program, 'uIsCorePass'),
    uAlive        : gl.getUniformLocation(program, 'uAlive'),
    uViewport     : gl.getUniformLocation(program, 'uViewport'),
    uPathFreqs    : gl.getUniformLocation(program, 'uPathFreqs'),
    uPathAmps     : gl.getUniformLocation(program, 'uPathAmps'),
    uBloomStrength: gl.getUniformLocation(program, 'uBloomStrength'),
  };

  /* ----------------- Geometry: a unit quad ----------------- */
  // 4 corners, 2 triangles via element indices.
  const quadVerts = new Float32Array([
    -1, -1,
     1, -1,
    -1,  1,
     1,  1,
  ]);
  const quadIndices = new Uint16Array([0, 1, 2, 1, 3, 2]);

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const quadVBO = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO);
  gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(loc.aCorner);
  gl.vertexAttribPointer(loc.aCorner, 2, gl.FLOAT, false, 0, 0);

  const quadIBO = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quadIBO);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, quadIndices, gl.STATIC_DRAW);

  /* ----------------- Per-instance attribute buffers ----------------- */
  let N = Math.max(64, opts.particleCount | 0);
  // aTubeA = vec4(sOffset, theta, rJitter, sizeJitter)
  // aTubeB = vec4(rotateRate, phase, hotMix, bottomFlag)
  // aColor = vec3(r, g, b)
  let tubeA  = new Float32Array(N * 4);
  let tubeB  = new Float32Array(N * 4);
  let colors = new Float32Array(N * 3);

  const tubeABuf  = gl.createBuffer();
  const tubeBBuf  = gl.createBuffer();
  const colorBuf  = gl.createBuffer();

  function bindInstanceAttribs() {
    gl.bindBuffer(gl.ARRAY_BUFFER, tubeABuf);
    gl.enableVertexAttribArray(loc.aTubeA);
    gl.vertexAttribPointer(loc.aTubeA, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(loc.aTubeA, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, tubeBBuf);
    gl.enableVertexAttribArray(loc.aTubeB);
    gl.vertexAttribPointer(loc.aTubeB, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(loc.aTubeB, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuf);
    gl.enableVertexAttribArray(loc.aColor);
    gl.vertexAttribPointer(loc.aColor, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(loc.aColor, 1);
  }

  /**
   * Initialise (or re-initialise) the static per-particle attributes.
   * Particles are organised into ribbons of ~8 by sharing a base theta
   * & sOffset, then offset slightly — this is what produces the
   * arc/clump look in the reference image without per-frame CPU work.
   */
  function initParticles() {
    tubeA  = new Float32Array(N * 4);
    tubeB  = new Float32Array(N * 4);
    colors = new Float32Array(N * 3);

    const palette = opts.palette;
    const sLen = 60.0;
    const bottomBias = Math.max(0, Math.min(1, opts.bottomOriginBias));

    let i = 0;
    while (i < N) {
      // Ribbon of up to 8 particles sharing a base theta + sOffset.
      const groupSize = 4 + ((hash(i, 11) * 5) | 0); // 4..8
      const baseTheta = hash(i, 1) * Math.PI * 2;
      const baseS     = -sLen * 0.25 + hash(i, 2) * sLen;
      const rGroup    = (hash(i, 3) - 0.5) * 1.6; // small radial jitter for the whole ribbon
      const groupHotChance = hash(i, 4);
      const groupBottom = hash(i, 5) < bottomBias ? 1 : 0;

      // Pick a colour band per group.
      const bandRoll = hash(i, 6);
      let band;
      if      (bandRoll < 0.45) band = palette.blue;
      else if (bandRoll < 0.75) band = palette.purple;
      else                      band = palette.magenta;

      for (let k = 0; k < groupSize && i < N; k++, i++) {
        const local = (k / groupSize) - 0.5;
        const sOffset  = baseS + local * 1.6 + (hash(i, 7) - 0.5) * 0.4;
        const theta    = baseTheta + local * 0.18 + (hash(i, 8) - 0.5) * 0.12;
        const rJitter  = rGroup + (hash(i, 9) - 0.5) * 0.8;
        const sizeJ    = 0.7 + hash(i, 10) * 0.7;

        const rotateRate = (hash(i, 12) - 0.5) * 0.18; // slow theta drift
        const phase      = hash(i, 13);

        // Hot cores: rare overall, denser inside groups already flagged
        // hot-prone. Combined with the additive halo this gives the
        // white-hot pin-points in the reference image.
        const hotRoll = hash(i, 14);
        const hot = groupHotChance > 0.92 && hotRoll > 0.55 ? 1.0 :
                    (hotRoll > 0.985 ? 0.85 : 0.0);

        tubeA[i*4+0] = sOffset;
        tubeA[i*4+1] = theta;
        tubeA[i*4+2] = rJitter;
        tubeA[i*4+3] = sizeJ;

        tubeB[i*4+0] = rotateRate;
        tubeB[i*4+1] = phase;
        tubeB[i*4+2] = hot;
        tubeB[i*4+3] = groupBottom;

        // Slight per-particle colour jitter inside the band.
        const jr = (hash(i, 15) - 0.5) * 0.08;
        const jg = (hash(i, 16) - 0.5) * 0.08;
        const jb = (hash(i, 17) - 0.5) * 0.08;
        colors[i*3+0] = Math.max(0, band[0] + jr);
        colors[i*3+1] = Math.max(0, band[1] + jg);
        colors[i*3+2] = Math.max(0, band[2] + jb);
      }
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, tubeABuf);
    gl.bufferData(gl.ARRAY_BUFFER, tubeA, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, tubeBBuf);
    gl.bufferData(gl.ARRAY_BUFFER, tubeB, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuf);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);

    bindInstanceAttribs();
  }

  initParticles();
  gl.bindVertexArray(null);

  /* ----------------- Reduced motion detection ----------------- */
  const mql = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

  function resolveMotionMode() {
    if (opts.reducedMotion === 'off')    return 'normal';
    if (opts.reducedMotion === 'static') return 'static';
    if (opts.reducedMotion === 'slow')   return 'slow';
    // 'auto'
    if (mql && mql.matches) return 'static';
    return 'normal';
  }

  /* ----------------- Sizing ----------------- */
  const dpr = () => Math.min(window.devicePixelRatio || 1, 2);
  function resize() {
    const w = container.clientWidth  || canvas.clientWidth  || window.innerWidth;
    const h = container.clientHeight || canvas.clientHeight || window.innerHeight;
    const px = Math.max(1, Math.floor(w * dpr()));
    const py = Math.max(1, Math.floor(h * dpr()));
    if (canvas.width !== px || canvas.height !== py) {
      canvas.width  = px;
      canvas.height = py;
    }
  }
  resize();

  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(resize);
    ro.observe(container);
  }
  window.addEventListener('resize', resize);

  /* ----------------- Animation loop & phase mapping ----------------- */
  // Total loop length so we can wrap `t` and the preview-loop modulus.
  const ramp = opts.speedRamp;
  const T_LAUNCH  = ramp.launch;
  const T_ACCEL   = T_LAUNCH + ramp.accel;
  const T_PEAK    = T_ACCEL  + ramp.peak;
  const T_LAND    = T_PEAK   + ramp.landing;
  const T_FADE    = T_LAND   + ramp.fade;
  const T_TOTAL   = T_FADE   + ramp.hold;

  // Preview mode: short loop. We just compress the phase mapping.
  const previewDuration =
    (opts.previewLoop && opts.previewLoop.durationSeconds) ||
    (opts.previewLoop ? 3.0 : 0);
  const useLoopT = previewDuration > 0;

  /**
   * Return phase output for absolute time `t` in seconds.
   * speed  — current arc-length velocity (units/sec)
   * bank   — current banking roll (radians)
   * streak — streak-length multiplier (0..1+)
   * alive  — global brightness multiplier (0..1)
   * density — global brightness used during slow launch to keep things sparse
   */
  function phase(tSec) {
    let t = tSec;
    if (useLoopT) {
      // Compress the full timeline into a loop of `previewDuration` s.
      t = (tSec % previewDuration) * (T_TOTAL / previewDuration);
    } else {
      t = tSec % T_TOTAL;
    }

    const peakSpeed = 24.0; // world units per second along the path
    let speed, streak, alive, density, bank;

    if (t < T_LAUNCH) {
      // Phase 1: slow entry (0–6 s). Start sparse and mostly black; the
      // corridor is just a hint of structure with a few scattered neons.
      const u = t / Math.max(0.0001, T_LAUNCH);
      const e = smoothstep(0.0, 1.0, u);
      speed   = 0.6 + e * 4.7;
      streak  = 0.04 + e * 0.11;
      alive   = 0.20 + e * 0.55;   // open in near-black, brighten gently
      density = 0.18 + e * 0.55;   // very few visible particles at t=0
      bank    = e * 0.25;          // very gentle
    } else if (t < T_ACCEL) {
      // Phase 2: aggressive acceleration (6–18 s). Speed and density
      // both ramp hard; banking awakens; streaks lengthen.
      const u = (t - T_LAUNCH) / Math.max(0.0001, ramp.accel);
      const e = smoothstep(0.0, 1.0, u);
      speed   = 5.3 + e * (peakSpeed - 5.3);
      streak  = 0.15 + e * 0.60;
      alive   = 0.75 + e * 0.25;
      density = 0.73 + e * 0.27;
      bank    = 0.25 + e * 0.75;
    } else if (t < T_PEAK) {
      // Phase 3: peak-speed tunnel ride (18–25 s). Dense neon storm.
      const u = (t - T_ACCEL) / Math.max(0.0001, ramp.peak);
      speed   = peakSpeed * (0.95 + 0.05 * Math.sin(u * 5.0));
      streak  = 0.78;
      alive   = 1.0;
      density = 1.0;
      bank    = 1.0 + 0.5 * Math.sin(u * 3.1);
    } else if (t < T_LAND) {
      // Phase 4: sudden landing slam (25–28 s). Stop spawning new
      // particles — density falls quickly — while existing streaks
      // decelerate. Quintic falloff makes the stop feel violent.
      const u = (t - T_PEAK) / Math.max(0.0001, ramp.landing);
      const e = smoothstep(0.0, 1.0, u);
      const eFast = 1 - Math.pow(1 - e, 5);
      speed   = peakSpeed * (1 - eFast);
      streak  = 0.78 * (1 - eFast);
      alive   = 1.0 - 0.25 * e;
      density = 1.0 - 0.85 * e;    // no new spawns as we land
      bank    = (1.0 - e) * (1.0 + 0.5 * Math.sin(u * 3.1));
    } else if (t < T_FADE) {
      // Phase 5: dissipate to black (28–30 s). No forward motion; the
      // remaining particles fade out into pure OLED black.
      const u = (t - T_LAND) / Math.max(0.0001, ramp.fade);
      const e = smoothstep(0.0, 1.0, u);
      speed   = 0.4 * (1 - e);
      streak  = 0.04 * (1 - e);
      alive   = (1 - e) * 0.6;
      density = 0.15 * (1 - e);
      bank    = 0.0;
    } else {
      // Safety branch: with the default 30 s ramp `hold` is 0 so this
      // is unreachable, but a non-zero `hold` override would land here
      // as a fully black pause before the loop restarts.
      speed = 0.0; streak = 0.0; alive = 0.0; density = 0.0; bank = 0.0;
    }

    return { speed, streak, alive, density, bank };
  }

  /* ----------------- State ----------------- */
  let raf = 0;
  let wantsRunning = false;
  let mode = resolveMotionMode();
  let t = 0;
  let lastFrame = 0;
  let cameraS = 0;
  let cameraSPrev = 0;
  let bankPrev = 0;

  const proj      = new Float32Array(16);
  const view      = new Float32Array(16);
  const viewPrev  = new Float32Array(16);

  /** Compute the camera basis and write a view matrix into `out`. */
  function buildView(out, sNow, bank) {
    const pc = opts.pathCurvature;
    // Match shader's pathPoint exactly so on-CPU and on-GPU agree about
    // where the camera *is*.
    function p(s) {
      const x = Math.sin(s * pc.freqX) * pc.ampX
              + Math.sin(s * pc.freqX2 + 1.7) * pc.ampX2;
      const y = Math.sin(s * pc.freqY + 0.9) * pc.ampY
              + Math.cos(s * pc.freqY2 + 0.3) * pc.ampY2;
      return [x, y, -s];
    }
    const p1 = p(sNow + 0.05);
    const p0 = p(sNow - 0.05);
    const eye = p(sNow);
    const tx = p1[0] - p0[0], ty = p1[1] - p0[1], tz = p1[2] - p0[2];
    // tangent, looks-at point = eye + tangent
    const tl = 1 / Math.hypot(tx, ty, tz);
    const ttx = tx * tl, tty = ty * tl, ttz = tz * tl;
    const cx = eye[0] + ttx, cy = eye[1] + tty, cz = eye[2] + ttz;

    // Up vector with banking baked in: rotate world-up around the
    // tangent by `bank * pc.bank`. Rodrigues' formula on (0,1,0):
    // u' = u cosθ + (k × u) sinθ + k (k·u)(1-cosθ)
    const angle = bank * pc.bank;
    const c = Math.cos(angle), s = Math.sin(angle);
    const kx = ttx, ky = tty, kz = ttz;
    const ux0 = 0, uy0 = 1, uz0 = 0;
    const kdotu = ky;
    // k × u
    const cxv = ky * uz0 - kz * uy0;
    const cyv = kz * ux0 - kx * uz0;
    const czv = kx * uy0 - ky * ux0;
    const ux = ux0 * c + cxv * s + kx * kdotu * (1 - c);
    const uy = uy0 * c + cyv * s + ky * kdotu * (1 - c);
    const uz = uz0 * c + czv * s + kz * kdotu * (1 - c);

    lookAt(out, eye[0], eye[1], eye[2], cx, cy, cz, ux, uy, uz);
    return out;
  }

  function frame(nowMs) {
    raf = 0;
    if (!wantsRunning) return;
    if (lastFrame === 0) lastFrame = nowMs;
    const dt = Math.min(0.05, (nowMs - lastFrame) / 1000) * opts.speed;
    lastFrame = nowMs;

    // Reduced motion 'slow' just scales dt down.
    const effectiveDt = mode === 'slow' ? dt * 0.1 : dt;
    t += effectiveDt;

    const ph = phase(t);

    cameraSPrev = cameraS;
    cameraS    += ph.speed * effectiveDt;

    render(ph);
    raf = requestAnimationFrame(frame);
  }

  function render(ph) {
    resize();
    const w = canvas.width, h = canvas.height;
    gl.viewport(0, 0, w, h);

    // OLED black.
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Additive blending. Depth disabled — depth ordering is implied by
    // additive accumulation and per-particle depth-aware brightness.
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    perspective(proj, 70 * Math.PI / 180, w / h, 0.1, 200);
    buildView(view,     cameraS,     ph.bank);
    buildView(viewPrev, cameraSPrev, bankPrev);

    gl.useProgram(program);
    gl.uniformMatrix4fv(loc.uProj, false, proj);
    gl.uniformMatrix4fv(loc.uView, false, view);
    gl.uniformMatrix4fv(loc.uViewPrev, false, viewPrev);
    gl.uniform1f(loc.uCameraS,     cameraS);
    gl.uniform1f(loc.uCameraSPrev, cameraSPrev);
    gl.uniform1f(loc.uTunnelRadius, opts.tunnelRadius);
    gl.uniform1f(loc.uTime,        t);
    gl.uniform1f(loc.uBank,        ph.bank);
    gl.uniform1f(loc.uBankPrev,    bankPrev);
    gl.uniform1f(loc.uStreakLength, ph.streak * opts.streakLength);
    gl.uniform1f(loc.uAlive,       ph.alive * ph.density);
    gl.uniform2f(loc.uViewport,    w, h);
    gl.uniform1f(loc.uBloomStrength, opts.bloomStrength);

    const pc = opts.pathCurvature;
    gl.uniform4f(loc.uPathFreqs, pc.freqX, pc.freqY, pc.freqX2, pc.freqY2);
    gl.uniform4f(loc.uPathAmps,  pc.ampX,  pc.ampY,  pc.ampX2,  pc.ampY2);

    gl.bindVertexArray(vao);

    // Halo pass — wide, soft, low-alpha. Provides the bloom.
    gl.uniform1f(loc.uIsCorePass, 0.0);
    gl.uniform1f(loc.uSizeScale,  0.16); // NDC
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, N);

    // Core pass — narrow, bright, crisp.
    gl.uniform1f(loc.uIsCorePass, 1.0);
    gl.uniform1f(loc.uSizeScale,  0.038);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, N);

    gl.bindVertexArray(null);

    bankPrev = ph.bank;
  }

  /** Draw a single representative "peak velocity" still. Used for
   *  reduced motion and for the gallery cards' initial mounted state. */
  function renderStaticFrame() {
    // Seed the camera & bank with a representative peak-time state
    // so the still reads as the hero moment.
    const stillT = T_LAUNCH + ramp.accel + ramp.peak * 0.5;
    const ph = phase(stillT);
    t = stillT;
    cameraS = ph.speed * stillT * 0.4;
    cameraSPrev = cameraS - ph.speed * (1 / 60);
    bankPrev = ph.bank;
    render(ph);
  }

  /* ----------------- Public API ----------------- */
  function start() {
    if (wantsRunning) return;
    if (document.hidden) return;

    mode = resolveMotionMode();
    if (mode === 'static') {
      // Honour prefers-reduced-motion: a single still frame, no rAF.
      renderStaticFrame();
      return;
    }

    wantsRunning = true;
    lastFrame = 0;
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function stop() {
    wantsRunning = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function _suspend() {
    // Like stop(), but reused internally on visibility/MQ changes.
    stop();
  }

  function onVis() {
    if (document.hidden) {
      _suspend();
    } else if (opts.autoStart || wantsRunning) {
      // Resume only if we were previously asked to run.
      start();
    }
  }
  document.addEventListener('visibilitychange', onVis);

  if (mql && mql.addEventListener) {
    mql.addEventListener('change', () => {
      const was = wantsRunning;
      _suspend();
      if (was) start();
      else if (resolveMotionMode() === 'static') renderStaticFrame();
    });
  }

  // Always draw an evolved still on mount so the canvas isn't a flash
  // of pure black before the first user interaction. This matches the
  // existing Petrova animation's behaviour on gallery cards.
  renderStaticFrame();

  if (opts.autoStart) start();

  return {
    canvas,
    start,
    stop,
    /** Restart the timeline from t=0. */
    reset() {
      t = 0;
      cameraS = 0;
      cameraSPrev = 0;
      bankPrev = 0;
      renderStaticFrame();
    },
    /** Update an option at runtime. Some options require a full re-init. */
    setOption(key, value) {
      if (key === 'particleCount') {
        const wasRunning = wantsRunning;
        _suspend();
        N = Math.max(64, value | 0);
        opts.particleCount = N;
        gl.bindVertexArray(vao);
        initParticles();
        gl.bindVertexArray(null);
        if (wasRunning) start();
      } else if (key === 'palette') {
        opts.palette = { ...opts.palette, ...(value || {}) };
        gl.bindVertexArray(vao);
        initParticles();
        gl.bindVertexArray(null);
      } else if (key in opts) {
        opts[key] = value;
      }
    },
    destroy() {
      stop();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('resize', resize);
      if (ro) ro.disconnect();
      try {
        gl.deleteBuffer(quadVBO);
        gl.deleteBuffer(quadIBO);
        gl.deleteBuffer(tubeABuf);
        gl.deleteBuffer(tubeBBuf);
        gl.deleteBuffer(colorBuf);
        gl.deleteVertexArray(vao);
        gl.deleteProgram(program);
      } catch (_) { /* context already lost */ }
      try { container.removeChild(canvas); } catch (_) {}
    },
  };
}

/* ---------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------- */
function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    // Surface the error in the console but never throw — we want a
    // graceful black fallback rather than a broken host page.
    // eslint-disable-next-line no-console
    console.warn('[PatrovaWormhole] shader compile failed:',
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
    console.warn('[PatrovaWormhole] program link failed:', gl.getProgramInfoLog(p));
    gl.deleteProgram(p);
    return null;
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return p;
}

/** Used when WebGL2 is unavailable; the canvas stays black. */
function makeNoopHandle(canvas, container) {
  return {
    canvas,
    start() {},
    stop() {},
    reset() {},
    setOption() {},
    destroy() {
      try { container.removeChild(canvas); } catch (_) {}
    },
  };
}

export default createPatrovaWormhole;
