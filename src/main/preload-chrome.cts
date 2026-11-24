import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  AppSettings,
  ChromeApi,
  ExternalAppState,
  FrameSettings,
  KeyboardDragApi,
  LockApi,
  PanelId,
  TopApi,
  VolumeState,
} from '../shared/ipc.js';
import type { AdblockStats, DockAction, DockState, GestureEvent, SystemStatus } from '../shared/chrome.js';
import type {
  PanelPolicy,
  PowerPanelApi,
  SettingsPanelApi,
  VolumePanelApi,
  ZoomPanelApi,
} from '../shared/panel.js';
import type { ZoomLevel } from '../shared/services.js';

/**
 * Bridge for the top bar. It can read status and post a clock, but it cannot navigate and cannot
 * start processes — that is the dock's bridge (preload-dock.cts). Splitting them means a defect in
 * the decorative strip can never reach the service layer.
 *
 * No gesture recognizer is installed here on purpose: the top bar is 44 px tall, so an edge swipe
 * can never complete inside it, and the keyboard page (which also uses this preload) must keep its
 * grip-drag-to-resize free of navigation semantics.
 */
const chrome: ChromeApi = {
  press: (action: DockAction) => ipcRenderer.send('chrome:press', action),
  onDock: (callback) => {
    const listener = (_event: IpcRendererEvent, state: DockState) => callback(state);
    ipcRenderer.on('ntf:dock', listener);
    return () => ipcRenderer.removeListener('ntf:dock', listener);
  },
  onGesture: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: GestureEvent) => callback(payload);
    ipcRenderer.on('ntf:gesture', listener);
    return () => ipcRenderer.removeListener('ntf:gesture', listener);
  },
  onClock: (callback) => {
    const listener = (_event: IpcRendererEvent, status: SystemStatus) => callback(status);
    ipcRenderer.on('ntf:clock', listener);
    return () => ipcRenderer.removeListener('ntf:clock', listener);
  },
  getClock: () => ipcRenderer.invoke('chrome:clock') as Promise<SystemStatus>,
  key: (data: string) => ipcRenderer.send('chrome:key', { kind: 'text', data }),
  keyBackspace: () => ipcRenderer.send('chrome:key', { kind: 'backspace' }),
  keyEnter: () => ipcRenderer.send('chrome:key', { kind: 'enter' }),
  keySpace: () => ipcRenderer.send('chrome:key', { kind: 'space' }),
  getKeyboardScale: () => ipcRenderer.invoke('chrome:keyboard-scale') as Promise<number>,
  setKeyboardScale: (scale: number) => ipcRenderer.invoke('chrome:set-keyboard-scale', scale) as Promise<number>,
  back: () => ipcRenderer.send('chrome:nav', 'back'),
  reload: () => ipcRenderer.send('chrome:nav', 'reload'),
  // NTF-R11: the keyboard page is the one view without a gesture recognizer (its grip drag must not
  // read as a navigation swipe), so it needs its own way to say "this tap was outside the popover".
  dismissPopovers: () => ipcRenderer.send('chrome:dismiss-popovers'),
};

/**
 * Bridge for the keyboard popup only — moving, resetting, and the drag trio.
 *
 * NTF-R14: this used to be four optional members of `ChromeApi` above, and three of them had no
 * bridge here at all. The page called `chrome.beginKeyboardDrag?.()`, the optional call swallowed
 * the missing method, main never captured a drag origin, `dragKeyboardTo` returned early, and the
 * grip captured the pointer while moving nothing. Typed as its own required interface so that gap
 * can no longer compile.
 */
const keyboardApi: KeyboardDragApi = {
  moveKeyboard: (dx: number, dy: number, commit?: boolean) =>
    ipcRenderer.invoke('chrome:move-keyboard', dx, dy, commit === true) as Promise<{ x: number; y: number } | null>,
  beginKeyboardDrag: () =>
    ipcRenderer.invoke('chrome:keyboard-drag-begin') as Promise<{ x: number; y: number } | null>,
  cancelKeyboardDrag: () =>
    ipcRenderer.invoke('chrome:keyboard-drag-cancel') as Promise<{ x: number; y: number } | null>,
  resetKeyboard: () => ipcRenderer.invoke('chrome:reset-keyboard-origin') as Promise<{ x: number; y: number } | null>,
};

