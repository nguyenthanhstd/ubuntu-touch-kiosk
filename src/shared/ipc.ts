import type { ServiceId, ZoomLevel } from './services.js';
import type { DockAction, DockState, GestureEvent, SystemStatus } from './chrome.js';
import type { AppSettings, FrameSettings, WallpaperId } from './settings.js';

export type { GestureEvent } from './chrome.js';

/**
 * Re-exported so every existing `from '../shared/ipc.js'` import keeps working unchanged.
 *
 * The settings payload moved to `settings.ts` only to keep this file under the length cap; making
 * forty call sites chase a new path would have been churn without a boundary.
 */
export type {
  AppSettings,
  CornerPatch,
  FrameSettings,
  PanelGeometry,
  WallpaperId,
} from './settings.js';
export { IDLE_CHOICES_MS, IDLE_DEFAULT_MS, WALLPAPERS, isIdleChoice } from './settings.js';

export interface NewsItem {
  title: string;
  source: string;
  publishedAt: string;
  link: string;
}

export interface NewsFeedResult {
  feedId: string;
  status: 'ok' | 'stale' | 'error';
  fetchedAt: string;
  items: NewsItem[];
  message?: string;
}

export interface NavState {
  serviceId: ServiceId | null;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  title: string;
  currentHost: string;
  failed: { code: number; description: string } | null;
  zoom: ZoomLevel | null;
  /** Set when the active content is a dock web app rather than one of the five launcher services. */
  webAppId: string | null;
}


export interface NavAction {
  action: 'back' | 'forward' | 'reload' | 'stop' | 'service';
  serviceId?: ServiceId;
}

export interface NavApi {
  getState(): Promise<NavState>;
  onState(cb: (state: NavState) => void): () => void;
  onNavigate(cb: (action: NavAction) => void): () => void;
  onKeyboard(cb: (state: { open: boolean; height: number }) => void): () => void;
  goHome(): void;
  back(): void;
  forward(): void;
  reload(): void;
  stop(): void;
  zoom(delta: 1 | -1): void;
  zoomReset(): void;
  openService(id: ServiceId): void;
  toggleKeyboard(show: boolean): void;
  setNewsFront(open: boolean): void;
  getSettings(): Promise<AppSettings>;
  setUiZoom(level: ZoomLevel): Promise<AppSettings>;
  /** Applies a bundled wallpaper preset, or opens the image picker when given 'custom'. */
  setWallpaper(id: WallpaperId): Promise<AppSettings>;
  /** Clears a custom image and returns to the last gradient preset. */
  clearWallpaper(): Promise<AppSettings>;
}

export interface ChromeApi {
  /** Presses a dock item. One named channel keeps the dock free of navigation logic. */
  press(action: DockAction): void;
  onDock(cb: (state: DockState) => void): () => void;
  /** Live drag progress of an edge swipe, so the dock can draw the affordance. */
  onGesture(cb: (event: GestureEvent) => void): () => void;
  onClock(cb: (status: SystemStatus) => void): () => void;
  getClock(): Promise<SystemStatus>;
  /** Raw key events for local pages (Home has search boxes). Remote pages never reach this bridge. */
  key(data: string): void;
  keyBackspace(): void;
  keyEnter(): void;
  keySpace(): void;
  /** Persisted zoom of the on-screen keyboard, so a taller keyboard survives a restart. */
  getKeyboardScale(): Promise<number>;
  setKeyboardScale(scale: number): Promise<number>;
  /** History controls on the top strip; they act on whichever content view is in front. */
  back(): void;
  reload(): void;
  /**
   * Reports that a tap happened outside the top bar, so its popovers close — NTF-R11.
   *
   * The keyboard page is the only view without a gesture recognizer (its grip drag must not read as
   * a navigation swipe), yet the popup can be on screen while the volume popover is open. Nav, the
   * dock and the service pages already reach the main process through `gesture:tap`; this is the
   * missing fourth path.
   *
   * Optional on purpose: preload-dock.cts and preload-chrome.cts both implement this interface, and
   * the dock already covers the same case through `gesture:tap`. Making it required would force the
   * dock to carry a channel it never needs, which is the exact coupling `TopApi` exists to avoid.
   */
  dismissPopovers?(): void;
}

