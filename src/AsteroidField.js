/* =====================================================================
 * AsteroidField
 * ---------------------------------------------------------------------
 * A 100% procedural, OLED-friendly first-person fly-through of a cartoon
 * neon asteroid field. Tumbling black icosahedral rocks with neon-purple
 * inverted-hull outlines streak past the camera against a far-off canvas
 * nebula built from layered additive radial gradients.
 *
 * Design notes (everything is procedural — no raster assets):
 *
 *  1. Renderer
 *     --------
 *     Three.js r128 loaded lazily from cdnjs on first mount; the module
 *     returns a placeholder handle immediately and upgrades it once the
 *     script resolves. The homepage gallery therefore only pays the
 *     ~600 KB Three.js cost when a user actually hovers/scrolls this
 *     animation into view.
 *
 *  2. Asteroid geometry
 *     ------------------
 *     IcosahedronGeometry(radius 1, detail 1) gives ~42 logical
 *     vertices. r128 returns a NON-indexed BufferGeometry, so we dedupe
 *     by quantized position and apply a single coherent radial
 *     displacement (0.75–1.25×) per logical vertex. Vertices on the
 *     unit sphere already point in their own normal direction, so the
 *     displacement is just `vertex.normalize().multiplyScalar(factor)`.
 *     Normals are recomputed after displacement.
 *
 *  3. Cartoon outline
 *     ----------------
 *     Classic inverted-hull technique. Each asteroid is a THREE.Group
 *     of two meshes sharing the displaced geometry:
 *       Mesh A — BackSide, 1.08× scale, neon-purple. Only back faces
 *                render, and the oversized hull pokes out around the
 *                silhouette of Mesh B as a uniform-thickness rim.
 *       Mesh B — FrontSide, 1.0× scale, pure black. Occludes the nebula
 *                and provides the silhouette the outline wraps.
 *     No fragment shader, no post-process, no EffectComposer.
 *
 *  4. Procedural nebula
 *     ------------------
 *     One 1024² offscreen canvas drawn at startup with three large
 *     additive radial gradients (neon blue / hot magenta / neon pink)
 *     plus a handful of thin elliptical deep-violet streaks for gas
 *     filaments. Uploaded as a single CanvasTexture mapped onto an
 *     800×600 PlaneGeometry. The plane lives at camera.z − 1200 and
 *     closes the gap by `nebulaApproach` units/frame, so it grows
 *     imperceptibly over a multi-minute fly-through without ever
 *     being overshot.
 *
 *  5. Field recycling
 *     ----------------
 *     A pool of N asteroids is scattered through the visible Z range
 *     at startup. The camera glides forward at a constant rate
 *     (`forwardSpeed`); once an asteroid's Z exceeds camera.z + 30 it
 *     is recycled to camera.z − 800 with fresh randomness (axis,
 *     angular velocity, drift, scale) so it doesn't read as a looping
 *     replay.
 *
 *  6. Reduced motion
 *     ---------------
 *     With `reducedMotion: 'auto'` (default) we render a single static
 *     frame and never start the RAF loop. 'slow' runs the loop at 10%
 *     speed. 'off' ignores the user preference.
 * =====================================================================
 */

// --------------------------------------------------------------------
// Lazy loader for the Three.js r128 global.
// --------------------------------------------------------------------
const THREE_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
let _threePromise = null;
function loadThree() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.THREE) return Promise.resolve(window.THREE);
  if (_threePromise) return _threePromise;
  _threePromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = THREE_CDN;
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.onload  = () => resolve(window.THREE);
    s.onerror = () => reject(new Error('AsteroidField: failed to load Three.js from ' + THREE_CDN));
    document.head.appendChild(s);
  });
  return _threePromise;
}

// --------------------------------------------------------------------
// Defaults. All knobs documented in README.md.
// --------------------------------------------------------------------
const DEFAULTS = {
  asteroidCount   : 80,
  forwardSpeed    : 0.3,    // camera advance per 60fps-equivalent frame
  nebulaApproach  : 0.03,   // nebula closes the gap by this much / frame
  outlineScale    : 1.08,   // inverted-hull oversize factor
  outlineColors   : [0xBB00FF, 0x9900FF, 0xDD00FF, 0x7700EE],
  nebulaDistance  : 1200,   // initial camera→nebula gap (world units)
  reducedMotion   : 'auto', // 'auto' | 'static' | 'slow' | 'off'
  maxDeltaMs      : 50,     // clamp dt to avoid tab-resume jumps
  autoStart       : true,
  previewLoop     : false,  // gallery cards may pass { durationSeconds: N }
};

