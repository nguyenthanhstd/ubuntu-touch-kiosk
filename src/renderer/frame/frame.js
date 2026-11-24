/*
 * Window-frame renderer: the rounded ring around the content band, the four corner masks that hide an
 * external app's square corners, and the one ✕ that closes whichever app is in front of the kiosk.
 *
 * This file is copied as an asset (scripts/copy-assets.mjs), not compiled by tsc, so it is written
 * as plain DOM that runs exactly as-is. Its single import is the vendored Lucide set — the same one
 * the top bar and the dock draw from — so the ✕ here is the same glyph as the ✕ on the bar.
 *
 * The window decides the part: the main process loads this page once per piece of the frame with
 * ?part=top|bottom|left|right|corner-tl|corner-tr|corner-bl|corner-br|close. Drawing is therefore
 * fixed per window and nothing here ever resizes, which is what lets nine always-on-top windows cost
 * nothing per frame.
 *
 * The four `corner-*` parts are the only ones that need data from the main process: they paint the
 * wallpaper, so they must know the panel size and their own offset inside it. That arrives on
 * `ntf:settings` and is written to custom properties; see applySettings() below.
 */
import { icon } from '../shell/icons.js';

/** Whitelist, not a fallthrough: an unknown part means the main process and this file disagree. */
const PARTS = [
  'top',
  'bottom',
  'left',
  'right',
  'corner-tl',
  'corner-tr',
  'corner-bl',
  'corner-br',
  'close',
];

/** The four parts that paint wallpaper. `corner-*` is a prefix shared with nothing else here. */
function isCorner(value) {
  return value.startsWith('corner-');
}

function readPart() {
  const raw = new URLSearchParams(location.search).get('part');
  if (raw === null) {
    console.warn('[frame] missing ?part= — drawing nothing');
    return null;
  }
  if (!PARTS.includes(raw)) {
    console.warn(`[frame] unknown ?part=${raw} — expected ${PARTS.join('|')}`);
    return null;
  }
  return raw;
}

const part = readPart();
const body = document.body;

if (part === null) {
  // `frame--none` keeps every rule's selector from matching, so a mis-configured window paints
  // nothing at all instead of guessing at an edge.
  body.classList.add('frame--none');
} else {
  body.classList.add(`frame--${part}`);
  body.dataset.part = part;
}

/*
 * The ✕ bridge.
 *
 * The close window is the only piece of the frame that takes input, but the mask windows need data,
 * so this page has a second, read-only use for the same bridge. Which preload a frame window gets is
 * the main process's decision and the same page is loaded for all nine parts; so rather than assume
 * one name, the first bridge that actually exposes the member wins. `ntfTop` is what
 * preload-chrome.cts exposes today.
 */
const BRIDGE_NAMES = ['ntfTop', 'ntfFrame', 'ntfChrome'];

function findBridge(member) {
  for (const name of BRIDGE_NAMES) {
    const bridge = window[name];
    if (bridge && typeof bridge[member] === 'function') return bridge;
  }
  return null;
}

const closeBtn = document.getElementById('btn-frame-close');

if (part === 'close' && closeBtn) {
  closeBtn.innerHTML = icon('x');
  void openClose(closeBtn);
}

function openClose(button) {
  let busy = false;

  button.addEventListener('click', () => {
    // Guard against a double tap. Closing an app costs about a second of SIGTERM grace, and a
    // second invoke would race the first scan and could re-signal a recycled pid.
    if (busy) return;
    // NTF-R09: prefer `closeFrontApp` — one tap closes exactly the app covering the kiosk and leaves
    // any other external app running. `closeApps` is the old kill-everything call and is only kept as
    // a fallback for a preload that predates the split.
    const bridge = findBridge('closeFrontApp') ?? findBridge('closeApps');
    if (bridge === null) {
      console.warn(`[frame] no closeFrontApp on any bridge (${BRIDGE_NAMES.join(', ')}) — the ✕ cannot act`);
      return;
    }
    const action = typeof bridge.closeFrontApp === 'function' ? 'closeFrontApp' : 'closeApps';
    busy = true;
    button.disabled = true;
    Promise.resolve(bridge[action]())
      .catch(() => null)
      .then((result) => {
        busy = false;
        button.disabled = false;
        // A stuck window is exactly when the visitor wants the ✕ again, so it stays live on failure.
        // `closeFrontApp` resolves to the closed app's label, or null when nothing was in front;
        // `closeApps` resolves to a boolean, where false means the same thing.
        if (result === null || result === false) console.warn(`[frame] ${action} closed nothing`);
      });
  });
}