/** Page-level state (title, loading, error) for the strip. Read-only, like the rest of this bridge. */
const topState: TopApi = {
  onState: (callback: (state: unknown) => void) => {
    const listener = (_event: IpcRendererEvent, state: unknown) => callback(state);
    ipcRenderer.on('ntf:top-state', listener);
    return () => ipcRenderer.removeListener('ntf:top-state', listener);
  },
  // External-app state is pushed by the main process only when the set changes, so the ✕ button
  // does not re-render once every poll.
  onApps: (callback: (state: ExternalAppState) => void) => {
    const listener = (_event: IpcRendererEvent, state: ExternalAppState) => callback(state);
    ipcRenderer.on('ntf:apps', listener);
    return () => ipcRenderer.removeListener('ntf:apps', listener);
  },
  closeApps: () => ipcRenderer.invoke('chrome:close-apps') as Promise<boolean>,
  closeFrontApp: () => ipcRenderer.invoke('chrome:close-app') as Promise<string | null>,
  // NTF-R11: the volume popover lives in this window, so a tap on a dock tile, a page or an external
  // app never reaches this document. The main process sees every view and forwards it here.
  onDismissPopovers: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('ntf:dismiss-popovers', listener);
    return () => ipcRenderer.removeListener('ntf:dismiss-popovers', listener);
  },
  getVolume: () => ipcRenderer.invoke('chrome:get-volume') as Promise<VolumeState>,
  setVolume: (level: number) => ipcRenderer.invoke('chrome:set-volume', level) as Promise<VolumeState>,
  setMuted: (muted: boolean) => ipcRenderer.invoke('chrome:set-muted', muted) as Promise<VolumeState>,
  goHome: () => ipcRenderer.send('chrome:press', { type: 'home' }),
  // Cỡ chữ không còn trên dải: nút `#btn-zoom` chỉ mở thẻ "NTF zoom", và thẻ đó nói qua hai kênh
  // `chrome:get-zoom` / `chrome:set-zoom` của cầu nối riêng `ntfZoom` bên dưới.
  // The corner masks repaint the wallpaper, so the frame needs the same settings the nav page gets,
  // plus the panel geometry that turns a 26x26 window into a slice of that wallpaper. Sent as a push
  // (`ntf:settings`) as well as readable on demand: a mask created before the nav page has finished
  // loading would otherwise paint the default wallpaper forever.
  getSettings: () => ipcRenderer.invoke('chrome:settings') as Promise<FrameSettings>,
  onSettings: (callback: (payload: FrameSettings) => void) => {
    const listener = (_event: IpcRendererEvent, payload: FrameSettings) => callback(payload);
    ipcRenderer.on('ntf:settings', listener);
    return () => ipcRenderer.removeListener('ntf:settings', listener);
  },
  // Ba kênh `chrome:open-<id>` là kênh một chiều do ipc-chrome.ts đăng ký trong một vòng lặp trên
  // PANEL_IDS, nên `send` là đủ: thanh trên không cần biết cửa sổ có dựng được hay không, và một
  // `invoke` sẽ treo nếu tiến trình chính chưa đăng ký kênh đó.
  openPanel: (id: PanelId) => ipcRenderer.send(`chrome:open-${id}`),
};

/**
 * Cầu nối của trang màn hình chờ.
 *
 * Trang khóa chỉ có ba việc, nên cầu nối chỉ có ba thành viên. Điện thoại/tablet cho mở khóa bằng một
 * cú chạm; ở đây `requestUnlock` là cú chạm đó, và `main.ts` vẫn giữ quyền từ chối (mốc `lockedAt`).
 */
const lockApi: LockApi = {
  getState: () => ipcRenderer.invoke('chrome:lock-state') as Promise<{ locked: boolean }>,
  requestUnlock: (at: number) => ipcRenderer.invoke('chrome:unlock', at) as Promise<boolean>,
  onState: (callback: (state: { locked: boolean }) => void) => {
    const listener = (_event: IpcRendererEvent, state: { locked: boolean }) => callback(state);
    ipcRenderer.on('ntf:lock-state', listener);
    return () => ipcRenderer.removeListener('ntf:lock-state', listener);
  },
};