/**
 * Create and mount an AsteroidField animation inside `container`.
 * @param {HTMLElement} container
 * @param {Partial<typeof DEFAULTS>} [userOptions]
 * @returns {{ canvas: HTMLCanvasElement|null, start(): void, stop(): void, reset(): void, destroy(): void }}
 */
export function createAsteroidField(container, userOptions = {}) {
  if (!container || !container.appendChild) {
    throw new Error('AsteroidField: container element is required');
  }
  const opts = { ...DEFAULTS, ...userOptions };

  // The harness returns immediately. Three.js may still be loading;
  // start/stop/reset/destroy intent is buffered and applied once the
  // real impl is ready.
  let wantsRunning = !!opts.autoStart;
  let realHandle = null;
  let destroyed = false;

  loadThree().then((THREE) => {
    if (destroyed) return;
    realHandle = _buildImpl(container, opts, THREE);
    if (wantsRunning) realHandle.start();
  }).catch((err) => {
    // Graceful fallback: leave the container empty / black. No throw.
    // eslint-disable-next-line no-console
    console.warn(err && err.message ? err.message : err);
  });

  return {
    get canvas() { return realHandle ? realHandle.canvas : null; },
    start() {
      wantsRunning = true;
      if (realHandle) realHandle.start();
    },
    stop() {
      wantsRunning = false;
      if (realHandle) realHandle.stop();
    },
    reset() {
      if (realHandle) realHandle.reset();
    },
    destroy() {
      destroyed = true;
      wantsRunning = false;
      if (realHandle) realHandle.destroy();
    },
  };
}