/**
 * The keyboard popup's own bridge: moving and resetting the popup, plus the drag trio.
 *
 * Split out of `ChromeApi` because two preloads implement `ChromeApi` as object literals
 * (`preload-chrome.cts` for the top strip and keyboard page, `preload-dock.cts` for the dock). When
 * these members lived on `ChromeApi` they had to be optional to spare the dock from carrying
 * channels it never uses — and optional is exactly what let a missing bridge in
 * `preload-chrome.cts` compile: the renderer's `chrome.beginKeyboardDrag?.()` turned into a
 * no-op, main never captured a drag origin, and the grip silently moved nothing.
 *
 * Every member here is required, and only the keyboard page sees this type, so "declared but not
 * bridged" is now a type error rather than a dead grip.
 */
export interface KeyboardDragApi {
  /**
   * Moves the popup and returns where it landed.
   *
   * `dx`/`dy` are **absolute offsets from the position captured at `pointerdown`**, not per-move
   * deltas: a delta accumulates while the view it moves is the same view whose `clientX` shrinks,
   * and the drag covers half the finger's travel. Main clamps into the content band, so the returned
   * point is the authority. The page's own `screenX`/`screenY` read 0 inside a `WebContentsView`,
   * which is why main owns the origin.
   *
   * `commit` writes the landed position to settings; preview calls during a drag must not, or a
   * cancelled gesture would persist a place the user rejected.
   */
  moveKeyboard(dx: number, dy: number, commit?: boolean): Promise<{ x: number; y: number } | null>;
  /** Captures the origin a drag is measured from; call once on `pointerdown`. */
  beginKeyboardDrag(): Promise<{ x: number; y: number } | null>;
  /** Aborts a drag and puts the popup back where the gesture started. Not a reset-to-default. */
  cancelKeyboardDrag(): Promise<{ x: number; y: number } | null>;
  /** Returns the popup to the shipped bottom-right corner. */
  resetKeyboard(): Promise<{ x: number; y: number } | null>;
}

export interface NewsApi {
  load(feedId: string): Promise<NewsFeedResult>;
  openArticle(link: string): Promise<boolean>;
}

/** One running external window, as reported to the top bar. */
export interface ExternalAppState {
  /** True when at least one closable external app is running. */
  running: boolean;
  /** Human labels of the running apps, for the button's tooltip. */
  labels: string[];
}

/**
 * Tên của bốn thẻ nổi: Cài đặt, Âm lượng, Cỡ chữ, Nguồn.
 *
 * Khai báo ở đây chứ không ở `panel.ts` vì `panel.ts` đã import `VolumeState` từ tệp này; đặt chiều
 * ngược lại sẽ thành vòng import. `main/panel-window.ts` khai `PANEL_SPECS` thoả mãn đúng union này,
 * nên thêm một thẻ mà quên `PANEL_SPECS` là lỗi biên dịch chứ không phải cửa sổ 0×0 lúc chạy.
 */
export type PanelId = 'settings' | 'volume' | 'zoom' | 'power';

/**
 * The top bar's own bridge. It is deliberately *not* part of ChromeApi: preload-dock.cts implements
 * ChromeApi as an object literal, so every added member there would have to be implemented by the
 * dock too — and the dock must never be able to kill external processes.
 */
