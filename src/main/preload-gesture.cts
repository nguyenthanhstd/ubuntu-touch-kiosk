/**
 * Renderer-side edge-swipe recognizer, injected into nav, dock, and remote service views.
 *
 * Preloads run with `sandbox: true` and `scripts/fix-preload.mjs` inlines this file directly,
 * so it MUST stay 100% self-contained (zero relative imports).
 *
 * Touch-action note (`TOUCH-02`): on `touch-action: auto` pages, Chromium aborts native panning
 * only when a non-passive `touchmove` calls `preventDefault()` before ~15-32 px touch slop.
 * We coordinate `pointer*` with `{ passive: false } touchmove`, tracking `Touch.identifier`
 * separately from `PointerEvent.pointerId` and preserving vertical scrolling via `ortho >= travel`.
 */

type GestureKind = 'back' | 'home';
interface GesturePoint { x: number; y: number; t: number; }

const EDGE_CSS = 40;
const MIN_TRAVEL_CSS = 120;
const MIN_TRAVEL_FLOOR_CSS = 64;
const SLOP_CSS = 12;
const MAX_DURATION_MS = 2000;
const ORTHO_MAX_CSS = 30;
const DOCK_BAND_CSS = 96;
const STALE_MS = 3000;

const findTouch = (list: TouchList, id: number): Touch | undefined => {
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (item && item.identifier === id) return item;
  }
  return undefined;
};