// --------------------------------------------------------------------
// Real implementation. Built lazily once Three.js is loaded.
// --------------------------------------------------------------------
function _buildImpl(container, opts, THREE) {
  // ----- Renderer -----
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 1);

  const canvas = renderer.domElement;
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.background = '#000';
  container.appendChild(canvas);

  function vw() { return container.clientWidth  || window.innerWidth;  }
  function vh() { return container.clientHeight || window.innerHeight; }
  renderer.setSize(vw(), vh());

  // ----- Scene & Camera -----
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  const camera = new THREE.PerspectiveCamera(75, Math.max(vw() / vh(), 0.01), 0.1, 2000);
  camera.position.set(0, 0, 0);

  // ----- Procedural nebula texture -----
  function buildNebulaTexture() {
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 1024;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, 1024, 1024);
    ctx.globalCompositeOperation = 'lighter';

    function blob(cx, cy, r, rgb) {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0.00, `rgba(${rgb}, 0.95)`);
      g.addColorStop(0.45, `rgba(${rgb}, 0.40)`);
      g.addColorStop(1.00, `rgba(${rgb}, 0.00)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }

    blob(400, 500, 350, '0, 170, 255');   // neon blue
    blob(600, 400, 280, '255, 0, 204');   // hot magenta
    blob(500, 600, 200, '255, 68, 170');  // neon pink

    const streakCount = 7;
    for (let i = 0; i < streakCount; i++) {
      const cx = 150 + Math.random() * 700;
      const cy = 150 + Math.random() * 700;
      const rx = 160 + Math.random() * 220;
      const ry = 18  + Math.random() * 28;
      const ang = Math.random() * Math.PI;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(ang);
      ctx.scale(rx / ry, 1);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, ry);
      g.addColorStop(0.0, 'rgba(102, 0, 255, 0.55)');
      g.addColorStop(1.0, 'rgba(102, 0, 255, 0.00)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, ry, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.globalCompositeOperation = 'source-over';
    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  const nebulaTex = buildNebulaTexture();
  const nebulaMat = new THREE.MeshBasicMaterial({
    map: nebulaTex,
    transparent: true,
    depthWrite: false,
  });
  const nebulaPlane = new THREE.Mesh(new THREE.PlaneGeometry(800, 600), nebulaMat);
  nebulaPlane.position.set(0, 0, -opts.nebulaDistance);
  nebulaPlane.renderOrder = -1; // draw first; asteroid silhouettes occlude on top
  scene.add(nebulaPlane);

  // ----- Asteroid geometry (with shared-vertex displacement) -----
  function makeAsteroidGeometry() {
    const geo = new THREE.IcosahedronGeometry(1, 1);
    const pos = geo.attributes.position;
    const dispMap = new Map();
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const key = v.x.toFixed(4) + ',' + v.y.toFixed(4) + ',' + v.z.toFixed(4);
      let factor = dispMap.get(key);
      if (factor === undefined) {
        factor = 0.75 + Math.random() * 0.5;
        dispMap.set(key, factor);
      }
      v.normalize().multiplyScalar(factor);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    return geo;
  }

  function makeAsteroid() {
    const geo = makeAsteroidGeometry();
    const outlineColor = opts.outlineColors[(Math.random() * opts.outlineColors.length) | 0];
    const outlineMat = new THREE.MeshBasicMaterial({ color: outlineColor, side: THREE.BackSide });
    const fillMat    = new THREE.MeshBasicMaterial({ color: 0x000000,     side: THREE.FrontSide });

    const outlineMesh = new THREE.Mesh(geo, outlineMat);
    outlineMesh.scale.setScalar(opts.outlineScale);
    const fillMesh = new THREE.Mesh(geo, fillMat);

    const group = new THREE.Group();
    group.add(outlineMesh);
    group.add(fillMesh);

    group.userData = {
      rotationAxis: new THREE.Vector3(
        Math.random() * 2 - 1,
        Math.random() * 2 - 1,
        Math.random() * 2 - 1
      ).normalize(),
      angularVelocity: 0.002 + Math.random() * 0.010,
      driftX: (Math.random() - 0.5) * 0.04,
      driftY: (Math.random() - 0.5) * 0.04,
      geometry: geo,        // tracked for proper disposal
      outlineMat,
      fillMat,
    };
    return group;
  }

  function placeAsteroid(a, initial) {
    a.position.x = -120 + Math.random() * 240;
    a.position.y = -80  + Math.random() * 160;
    if (initial) {
      a.position.z = camera.position.z - 60 - Math.random() * 740;
    } else {
      a.position.z = camera.position.z - 800;
    }
    a.scale.setScalar(1.5 + Math.random() * 10.5);
    a.rotation.set(
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2
    );
  }

  function rerandomize(a) {
    const ud = a.userData;
    ud.rotationAxis.set(
      Math.random() * 2 - 1,
      Math.random() * 2 - 1,
      Math.random() * 2 - 1
    ).normalize();
    ud.angularVelocity = 0.002 + Math.random() * 0.010;
    ud.driftX = (Math.random() - 0.5) * 0.04;
    ud.driftY = (Math.random() - 0.5) * 0.04;
  }

  const asteroids = [];
  function initAsteroids() {
    for (let i = 0; i < opts.asteroidCount; i++) {
      const a = makeAsteroid();
      placeAsteroid(a, true);
      scene.add(a);
      asteroids.push(a);
    }
  }
  initAsteroids();

  // ----- Reduced-motion detection -----
  const mql = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function effectiveMotionMode() {
    if (opts.reducedMotion === 'off')    return 'normal';
    if (opts.reducedMotion === 'static') return 'static';
    if (opts.reducedMotion === 'slow')   return 'slow';
    return (mql && mql.matches) ? 'static' : 'normal';
  }

  // ----- Animation loop -----
  let nebulaApproachAccum = 0;
  let elapsedSeconds      = 0; // for previewLoop reset cadence
  const _qDelta = new THREE.Quaternion();

  let running = false;
  let wantsRunning = false;
  let frameId = 0;
  let lastWall = 0;

  function stepAndRender(step) {
    // 1) Camera glide.
    camera.position.z -= opts.forwardSpeed * step;

    // 2) Nebula closes the gap imperceptibly.
    nebulaApproachAccum += opts.nebulaApproach * step;
    nebulaPlane.position.z = camera.position.z - opts.nebulaDistance + nebulaApproachAccum;

    // 3) Update each asteroid.
    const recycleThreshold = camera.position.z + 30;
    for (let i = 0; i < asteroids.length; i++) {
      const a = asteroids[i];
      const ud = a.userData;
      _qDelta.setFromAxisAngle(ud.rotationAxis, ud.angularVelocity * step);
      a.quaternion.multiplyQuaternions(_qDelta, a.quaternion);
      a.position.x += ud.driftX * step;
      a.position.y += ud.driftY * step;
      if (a.position.z > recycleThreshold) {
        rerandomize(a);
        placeAsteroid(a, false);
      }
    }

    renderer.render(scene, camera);
  }

  function frame(now) {
    if (!running) return;
    if (!lastWall) lastWall = now;
    let dtMs = now - lastWall;
    lastWall = now;
    if (dtMs > opts.maxDeltaMs) dtMs = opts.maxDeltaMs;

    let step = dtMs / (1000 / 60);
    if (effectiveMotionMode() === 'slow') step *= 0.1;

    elapsedSeconds += dtMs / 1000;

    // Preview-loop: tightly modular cadence for gallery thumbnails.
    // Reset camera and asteroid layout so the opening glide replays.
    if (opts.previewLoop) {
      const dur = (typeof opts.previewLoop === 'object'
        ? opts.previewLoop.durationSeconds
        : 3) || 3;
      if (elapsedSeconds >= dur) {
        reset();
      }
    }

    stepAndRender(step);
    frameId = requestAnimationFrame(frame);
  }

  function renderStaticFrame() {
    // Advance a fixed number of synthetic frames so the still shows a
    // populated field rather than the empty initial moment.
    const synth = 1.0;
    for (let i = 0; i < 60; i++) stepAndRender(synth);
    renderer.render(scene, camera);
  }

  function start() {
    wantsRunning = true;
    if (running) return;
    if (effectiveMotionMode() === 'static') {
      renderStaticFrame();
      return;
    }
    running = true;
    lastWall = 0;
    frameId = requestAnimationFrame(frame);
  }
  function stop() {
    wantsRunning = false;
    _suspend();
  }
  function _suspend() {
    running = false;
    if (frameId) cancelAnimationFrame(frameId);
    frameId = 0;
  }

  function reset() {
    camera.position.set(0, 0, 0);
    nebulaApproachAccum = 0;
    elapsedSeconds = 0;
    nebulaPlane.position.z = camera.position.z - opts.nebulaDistance;
    for (let i = 0; i < asteroids.length; i++) {
      rerandomize(asteroids[i]);
      placeAsteroid(asteroids[i], true);
    }
  }

  // ----- Visibility / resize wiring -----
  function onVis() {
    if (document.hidden) {
      _suspend();
    } else if (wantsRunning) {
      if (effectiveMotionMode() === 'static') { renderStaticFrame(); return; }
      running = true;
      lastWall = 0;
      frameId = requestAnimationFrame(frame);
    }
  }
  document.addEventListener('visibilitychange', onVis);

  function onResize() {
    const w = vw(), h = vh();
    renderer.setSize(w, h);
    camera.aspect = Math.max(w / h, 0.01);
    camera.updateProjectionMatrix();
  }
  const ro = ('ResizeObserver' in window) ? new ResizeObserver(onResize) : null;
  if (ro) ro.observe(container);
  window.addEventListener('resize', onResize);

  if (mql && mql.addEventListener) {
    mql.addEventListener('change', () => {
      const was = wantsRunning;
      _suspend();
      if (was) start();
    });
  }

  return {
    canvas,
    start,
    stop,
    reset,
    destroy() {
      stop();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('resize', onResize);
      if (ro) ro.disconnect();
      // Dispose every per-asteroid GPU resource.
      for (let i = 0; i < asteroids.length; i++) {
        const ud = asteroids[i].userData;
        ud.geometry.dispose();
        ud.outlineMat.dispose();
        ud.fillMat.dispose();
        scene.remove(asteroids[i]);
      }
      asteroids.length = 0;
      nebulaPlane.geometry.dispose();
      nebulaMat.dispose();
      nebulaTex.dispose();
      scene.remove(nebulaPlane);
      renderer.dispose();
      try { container.removeChild(canvas); } catch (_) {}
    },
  };
}

export default createAsteroidField;
