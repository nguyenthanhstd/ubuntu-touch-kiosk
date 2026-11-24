import type { ServiceId } from './services.js';

/** Edge-swipe navigation kinds shared by the main process and the shell chrome. */
export type GestureKind = 'back' | 'home';

/**
 * The kiosk chrome is split into two always-visible local strips:
 *   top bar — clock, connection, status. Video keeps playing above it.
 *   dock    — service launcher, bottom edge, macOS style.
 * Plus one shortcut for the on-screen keyboard, which is a Wayland client layered by Cage and so
 * is not laid out by us (see toggleOnScreenKeyboard in main.ts).
 */
export const TOP_BAR_CSS = 44;
export const DOCK_CSS = 96;
export const KEYBOARD_SHORTCUT_H = 44;

/**
 * The kiosk page fills the panel edge-to-edge; only the top bar is drawn as a rounded pill.
 * `FRAME_INSET` is the margin from the panel edge to the bar, `FRAME_RADIUS` its corner radius —
 * pinned to half the bar height so all four corners form a true pill that CSS cannot clamp, and
 * mirrored by `.bar-surface` in shell.css and by the Windows controls (`─` / `✕`) on the right.
 */
export const FRAME_INSET = 10;
export const FRAME_RADIUS = 22;

/**
 * The content band is where every external window is pinned (layoutFor().content). It is drawn as a
 * rounded frame so a window reads as a card inside the kiosk instead of a raw rectangle glued to the
 * bezel:
 *   `BAND_RADIUS_CSS` — corner radius of that card.
 *   `FRAME_RING_CSS`  — stroke width of its outline.
 *   `FRAME_TOP_CSS`   — height of the strip the band frame *does not* paint, because an external app
 *                       keeps its own client-side title bar there and the two would stack.
 * The frame itself is a transparent, click-through always-on-top window (src/main/frame-window.ts),
 * so it also survives above a fullscreen video inside the app.
 */
export const BAND_RADIUS_CSS = 24;
export const FRAME_RING_CSS = 2;
/**
 * Edge of the square corner patch that hides the part of an external window which falls outside the
 * card's rounded corner. A ring stroke of width `FRAME_RING_CSS` sits *inside* radius `BAND_RADIUS_CSS`,
 * so the whole visible arc plus its stroke fits in `BAND_RADIUS_CSS + FRAME_RING_CSS` px — measured from
 * the band corner, that square is the only place where "inside the card" and "inside the client
 * rectangle" disagree. Anything smaller leaves a wedge of app pixels poking out; anything larger
 * blanks app pixels that should be visible.
 */
export const FRAME_MASK_CSS = BAND_RADIUS_CSS + FRAME_RING_CSS;
/**
 * Height of the strip at the top of the band that the frame must leave alone: an external app keeps
 * its own client-side title bar there (measured on the panel — Firefox paints rows 54–97, so 44 px)
 * and painting our ring over it would stack two title bars on top of each other.
 */
export const FRAME_TOP_CSS = 44;

/**
 * The close button for external apps. It sits exactly where Firefox's own ✕ sits (measured on the
 * panel: glyph centre 2527.5, 75.5, hit area 2504–2549 × 54–97), and it is drawn over every app so
 * one glyph closes FreeTube, Firefox and Chromium alike. Because the band frame is click-through,
 * this control has to be its own always-on-top window.
 */
export const APP_CLOSE_W = 46;
export const APP_CLOSE_H = 44;

/**
 * On-screen keyboard band height. 260 px keeps a 46 px key, which still clears the 44 px minimum
 * touch target at one metre, while giving back ~280 px of page compared with the old 34%-of-screen
 * band. The grip in the keyboard lets an operator drag it anywhere between the two limits.
 */
export const KEYBOARD_DEFAULT_H = 260;
export const KEYBOARD_MIN_H = 200;
export const KEYBOARD_MAX_H = 470;

/** Finger travel before a touch becomes a gesture instead of a tap, in CSS px. */
export const GESTURE_EDGE_CSS = 40;
export const GESTURE_MIN_TRAVEL_CSS = 120;

/** Progress report for the edge-swipe affordance; `kind` is null once the finger lifts. */
export interface GestureEvent {
  kind: 'back' | 'home' | null;
  progress: number;
}

export type DockAction =
  | { type: 'home' }
  | { type: 'service'; id: ServiceId }
  | { type: 'web'; id: string }
  | { type: 'keyboard' }
  | { type: 'browser' }
  | { type: 'app'; id: string }
  | { type: 'session' }
  /**
   * Enter the screensaver / idle-lock screen immediately.
   *
   * Its own action rather than a settings write: the lock button must work even when the idle timeout
   * is off, and it must not be able to open an app, navigate, or ask a confirmation — a visitor who
   * wants the panel dark should get it in one tap.
   */
  | { type: 'lock' }
  /**
   * Close the external app currently in front — NTF-R09. One tap, no confirmation, no session wipe.
   *
   * Separate from `session` on purpose: `session` tears the whole session down behind a native dialog
   * and clears browsing data, while this only kills the foreground external app's own pids. The
   * visitor-facing ✕ must never reach the destructive path by accident.
   */
  | { type: 'close-app' };

/**
 * Power, network and clock are read-only status, not content. They carry no visitor data and are
 * refreshed from the main process once per second.
 */
export interface SystemStatus {
  /** Pre-formatted local time, e.g. "20:41". Formatting in the main process keeps one clock. */
  time: string;
  /** Two-digit seconds, e.g. "07". Painted in red next to `time`, so it must stay a string. */
  seconds: string;
  date: string;
  /** Interface name when connected, empty string when offline. */
  network: string;
  /** mmWave / link quality in percent, -1 when unknown (wired it is always "excellent"). */
  signal: number;
  wired: boolean;
  cpuLoad: number;
  cpuTemp: number;
  memUsedPercent: number;
}

/**
 * Ad blocking summary, read from the JSON file written by `scripts/ntf-adblock-status.sh`.
 *
 * The app never talks to the AdGuard API directly: `/control/stats` needs the admin password, and
 * that password must not live in a renderer that displays arbitrary web pages. A root timer reads
 * it and republishes numbers only, so nothing here can change the household DNS config.
 */
export interface AdblockStats {
  /** False when the last collector run could not reach AdGuard. Counts below are then stale. */
  ok: boolean;
  /** Epoch seconds of the collector run, 0 when the file has never been written. */
  at: number;
  queries: number;
  blocked: number;
  /** Share of queries blocked, 0–100 with one decimal. Computed by the collector. */
  percent: number;
  topBlocked: AdblockDomain[];
  topQueried: AdblockDomain[];
  topClients: AdblockDomain[];
  /** Admin UI URL taken from the live AdGuard config, empty when unknown. */
  adminUrl: string;
}

/** One `[name, count]` row from the AdGuard stats API, already sorted high to low. */
export interface AdblockDomain {
  domain: string;
  count: number;
}

export interface DockState {
  active: ServiceId | null;
  /** Set when a dock web app (Google, m.youtube.com) occupies the content area instead of a service. */
  webAppId: string | null;
  keyboardOpen: boolean;
  /** True while a service page or the news reader is in front of Home. */
  inContent: boolean;
}
