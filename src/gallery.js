/* =====================================================================
 * Gallery — awwwards-style hero banner cards.
 * ---------------------------------------------------------------------
 * Reads the registry from `animations.js`, builds one full-bleed banner
 * per entry, and mounts each animation in 3-second preview-loop mode.
 *
 * Trigger behavior:
 *   - Mobile / touch (no fine pointer): play while the banner is on
 *     screen, via IntersectionObserver. This matches expectations of
 *     scroll-driven sites — animation comes alive as you reach it.
 *   - Desktop / 4K (fine pointer + hover capability): banners stay
 *     still by default and animate only on hover (mouseenter). They
 *     stop on mouseleave. This keeps the page calm and lets the user
 *     "scrub" their attention from one piece to the next.
 *
 * Each card always renders one static evolved frame on mount so the
 * banner isn't a black rectangle before the first interaction.
 * =====================================================================
 */

import { animations } from './animations.js';

// ---------------------------------------------------------------------
// Trigger mode detection
// ---------------------------------------------------------------------
// The (hover: hover) and (pointer: fine) media queries together identify
// devices where hover is meaningful — i.e. desktop and 4K TV with a
// trackpad/mouse. Anything else (phones, tablets, touch laptops) gets
// the scroll-into-view trigger.
function preferHoverTrigger() {
  if (!window.matchMedia) return true;
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

// ---------------------------------------------------------------------
// Card construction
// ---------------------------------------------------------------------
function buildCard(entry, index) {
  const article = document.createElement('article');
  article.className = 'banner';
  article.setAttribute('data-anim-id', entry.id);
  article.style.setProperty('--banner-index', String(index));

  // Stage hosts the canvas; kept separate from text so we can size it
  // with aspect-ratio without affecting label flow.
  const stage = document.createElement('div');
  stage.className = 'banner__stage';
  stage.setAttribute('aria-hidden', 'true');

  // Eye-catching label/meta block.
  const meta = document.createElement('div');
  meta.className = 'banner__meta';
  meta.innerHTML = `
    <div class="banner__index">${String(index + 1).padStart(2, '0')}</div>
    <h2 class="banner__title">${entry.title}</h2>
    <p class="banner__tagline">${entry.tagline}</p>
    <ul class="banner__tags">
      ${entry.tags.map(t => `<li>${t}</li>`).join('')}
    </ul>
    <a class="banner__cta" href="${entry.fullRoute}">
      <span>View full piece</span>
      <span aria-hidden="true">→</span>
    </a>
  `;

  article.appendChild(stage);
  article.appendChild(meta);
  return { article, stage };
}

// ---------------------------------------------------------------------
// Per-card lifecycle: mount the animation in preview-loop mode and
// wire the appropriate trigger.
// ---------------------------------------------------------------------
function activateCard(entry, stage, article, hoverMode) {
  // Mount the animation paused (autoStart=false via the registry) with
  // a 3-second modular loop.
  const handle = entry.mount(stage, {
    previewLoop: { durationSeconds: 3 },
  });

  // Internal state: are we *allowed* to play right now? On hover-mode
  // that's mouseenter→true, mouseleave→false. On scroll mode it's
  // intersection-entry→true, intersection-exit→false. Either way the
  // animation can independently stop itself (reduced-motion / tab
  // hidden) without confusing this layer.
  let playing = false;
  function play() {
    if (playing) return;
    playing = true;
    article.classList.add('is-playing');
    handle.start();
  }
  function pause() {
    if (!playing) return;
    playing = false;
    article.classList.remove('is-playing');
    handle.stop();
  }

  if (hoverMode) {
    // Desktop / 4K: hover to play.
    article.addEventListener('mouseenter', play);
    article.addEventListener('mouseleave', pause);
    // Keyboard accessibility: focusing the CTA also plays so users
    // tabbing through the page can preview without a mouse.
    article.addEventListener('focusin', play);
    article.addEventListener('focusout', (e) => {
      // Only pause if focus is leaving the entire card, not just moving
      // between children.
      if (!article.contains(e.relatedTarget)) pause();
    });
  } else {
    // Mobile / touch: play while the banner is on screen.
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting && e.intersectionRatio > 0.35) play();
        else pause();
      }
    }, {
      // A generous threshold list so the start/stop transition is smooth
      // as the user scrolls.
      threshold: [0, 0.35, 0.6, 1.0],
    });
    io.observe(article);
  }

  return { handle, play, pause };
}

// ---------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------
export function buildGallery(root) {
  if (!root) throw new Error('buildGallery: root element required');

  const hoverMode = preferHoverTrigger();
  document.documentElement.dataset.triggerMode = hoverMode ? 'hover' : 'scroll';

  for (let i = 0; i < animations.length; i++) {
    const entry = animations[i];
    const { article, stage } = buildCard(entry, i);
    root.appendChild(article);
    // Defer activation slightly so the layout is settled before the
    // animation measures its container. requestAnimationFrame is enough.
    requestAnimationFrame(() => activateCard(entry, stage, article, hoverMode));
  }

  // Re-evaluate trigger mode if the user docks an external mouse / unplugs
  // it — uncommon but inexpensive to support.
  if (window.matchMedia) {
    const mql = window.matchMedia('(hover: hover) and (pointer: fine)');
    if (mql.addEventListener) {
      mql.addEventListener('change', () => {
        // Simplest correct response: full reload. Re-wiring every card's
        // event handlers in-place is fiddly and this transition is rare.
        location.reload();
      });
    }
  }
}

export default buildGallery;
