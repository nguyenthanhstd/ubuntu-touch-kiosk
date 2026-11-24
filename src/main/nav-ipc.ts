/**
 * Các kênh IPC còn lại của kiosk: hình nền, điều hướng, và tin tức.
 *
 * Vì sao là một tệp riêng: `main.ts` vượt trần nợ 720 dòng từ trước tính năng màn hình chờ, và đây là
 * khối liền mạch duy nhất còn lại — mười kênh `nav:*` cộng bốn kênh `news:*`, không kênh nào trong số
 * đó cần biết cách dựng cửa sổ hay cách xếp khung. Tệp này chỉ trả lời "ai nhận sự kiện này, và nó gọi
 * `ViewManager`/`SettingsStore` thế nào".
 *
 * Hình nền nằm ở đây chứ không ở tệp riêng: nó là ba kênh `nav:*-wallpaper`, dùng chung đúng hai thứ
 * với các kênh nav khác (store và đường đẩy cài đặt), nên tách thêm một tệp chỉ tạo ranh giới giả.
 */

import { ipcMain, shell } from 'electron';
import { NEWS_FEEDS, SERVICE_ORDER, type ServiceId } from '../shared/services.js';
import { WALLPAPERS, type AppSettings } from '../shared/ipc.js';
import type { ZoomLevel } from '../shared/services.js';
import { isSafeUrl, saveSettings } from './security.js';
import type { NewsCache } from './news-cache.js';
import type { SettingsStore } from './settings.js';
import type { ViewManager } from './view-manager.js';

export interface NavIpcDeps {
  views(): ViewManager | null;
  store(): SettingsStore | null;
  news(): NewsCache | null;
  /** Ảnh nền hiện hành, để kênh hình nền trả về một bản đầy đủ khi không làm gì. */
  currentSettings(): AppSettings;
  /** Thanh trên phải vẽ lại sau mỗi lần điều hướng. */
  pushState(): void;
  /** Đẩy cài đặt mới (hình nền) ra mọi view đã đăng ký. */
  pushSettings(): void;
  /** Mở hộp chọn ảnh và chép ảnh vào `userData`; `null` khi khách hủy. */
  pickWallpaperImage(): Promise<string | null>;
}

export function registerNavIpc(deps: NavIpcDeps): void {
  /*
   * Hình nền. `id` được kiểm theo allowlist `WALLPAPERS` trước khi chạm store: đây là chuỗi đến từ một
   * trang, và `setWallpaper()` ghi thẳng vào tệp cài đặt. `custom` là nhánh duy nhất đụng tới đĩa, và
   * đường dẫn đã qua `pickWallpaperImage()` — không bao giờ là đường dẫn trang tự khai.
   */
  ipcMain.handle('nav:set-wallpaper', async (_event, id: unknown) => {
    const store = deps.store();
    if (!store) return deps.currentSettings();
    if (typeof id !== 'string' || !(WALLPAPERS as readonly string[]).includes(id)) return deps.currentSettings();
    if (id !== 'custom') {
      const settings = store.setWallpaper(id, '');
      saveSettings(settings);
      deps.pushSettings();
      return settings;
    }
    const picked = await deps.pickWallpaperImage();
    if (!picked) return deps.currentSettings();
    const settings = store.setWallpaper('custom', picked);
    saveSettings(settings);
    deps.pushSettings();
    return settings;
  });

  ipcMain.handle('nav:clear-wallpaper', () => {
    const store = deps.store();
    if (!store) return deps.currentSettings();
    const settings = store.setWallpaper('graphite', '');
    saveSettings(settings);
    deps.pushSettings();
    return settings;
  });

  ipcMain.on('nav:open', (_event, id: ServiceId) => {
    const views = deps.views();
    if (!views || !SERVICE_ORDER.includes(id)) return;
    void views.open(id).then(deps.pushState);
  });

  ipcMain.on('nav:home', () => {
    // NTF-R13: đi qua `leaveToHome()` để `stopMedia()` được chờ xong trước khi gỡ view, nếu không
    // Chromium giết cả tiến trình (exit 133) vì webContents bị phá huỷ giữa callback IPC đồng bộ.
    void deps
      .views()
      ?.leaveToHome()
      .then(deps.pushState)
      .catch(() => deps.pushState());
  });

  ipcMain.on('nav:back', () => deps.views()?.back());
  ipcMain.on('nav:forward', () => deps.views()?.forward());
  ipcMain.on('nav:reload', () => deps.views()?.reload());
  ipcMain.on('nav:stop', () => deps.views()?.stop());

  const applyZoom = (step: (views: ViewManager) => ZoomLevel | null): void => {
    const views = deps.views();
    const store = deps.store();
    if (!views || !store) return;
    const level = step(views);
    const id = views.activeService;
    // `stepZoom()` trả về mức đã ghi, nhưng chỉ ghi được khi có một view đang hiện — ở Home thì không
    // có gì để ghi, nên `id` cũng `null` và ta bỏ qua. Hai điều kiện này không thay thế nhau.
    if (level && id) saveSettings(store.setZoom(id, level));
    deps.pushState();
  };

  ipcMain.on('nav:zoom', (_event, delta: 1 | -1) => {
    applyZoom((views) => views.stepZoom(delta === -1 ? -1 : 1));
  });
  ipcMain.on('nav:zoom-reset', () => applyZoom((views) => views.resetZoom()));

  ipcMain.on('nav:keyboard', (_event, show: boolean) => {
    void deps
      .views()
      ?.setKeyboardOpen(Boolean(show))
      .then(deps.pushState);
  });

  ipcMain.handle('news:load', (_event, feedId: string) => {
    if (typeof feedId !== 'string' || !NEWS_FEEDS.some((feed) => feed.id === feedId)) {
      return {
        feedId: String(feedId),
        status: 'error',
        fetchedAt: new Date().toISOString(),
        items: [],
        message: 'Chuyên mục không hợp lệ.',
      };
    }
    return deps.news()?.get(feedId);
  });

  /**
   * Đọc tin giờ là web view Google News (`SERVICES.news.startUrl`), nhưng bản nav cũ vẫn có thể xin mở
   * một bài lẻ. Đẩy ra trình duyệt hệ thống là đường duy nhất giữ nguyên paywall và luồng đồng ý của
   * toà soạn — link Google News là redirect đã làm rối, batchexecute từ chối payload của ta.
   */
  ipcMain.handle('news:open', async (_event, link: string) => {
    if (typeof link !== 'string' || !isSafeUrl(link) || !link.startsWith('https:')) return false;
    try {
      await shell.openExternal(link, { activate: true });
      return true;
    } catch (error) {
      console.error('[news] cannot open article:', (error as Error).message);
      return false;
    }
  });
}