export interface TopApi {
  onState(cb: (state: unknown) => void): () => void;
  /** Fires when the set of running external apps changes; not polled per frame. */
  onApps(cb: (state: ExternalAppState) => void): () => void;
  /** Asked for when the visitor confirms the ✕; resolves to true when nothing is left running. */
  closeApps(): Promise<boolean>;
  /**
   * Close only the external app that is currently in front — NTF-R09.
   *
   * The visitor-facing ✕ uses this instead of `closeApps()`: when Firefox and FreeTube are both open,
   * one tap must close the window covering the kiosk and leave the other app running. `closeApps()`
   * stays for the administrative path only.
   *
   * Resolves to the closed app's label, or `null` when there was nothing to close.
   */
  closeFrontApp(): Promise<string | null>;
  /**
   * Fires when something outside the top bar was tapped, so its popovers can close — NTF-R11.
   *
   * The volume popover lives in the top-bar window, whose document never sees a tap on a dock tile,
   * a page, or an external app. Without this the popover stays open until the volume button itself
   * is hit again. Emitted from the main process because it is the only place that hears every view.
   */
  onDismissPopovers(cb: () => void): () => void;
  /*
   * Cỡ chữ KHÔNG còn ở đây. Hai thành viên `zoom(delta)` và `onZoomChanged()` từng nằm đúng chỗ này
   * cho cụm A− / nhãn / A+ trên dải; cụm đó đã bị gỡ và thay bằng nút `#btn-zoom` mở thẻ nổi "NTF
   * zoom", nên hai thành viên này không còn ai gọi. Giữ lại sẽ là hai kênh chết mà lần sau ai đọc
   * cũng tưởng dải trên còn tự đổi được cỡ chữ. Đường một bước `chrome:zoom` cũng đi theo; đường của
   * trang nav (`NavApi.zoom` → `nav:zoom`) vẫn còn nguyên và vẫn dùng `ViewManager.stepZoom()`.
   */
  /** Current output volume, read from the default sink. Resolves once so the slider can open level. */
  getVolume(): Promise<VolumeState>;
  /** Sets 0–1. The main process clamps and unmutes, so a drag past 0 cannot leave a silent panel. */
  setVolume(level: number): Promise<VolumeState>;
  /** Mutes or unmutes without losing the remembered level. */
  setMuted(muted: boolean): Promise<VolumeState>;
  /** Leaves the current app and returns to Home; same path as the dock's Home tile. */
  goHome(): void;
  /**
   * Mở một trong ba thẻ nổi.
   *
   * Thanh trên có ba nút mở thẻ (loa, bánh răng, nguồn) nhưng `TopApi` không có thành viên nào mở
   * được cửa sổ: `chrome:open-<id>` là kênh **một chiều** do `main/ipc-chrome.ts` đăng ký, nên chỉ cần
   * gửi là đủ, không cần `invoke` và không cần biết cửa sổ có dựng được hay không.
   *
   * Cố ý **không** là thành viên của `ChromeApi`: `preload-dock.cts` hiện thực `ChromeApi` bằng object
   * literal, nên thêm vào đó là dock cũng phải mở được thẻ — trong khi dock chỉ có một nút Khóa và
   * nút đó gọi thẳng `chrome:lock`.
   */
  openPanel(id: PanelId): void;
  /**
   * Settings snapshot plus panel geometry — the corner masks need both to repaint the wallpaper.
   *
   * The wallpaper itself (id + picture path) is not enough: a mask window is only 26x26 and has to
   * draw the slice of the panel-sized picture that belongs under it, so it also needs the panel size
   * and its own offset inside the panel.
   *
   * Read once on load and then kept live through `onSettings`: the visitor can change the wallpaper
   * from the dock while an external app is already framed, and a mask painted with the old picture
   * would be a visible rectangle of the wrong colour in the corner.
   */
  getSettings(): Promise<FrameSettings>;
  /** Fires whenever the settings or the geometry above change. */
  onSettings(cb: (payload: FrameSettings) => void): () => void;
}

/**
 * Cầu nối riêng của trang màn hình chờ.
 *
 * Không dùng lại `ChromeApi`/`TopApi`: hai cầu nối đó gắn với cửa sổ thanh trên và dock, và màn hình
 * chờ chỉ cần đúng ba việc — biết đang khóa hay chưa, xin mở khóa, và nhận giờ để vẽ đồng hồ. Một cầu
 * nối hẹp như vậy giữ cho trang khóa không thể vô tình gọi được `setVolume()` hay `closeApps()`.
 */
export interface LockApi {
  /** Trạng thái khóa hiện tại, hỏi lúc trang nạp. */
  getState(): Promise<{ locked: boolean }>;
  /** Có ai đó chạm/vuốt trên màn hình chờ. `at` do trang gửi để main so với mốc vừa khóa. */
  requestUnlock(at: number): Promise<boolean>;
  /** Main đẩy trạng thái xuống, để trang tắt hiệu ứng khi vừa được mở. */
  onState(cb: (state: { locked: boolean }) => void): () => void;
}

/** Output volume of the default sink, as the top bar shows it. */
export interface VolumeState {
  /** 0–1. Kept as a fraction so the slider position needs no conversion. */
  level: number;
  muted: boolean;
  /** ALSA/PipeWire sink description for the tooltip, '' when unknown. */
  sink: string;
}