export function installGestures(send: (channel: string, payload: unknown) => void): void {
  if (!window.addEventListener) return;
  const w = window as unknown as { __ntfGestures?: boolean };
  if (w.__ntfGestures) return;
  w.__ntfGestures = true;

  const supportsPointer = typeof PointerEvent !== 'undefined';
  let active: GestureKind | null = null;
  let pending: GestureKind | null = null;
  let claimed = false;
  let start: GesturePoint | null = null;
  let last: GesturePoint | null = null;
  let lastWallMs = 0;
  let ownerId: number | null = null;
  let ownerTouchId: number | null = null;

  const channelFor = (kind: GestureKind, phase: 'begin' | 'progress' | 'fire' | 'cancel'): string =>
    `gesture:${kind}:${phase}`;

  const effectiveTravel = (): number =>
    Math.max(MIN_TRAVEL_FLOOR_CSS, Math.min(MIN_TRAVEL_CSS, window.innerHeight - EDGE_CSS - 8));

  const reset = (): void => {
    active = null;
    pending = null;
    claimed = false;
    start = null;
    last = null;
    lastWallMs = 0;
    ownerId = null;
    ownerTouchId = null;
  };

  const release = (fire: boolean): void => {
    const kind = active;
    const s = start;
    const l = last;
    if (!kind) {
      reset();
      return;
    }
    const wasClaimed = claimed;
    reset();
    if (!s || !l) {
      send(channelFor(kind, 'cancel'), {});
      return;
    }
    if (fire && wasClaimed && l.t - s.t <= MAX_DURATION_MS) {
      const dx = l.x - s.x;
      const dy = l.y - s.y;
      const travel = kind === 'back' ? dx : -dy;
      if (travel >= effectiveTravel()) {
        send(channelFor(kind, 'fire'), { dx: Math.round(dx), dy: Math.round(dy), ms: Math.round(l.t - s.t) });
        return;
      }
    }
    send(channelFor(kind, 'cancel'), {});
  };

  const classify = (x: number, y: number, height: number): GestureKind | null => {
    const fromLeft = x <= EDGE_CSS;
    const fromBottom = y >= height - EDGE_CSS;
    if (fromLeft && !fromBottom) return height > DOCK_BAND_CSS * 2 && y <= DOCK_BAND_CSS ? null : 'back';
    return fromBottom ? 'home' : null;
  };

  const shouldPreventTouchMove = (x: number, y: number): boolean => {
    if (active === 'back' || active === 'home') return true;
    if (pending === null || !start) return false;
    const dx = x - start.x;
    const dy = y - start.y;
    if (Math.abs(dx) < SLOP_CSS && Math.abs(dy) < SLOP_CSS) return false;
    const travel = pending === 'back' ? dx : -dy;
    const ortho = pending === 'back' ? Math.abs(dy) : Math.abs(dx);
    if (travel <= 0 || ortho >= travel || ortho > ORTHO_MAX_CSS) {
      reset();
      return false;
    }
    return true;
  };

  const onDown = (x: number, y: number, t: number, id: number | null): void => {
    send('gesture:tap', { x: Math.round(x), y: Math.round(y) });
    if (ownerId !== null) return;
    const kind = classify(x, y, window.innerHeight);
    if (!kind) {
      ownerTouchId = null;
      return;
    }
    pending = kind;
    active = null;
    claimed = false;
    ownerId = id;
    start = { x, y, t };
    last = { x, y, t };
    lastWallMs = Date.now();
  };

  const onMove = (x: number, y: number, t: number): void => {
    if (!start || !last) return;
    last = { x, y, t };
    lastWallMs = Date.now();
    const dx = x - start.x;
    const dy = y - start.y;
    const travel = (pending ?? active) === 'back' ? dx : -dy;
    const ortho = (pending ?? active) === 'back' ? Math.abs(dy) : Math.abs(dx);
    if (pending !== null) {
      if (Math.abs(dx) < SLOP_CSS && Math.abs(dy) < SLOP_CSS) return;
      if (travel <= 0 || ortho >= travel || ortho > ORTHO_MAX_CSS) {
        reset();
        return;
      }
      active = pending;
      pending = null;
      send(channelFor(active, 'begin'), { x: Math.round(start.x), y: Math.round(start.y) });
    }
    if (!active || claimed) return;
    const threshold = effectiveTravel();
    const duration = t - start.t;
    if (travel >= threshold && ortho <= ORTHO_MAX_CSS && duration <= MAX_DURATION_MS) {
      claimed = true;
      send(channelFor(active, 'progress'), { progress: Math.min(1, (travel - threshold) / (1.5 * threshold)) });
    } else if (duration > MAX_DURATION_MS) {
      release(false);
    }
  };

  const onUp = (x: number, y: number, t: number): void => {
    if (!start) return;
    last = { x, y, t };
    lastWallMs = Date.now();
    if (pending !== null) {
      reset();
      return;
    }
    release(true);
  };

  const opts = { capture: true, passive: true } as const;
  if (supportsPointer) {
    const onAbort = (e: PointerEvent): void => {
      if (ownerId !== null && e.pointerId === ownerId) release(false);
    };
    window.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button === 0) onDown(e.clientX, e.clientY, e.timeStamp, e.pointerId);
    }, opts);
    window.addEventListener('pointermove', (e: PointerEvent) => {
      if (ownerId !== null && e.pointerId === ownerId) onMove(e.clientX, e.clientY, e.timeStamp);
    }, opts);
    window.addEventListener('pointerup', (e: PointerEvent) => {
      if (ownerId !== null && e.pointerId === ownerId) onUp(e.clientX, e.clientY, e.timeStamp);
    }, opts);
    window.addEventListener('pointercancel', onAbort, opts);
    window.addEventListener('lostpointercapture', onAbort, opts);
    window.addEventListener('pointerleave', (e: PointerEvent) => {
      if (ownerId !== null && e.pointerId === ownerId && e.target === window) release(false);
    }, opts);
  }

  window.addEventListener('touchstart', (e: TouchEvent) => {
    if (e.touches.length > 1) {
      release(false);
      return;
    }
    const t = e.touches[0];
    if (!t) return;
    if (!supportsPointer) onDown(t.clientX, t.clientY, e.timeStamp, t.identifier);
    else if (ownerTouchId === null) ownerTouchId = t.identifier;
  }, opts);
  window.addEventListener('touchmove', (e: TouchEvent) => {
    if (ownerId === null) return;
    if (e.touches.length > 1) {
      release(false);
      return;
    }
    const t =
      (ownerTouchId !== null ? findTouch(e.touches, ownerTouchId) : undefined) ??
      (e.touches.length === 1 ? e.touches[0] : undefined);
    if (!t) return;
    if (shouldPreventTouchMove(t.clientX, t.clientY) && e.cancelable) e.preventDefault();
    if (!supportsPointer) onMove(t.clientX, t.clientY, e.timeStamp);
  }, { capture: true, passive: false });
  window.addEventListener('touchend', (e: TouchEvent) => {
    if (ownerId === null) {
      if (e.touches.length === 0) ownerTouchId = null;
      return;
    }
    if (supportsPointer) return;
    const t =
      (ownerTouchId !== null ? findTouch(e.changedTouches, ownerTouchId) : undefined) ??
      findTouch(e.changedTouches, ownerId);
    if (t) onUp(t.clientX, t.clientY, e.timeStamp);
  }, opts);
  window.addEventListener('touchcancel', () => {
    if (ownerId !== null) release(false);
    else ownerTouchId = null;
  }, opts);

  setInterval(() => {
    if (ownerId !== null && lastWallMs > 0 && Date.now() - lastWallMs > STALE_MS) release(false);
  }, 1000);
}
