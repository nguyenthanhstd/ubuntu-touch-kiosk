/**
 * Renderer-side declarations for the two preload bridges. These files are compiled by the same
 * tsconfig as the main process, so the global Window augmentation has to live in the project rather
 * than in a separate renderer tsconfig.
 */
import type { ChromeApi, KeyboardDragApi, LockApi, TopApi } from '../shared/ipc.js';
import type { PowerPanelApi, SettingsPanelApi, VolumePanelApi, ZoomPanelApi } from '../shared/panel.js';


declare global {
  interface Window {
    /** Exposed by preload-chrome.cts (top strip, keyboard page). */
    ntfChrome: ChromeApi;
    /**
     * Exposed by preload-chrome.cts (top strip, keyboard page). Required members only — the
     * keyboard popup calls these without `?.` so a missing bridge fails at compile time.
     */
    ntfKeyboard: KeyboardDragApi;
    /** Exposed by preload-chrome.cts and preload-dock.cts (dock strip). */
    ntfDock: ChromeApi;
    /** Exposed by preload-chrome.cts only (top strip). Not available to the dock. */
    ntfTop: TopApi;
    /**
     * Exposed by preload-chrome.cts only, and only for the lock page.
     *
     * Deliberately its own surface instead of a member of `ntfChrome`: the lock page has no business
     * reaching `setVolume()` or `closeApps()`, and a narrow bridge is the cheapest way to make that
     * true (RULE §4 S1 — validate at the boundary by exposing the least).
     */
    ntfLock: LockApi;
    /**
     * Bốn thẻ nổi (Cài đặt, Âm lượng, Cỡ chữ, Nguồn) — mỗi thẻ một bề mặt riêng.
     *
     * Cả bốn đều khai báo như bề mặt độc lập thay vì một `ntfPanel` chung: thẻ Âm lượng không có
     * việc gì với mã quản trị, và thẻ Nguồn không có việc gì với giờ chờ. Một bề mặt chung sẽ khiến
     * bốn trang có thể gọi được bốn nhóm quyền của nhau (RULE §4 S1 — chỉ mở đúng thứ cần mở).
     */
    ntfSettings: SettingsPanelApi;
    ntfVolume: VolumePanelApi;
    ntfZoom: ZoomPanelApi;
    ntfPower: PowerPanelApi;
  }
}

export {};