/*
 * The corner masks: paint the wallpaper the nav page is already showing, cropped to this window.
 *
 * The nav page's wallpaper is `position: fixed; inset: 0`, and view-manager.ts gives navView the
 * whole window, so the image's box is the whole PANEL (2560x1600) with its origin at (0,0) — not the
 * content band (2540x1410 at 10,54). Reproducing the crop therefore means drawing that same
 * panel-sized box and sliding it out from under this 26x26 window; `.mask-wall` in frame.css does
 * the sliding with `transform`, and this function supplies the four numbers it cannot know:
 *   --panel-w / --panel-h  the panel size
 *   --mask-x  / --mask-y   this window's own origin, in panel coordinates
 * `background-size: cover` then resolves against the same box the nav page used, which is what makes
 * the two byte-identical instead of merely close.
 *
 * The window title bars are not part of this: a corner window is 26x26 and nothing inside it has a
 * title bar, because the mask covers the app's title row and hiding that row is the point.
 */
function applyGeometry(payload) {
  if (!payload || !payload.geometry) return;
  const { width, height, corners } = payload.geometry;
  const here = corners[part.slice('corner-'.length)];
  if (!here) return;
  const root = document.documentElement.style;
  root.setProperty('--panel-w', `${width}px`);
  root.setProperty('--panel-h', `${height}px`);
  root.setProperty('--mask-x', `${here.x}px`);
  root.setProperty('--mask-y', `${here.y}px`);
}

/** The nine wallpaper states, mirroring nav/nav.js's paintWallpaper() one for one. */
const WALLPAPERS = ['studio', 'graphite', 'noir', 'ember', 'sage', 'ocean', 'sunset', 'plum', 'custom'];

function paintWallpaper(wallpaper, image) {
  for (const id of WALLPAPERS) body.classList.remove(`wallpaper--${id}`);
  body.classList.add(`wallpaper--${wallpaper || 'studio'}`);
  body.classList.remove('wallpaper--image');
  if (wallpaper === 'custom' && image) {
    body.style.setProperty('--wallpaper-image', `url("file://${image.replace(/\\/g, '/')}")`);
    body.classList.add('wallpaper--image');
  } else {
    body.style.removeProperty('--wallpaper-image');
  }
}

if (part !== null && isCorner(part)) {
  const bridge = findBridge('getSettings');
  if (bridge === null) {
    // Without geometry the mask would paint an unclipped 26x26 square of wallpaper, i.e. a notch out
    // of the app's corner instead of a rounded one. `frame--none` wins out over `frame--corner-*`
    // because it is added to the same element and its rule matches every part.
    console.warn(`[frame] no getSettings on any bridge (${BRIDGE_NAMES.join(', ')}) — masking nothing`);
    body.classList.remove(`frame--${part}`);
    body.classList.add('frame--none');
  } else {
    const apply = (payload) => {
      paintWallpaper(payload.settings.wallpaper, payload.settings.wallpaperImage);
      applyGeometry(payload);
    };
    void bridge
      .getSettings()
      .then(apply)
      .catch(() => console.warn('[frame] getSettings failed — the corner mask has no wallpaper'));
    // wallpaper and uiZoom both move the mask's pixels, and the panel size changes with the output
    // mode, so the numbers are re-applied on every push rather than captured once at boot.
    if (typeof bridge.onSettings === 'function') bridge.onSettings(apply);
  }
}
