import type { ServiceId, ZoomLevel } from './services.js';

/**
 * Everything the panel persists, plus the policy constants that police it.
 *
 * Split out of `ipc.ts` so the settings payload does not travel with the IPC surface: `security.ts`
 * and `settings.ts` only ever need this file, and a change to the exit PIN must not force a rebuild
 * of every renderer's understanding of the chrome bridge.
 */
export interface AppSettings {
  zoom: Record<ServiceId, ZoomLevel>;
  /** Last zoom picked on the Home screen for the local reader UI. */
  uiZoom: ZoomLevel;
  /** On-screen keyboard height in CSS px; the panel is 1600 px tall, 260 reads at one metre. */
  keyboardScale: number;
  /**
   * Where the visitor last dragged the keyboard popup, in window CSS px — null keeps the shipped
   * bottom-right anchor.
   *
   * Stored as a top-left origin rather than a delta so it stays meaningful after a restart, and
   * re-clamped by the main process on every layout, so a position saved on a larger panel can never
   * strand the popup outside the frame.
   */
  keyboardOrigin: { x: number; y: number } | null;
  /** Wallpaper preset id, or 'custom' when the visitor picked an image of their own. */
  wallpaper: string;
  /** Absolute path of the chosen image inside userData/wallpapers, '' when none. */
  wallpaperImage: string;
  /**
   * Milliseconds of no touch, key or pointer before the panel raises the screen saver; `0` turns it off.
   *
   * An allowlist rather than a free number: the value is offered as six fixed choices on the settings
   * card, and a stored value outside the list would be a typo or a tampered file. `loadSettings()`
   * falls back to the default instead of trusting it, because a too-small value would lock the panel
   * while a visitor is reading and a huge one would leave it unlocked all night.
   */
  idleTimeoutMs: number;
  /**
   * Keep the panel awake while a video is playing in a content view.
   *
   * Off by default: the evdev watcher sees a finger on the screen but cannot see a video playing, and
   * a film is mostly stillness. On, the main process asks the content view whether media is playing
   * before it honours the timeout.
   */
  keepAwakeOnMedia: boolean;
}

/**
 * Idle timeout choices offered on the settings card, in milliseconds.
 *
 * `IDLE_DEFAULT_MS` is the shipped value: ten minutes is long enough that a visitor reading a long
 * article is not interrupted, and short enough that an abandoned panel is dark before the next
 * visitor walks up. The evdev watcher can only measure input, so this is a judgement, not a measurement.
 */
export const IDLE_CHOICES_MS = [0, 120_000, 300_000, 600_000, 900_000, 1_800_000] as const;
export const IDLE_DEFAULT_MS = 600_000;

/**
 * True when `value` is one of the six offered timeouts.
 *
 * Written as a set membership rather than a range check on purpose: a range would accept 601_000 from
 * a tampered settings file, and the card would then have no selected radio button — a UI with no valid
 * state is worse than a value the visitor never chose.
 */
export function isIdleChoice(value: unknown): value is number {
  return typeof value === 'number' && (IDLE_CHOICES_MS as readonly number[]).includes(value);
}

/**
 * Bundled wallpapers. 'studio' is the shipped photograph (assets/NT-Studio-2145-edited.png, copied
 * to dist/assets by scripts/copy-assets.mjs and painted from nav.css); the rest are CSS gradients,
 * so they cost no asset. 'custom' means the visitor picked a file of their own.
 */
export const WALLPAPERS = [
  'studio',
  'graphite',
  'noir',
  'ember',
  'sage',
  'ocean',
  'sunset',
  'plum',
  'custom',
] as const;

export type WallpaperId = (typeof WALLPAPERS)[number];

/** Một ô mặt nạ góc, theo toạ độ **panel** (không phải toạ độ trong băng nội dung). */
export interface CornerPatch {
  x: number;
  y: number;
  /** Cạnh của ô vuông, luôn là `FRAME_MASK_CSS` (26). */
  size: number;
}

/**
 * Hình học panel mà bốn ô mặt nạ góc cần để vẽ lại hình nền cho đúng chỗ.
 *
 * Ô mặt nạ chỉ rộng 26x26, nhưng hình nền nó phải vẽ là hình nền của cả panel: nav page phủ toàn
 * cửa sổ kiosk (`view-manager.ts` đặt `navView` = {0,0,width,height}), nên ảnh nền bắt đầu ở gốc
 * panel chứ không phải ở mép băng. Không có kích thước panel và toạ độ tuyệt đối của chính ô góc
 * thì không có cách nào cắt đúng mảnh 26x26 ấy ra khỏi bức hình — mà lệch một pixel là bốn góc
 * thành bốn ô sai màu, tệ hơn hẳn cái góc vuông mà chúng định che.
 *
 * Số đo đến từ main process, không phải từ renderer: dưới Wayland `screen.width` trong một cửa sổ
 * trả kích thước *cửa sổ* (26), không phải kích thước output.
 */
export interface PanelGeometry {
  width: number;
  height: number;
  corners: Record<'tl' | 'tr' | 'bl' | 'br', CornerPatch>;
}

/** Payload của `ntf:settings` / `chrome:settings`, dùng riêng cho các cửa sổ khung. */
export interface FrameSettings {
  settings: AppSettings;
  geometry: PanelGeometry;
}
