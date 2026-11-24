import { app, session, type Session } from 'electron';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SERVICES, WEB_APPS, isZoomLevel, type ServiceId } from '../shared/services.js';
import type { AppSettings } from '../shared/ipc.js';
import { WALLPAPERS, IDLE_DEFAULT_MS, isIdleChoice } from '../shared/ipc.js';
import { KEYBOARD_DEFAULT_H, KEYBOARD_MAX_H, KEYBOARD_MIN_H } from '../shared/chrome.js';

const ALLOWED_PROTOCOLS = new Set(['https:', 'http:', 'about:', 'blob:']);

/** Extensions that must never be downloaded or auto-opened by a kiosk visitor. */
const BLOCKED_EXTENSIONS =
  /\.(exe|msi|msix|deb|rpm|appimage|dmg|pkg|bat|cmd|ps1|sh|run|bin|apk|jar|scr|vbs|js|zip|7z|rar|iso)$/i;

/**
 * Captive form on purpose: every request for a dangerous protocol is denied, and we never
 * re-enable webSecurity or the Chromium sandbox.
 */
export function isSafeUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return ALLOWED_PROTOCOLS.has(parsed.protocol) || parsed.protocol === 'file:';
  } catch {
    return false;
  }
}

/**
 * Every visitor-reachable navigation must be http(s). `file:` stays in the safe set only because
 * the app's own Home page is loaded from disk, so anything that turns a navigation into a real
 * web navigation has to use this stricter test instead.
 */
export function isRemoteUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return ALLOWED_PROTOCOLS.has(parsed.protocol) && parsed.protocol !== 'blob:';
  } catch {
    return false;
  }
}

export function shouldBlockDownload(filename: string): boolean {
  return filename.length === 0 || BLOCKED_EXTENSIONS.test(filename);
}

/**
 * Permissions a gym visitor page may ever receive. Everything else (camera, microphone,
 * geolocation, MIDI, serial, USB, HID, Bluetooth, ...) is denied by default.
 */
const ALLOWED_PERMISSIONS = new Set([
  'fullscreen',
  'clipboard-sanitized-write',
  'pointerLock',
  'keyboardLock',
  'media-playback',
]);

export interface HardenedSession {
  id: ServiceId;
  session: Session;
}

export function createHardenedSessions(): HardenedSession[] {
  return (Object.keys(SERVICES) as ServiceId[]).map((id) => {
    const descriptor = SERVICES[id];
    const partition = session.fromPartition(descriptor.partition, { cache: true });

    partition.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(ALLOWED_PERMISSIONS.has(permission));
    });
    partition.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));

    partition.on('will-download', (event, item) => {
      if (shouldBlockDownload(item.getFilename())) {
        event.preventDefault();
      }
    });

    return { id, session: partition };
  });
}

/**
 * Drops cookies, storage and cache for one service. Called from "Kết thúc phiên" so the next
 * visitor never inherits a login left behind by a previous session on this machine.
 */
export async function clearServiceSession(id: ServiceId): Promise<void> {
  const partition = session.fromPartition(SERVICES[id].partition);
  await partition.clearStorageData();
  await partition.clearCache();
}

export async function clearAllServiceSessions(): Promise<void> {
  for (const id of Object.keys(SERVICES) as ServiceId[]) {
    await clearServiceSession(id);
  }
  for (const id of Object.keys(WEB_APPS)) {
    const partition = session.fromPartition(WEB_APPS[id]!.partition);
    await partition.clearStorageData();
    await partition.clearCache();
  }
}

const SETTINGS_FILE = () => join(app.getPath('userData'), 'ntfitness-settings.json');

/** The wallpaper the kiosk ships with. The brand photo, not a gradient. */
export const DEFAULT_WALLPAPER = 'studio';

export function defaultSettings(): AppSettings {
  const zoom = Object.fromEntries(
    (Object.keys(SERVICES) as ServiceId[]).map((id) => [id, SERVICES[id].defaultZoom]),
  ) as AppSettings['zoom'];
  return {
    zoom,
    uiZoom: 'normal',
    keyboardScale: KEYBOARD_DEFAULT_H,
    keyboardOrigin: null,
    wallpaper: DEFAULT_WALLPAPER,
    wallpaperImage: '',
    idleTimeoutMs: IDLE_DEFAULT_MS,
    keepAwakeOnMedia: false,
  };
}

export function loadSettings(): AppSettings {
  const path = SETTINGS_FILE();
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const merged = defaultSettings();
    for (const id of Object.keys(merged.zoom) as ServiceId[]) {
      const value = parsed.zoom?.[id];
      if (isZoomLevel(value)) merged.zoom[id] = value;
    }
    const ui = parsed.uiZoom;
    if (isZoomLevel(ui)) merged.uiZoom = ui;
    const scale = parsed.keyboardScale;
    if (typeof scale === 'number' && Number.isFinite(scale)) {
      merged.keyboardScale = Math.min(KEYBOARD_MAX_H, Math.max(KEYBOARD_MIN_H, Math.round(scale)));
    }
    // A saved popup origin is untrusted too. Accept only finite numbers; the main process clamps it
    // into the content band on every layout, so an out-of-range pair is harmless rather than fatal.
    const origin = parsed.keyboardOrigin;
    if (origin && typeof origin.x === 'number' && typeof origin.y === 'number'
      && Number.isFinite(origin.x) && Number.isFinite(origin.y)) {
      merged.keyboardOrigin = { x: Math.round(origin.x), y: Math.round(origin.y) };
    }    // A wallpaper id from disk is untrusted like any other input: an unknown value would leave the
    // page with no background at all, so fall back to the default preset.
    const wallpaper = parsed.wallpaper;
    if (typeof wallpaper === 'string' && (WALLPAPERS as readonly string[]).includes(wallpaper)) {
      merged.wallpaper = wallpaper;
    }
    const image = parsed.wallpaperImage;
    if (typeof image === 'string' && image.length > 0 && image.length < 4096 && existsSync(image)) {
      merged.wallpaperImage = image;
    } else if (merged.wallpaper === 'custom') {
      merged.wallpaper = 'graphite';
    }
    // Three untrusted values from the same file. Each falls back to the default rather than throwing:
    // a settings file with one bad field must not cost the visitor the other five.
    if (isIdleChoice(parsed.idleTimeoutMs)) merged.idleTimeoutMs = parsed.idleTimeoutMs;
    if (typeof parsed.keepAwakeOnMedia === 'boolean') merged.keepAwakeOnMedia = parsed.keepAwakeOnMedia;
    return merged;
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(settings: AppSettings): void {
  const path = SETTINGS_FILE();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(settings, null, 2), 'utf8');
  } catch (error) {
    console.error('[settings] cannot persist settings:', (error as Error).message);
  }
}
