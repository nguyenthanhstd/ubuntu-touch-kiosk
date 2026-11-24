import type { ServiceId, ZoomLevel } from '../shared/services.js';
import type { AppSettings } from '../shared/ipc.js';

type Listener = (settings: AppSettings) => void;

export type { AppSettings };

export class SettingsStore {
  private readonly data: AppSettings;
  private readonly listeners = new Set<Listener>();

  constructor(initial: AppSettings) {
    this.data = {
      zoom: { ...initial.zoom },
      uiZoom: initial.uiZoom,
      keyboardScale: initial.keyboardScale,
      keyboardOrigin: initial.keyboardOrigin ? { ...initial.keyboardOrigin } : null,
      wallpaper: initial.wallpaper,
      wallpaperImage: initial.wallpaperImage,
      idleTimeoutMs: initial.idleTimeoutMs,
      keepAwakeOnMedia: initial.keepAwakeOnMedia,
    };
  }

  get(): AppSettings {
    return {
      zoom: { ...this.data.zoom },
      uiZoom: this.data.uiZoom,
      keyboardScale: this.data.keyboardScale,
      keyboardOrigin: this.data.keyboardOrigin ? { ...this.data.keyboardOrigin } : null,
      wallpaper: this.data.wallpaper,
      wallpaperImage: this.data.wallpaperImage,
      idleTimeoutMs: this.data.idleTimeoutMs,
      keepAwakeOnMedia: this.data.keepAwakeOnMedia,
    };
  }

  /**
   * Idle timeout and the media exemption, written together.
   *
   * One setter rather than two because the settings card saves both in one gesture and each write
   * persists the whole file — two setters would rewrite the file twice per save.
   */
  setPanelPolicy(policy: { idleTimeoutMs?: number; keepAwakeOnMedia?: boolean }): AppSettings {
    if (policy.idleTimeoutMs !== undefined) this.data.idleTimeoutMs = policy.idleTimeoutMs;
    if (policy.keepAwakeOnMedia !== undefined) this.data.keepAwakeOnMedia = policy.keepAwakeOnMedia;
    return this.emit();
  }

  setKeyboardOrigin(origin: { x: number; y: number } | null): AppSettings {
    this.data.keyboardOrigin = origin ? { x: Math.round(origin.x), y: Math.round(origin.y) } : null;
    return this.emit();
  }

  setKeyboardScale(scale: number): AppSettings {
    this.data.keyboardScale = scale;
    return this.emit();
  }

  getZoom(id: ServiceId): ZoomLevel {
    return this.data.zoom[id];
  }

  getUiZoom(): ZoomLevel {
    return this.data.uiZoom;
  }

  setZoom(id: ServiceId, zoom: ZoomLevel): AppSettings {
    this.data.zoom[id] = zoom;
    return this.emit();
  }

  setUiZoom(zoom: ZoomLevel): AppSettings {
    this.data.uiZoom = zoom;
    return this.emit();
  }

  setWallpaper(id: string, image: string): AppSettings {
    this.data.wallpaper = id;
    this.data.wallpaperImage = image;
    return this.emit();
  }

  private emit(): AppSettings {
    const snapshot = this.get();
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