/**
 * Cầu nối của thẻ Cài đặt.
 *
 * Ba thành viên, đúng ba việc thẻ làm được. `savePolicy` nhận cả hai giá trị trong một lời gọi
 * (xem `shared/panel.ts`): mỗi lần ghi là một lần ghi đĩa, và hai lần ghi cho một cú chạm Lưu là hai
 * lần có thể hỏng giữa đường.
 *
 * Mã nguồn KHÔNG đặt ở đây. Mã là mã sudo, kiểm bằng `sudo -S -v` (xem `main/sudo-check.ts`), nên
 * không có hàm băm nào để đặt hay xoá — thẻ Cài đặt không còn việc gì liên quan tới mã.
 */
const settingsApi: SettingsPanelApi = {
  getPolicy: () => ipcRenderer.invoke('chrome:get-panel-policy') as Promise<PanelPolicy>,
  savePolicy: (next: { idleTimeoutMs: number; keepAwakeOnMedia: boolean }) =>
    ipcRenderer.invoke('chrome:set-panel-policy', next) as Promise<PanelPolicy>,
  // Chỉ đọc. Số liệu do timer root ghi ra tệp, nên phần quản trị (đổi bộ lọc, xem từng truy vấn)
  // vẫn nằm ở giao diện web AdGuard — thẻ này không mở thêm đường ghi nào vào DNS.
  getAdblock: () => ipcRenderer.invoke('chrome:adblock') as Promise<AdblockStats>,
  close: () => ipcRenderer.send('chrome:close-panel', 'settings'),
};

/** Cầu nối của thẻ Âm lượng — ba kênh, dùng lại đúng ba kênh backend của thanh trên. */
const volumeApi: VolumePanelApi = {
  getVolume: () => ipcRenderer.invoke('chrome:get-volume') as Promise<VolumeState>,
  setVolume: (level: number) => ipcRenderer.invoke('chrome:set-volume', level) as Promise<VolumeState>,
  setMuted: (muted: boolean) => ipcRenderer.invoke('chrome:set-muted', muted) as Promise<VolumeState>,
  close: () => ipcRenderer.send('chrome:close-panel', 'volume'),
};

/**
 * Cầu nối của thẻ Cỡ chữ — ba kênh, hai kênh dùng lại đúng backend mà thanh trên đã dùng.
 *
 * `setZoom` nhận thẳng một `ZoomLevel` chứ không nhận bước ±: thẻ bày đủ bốn mức, và đi qua
 * `stepZoom()` bốn lần cho một cú chạm là bốn lần ghi đĩa.
 */
const zoomApi: ZoomPanelApi = {
  getZoom: () => ipcRenderer.invoke('chrome:get-zoom') as Promise<ZoomLevel | null>,
  setZoom: (level: ZoomLevel) => ipcRenderer.invoke('chrome:set-zoom', level) as Promise<ZoomLevel | null>,
  close: () => ipcRenderer.send('chrome:close-panel', 'zoom'),
};

/**
 * Cầu nối của thẻ Nguồn.
 *
 * Ba hành động phá huỷ đều mang `code`: mã được kiểm ở tiến trình chính (`CodeGuard` + `sudo -S -v`),
 * không phải ở đây. Renderer chỉ chuyển tiếp thứ khách gõ, nên một renderer bị chiếm vẫn không thể
 * bỏ qua bước kiểm.
 */
const powerApi: PowerPanelApi = {
  lock: () => ipcRenderer.send('chrome:lock'),
  restart: (code: string) => ipcRenderer.invoke('chrome:power', 'restart', code),
  shutdown: (code: string) => ipcRenderer.invoke('chrome:power', 'shutdown', code),
  exitToConsole: (code: string) => ipcRenderer.invoke('chrome:exit-console', code),
  close: () => ipcRenderer.send('chrome:close-panel', 'power'),
};

contextBridge.exposeInMainWorld('ntfChrome', chrome);
contextBridge.exposeInMainWorld('ntfKeyboard', keyboardApi);
contextBridge.exposeInMainWorld('ntfDock', chrome);
contextBridge.exposeInMainWorld('ntfTop', topState);
contextBridge.exposeInMainWorld('ntfLock', lockApi);
contextBridge.exposeInMainWorld('ntfSettings', settingsApi);
contextBridge.exposeInMainWorld('ntfVolume', volumeApi);
contextBridge.exposeInMainWorld('ntfZoom', zoomApi);
contextBridge.exposeInMainWorld('ntfPower', powerApi);
