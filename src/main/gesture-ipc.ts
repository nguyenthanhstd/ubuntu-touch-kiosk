/**
 * Kênh IPC của cử chỉ cạnh và cú chạm — `gesture:*`.
 *
 * Vì sao là một tệp riêng: đây là **bốn kênh × hai loại + một kênh chạm**, tức mười lần đăng ký, và
 * chúng có chung đúng một luật bảo mật: mọi sender phải là một trong ba view thật của ta. Để chung
 * trong `registerIpc()` thì vòng lặp ba chiều này nằm giữa các kênh nav và wallaper, và một lần sửa
 * luật tin cậy là một lần sửa tệp `main.ts` đã chạm trần nợ.
 *
 * `gesture:tap` không phải cử chỉ cạnh — nó được đăng ký ở đây vì nó dùng **cùng** phép kiểm tin cậy
 * và cùng lý do tồn tại (chạm ngón tay không sinh `mouseDown` ở main process trên nền Wayland).
 */

import { ipcMain } from 'electron';
import type { GestureKind } from '../shared/chrome.js';
import type { ViewManager } from './view-manager.js';
import { trace } from './trace.js';

/** Những gì tệp này cần từ main process. */
export interface GestureIpcDeps {
  /** `null` trước khi `bootstrap()` dựng xong các view. */
  views(): ViewManager | null;
  /** Đẩy tiến độ kéo ra dock để vẽ vệt chỉ báo mép. */
  sendGesture(kind: GestureKind | null, progress: number): void;
  /** Thanh trên phải vẽ lại sau khi trạng thái đổi. */
  pushState(): void;
}

const GESTURE_KINDS: readonly GestureKind[] = ['back', 'home'];
const GESTURE_PHASES: readonly string[] = ['begin', 'progress', 'fire', 'cancel'];

/**
 * Sender có phải một trong ba view của ta không.
 *
 * Đây là toàn bộ biên tin cậy của đường cử chỉ: một trang bị chiếm (quảng cáo, tin nhúng) cũng nói
 * được `gesture:home:fire` nếu ta không kiểm, và hậu quả là điều hướng do trang lạ quyết định.
 */
function isTrustedGestureSource(views: ViewManager | null, senderId: number): boolean {
  if (!views) return false;
  const candidates = [views.navContents, views.dockContents, views.serviceContents];
  const ok = candidates.some((c) => c && !c.isDestroyed() && c.id === senderId);
  trace(
    `trusted sender=${senderId} nav=${views.navContents?.id ?? -1} dock=${views.dockContents?.id ?? -1} svc=${views.serviceContents?.id ?? -1} ok=${String(ok)}`,
  );
  return ok;
}

export function registerGestureIpc(deps: GestureIpcDeps): void {
  for (const kind of GESTURE_KINDS) {
    for (const phase of GESTURE_PHASES) {
      ipcMain.on(`gesture:${kind}:${phase}`, (event, payload: unknown) => {
        const views = deps.views();
        if (!isTrustedGestureSource(views, event.sender.id)) return;
        if (phase === 'fire') {
          if (!views) return;
          if (kind === 'home') {
            // NTF-R13: đây là chỗ SIGTRAP 133 xuất hiện. `stopMedia()` → `loadURL('about:blank')` →
            // `removeChildView` → `webContents.close()` chạy trọn trong callback IPC đồng bộ, tức là
            // phá huỷ webContents ngay giữa lúc nó đang xử lý chính cú chạm đã sinh ra sự kiện này;
            // Chromium từ chối `blink.mojom.WidgetHost` và cả tiến trình chết (exit 133). Một đường
            // dọn duy nhất, tự hoãn, nằm trong `ViewManager.leaveToHome()`.
            void views.setKeyboardOpen(false);
            views.leaveToHome().then(deps.pushState).catch(() => deps.pushState());
            return;
          }
          views.back();
          deps.pushState();
          return;
        }
        if (phase === 'progress') {
          const progress = (payload as { progress?: unknown } | null)?.progress;
          if (typeof progress !== 'number' || !Number.isFinite(progress)) return;
          deps.sendGesture(kind, Math.min(1, Math.max(0, progress)));
          return;
        }
        if (phase === 'cancel') deps.sendGesture(null, 0);
        // 'begin' needs no main-process reaction; the hint strip only reacts to progress.
      });
    }
  }

  /*
   * Cú chạm khôi phục đường mở bàn phím tự động: trên nền này, focus bằng ngón tay không bao giờ sinh
   * `mouseDown` ở main process, nên báo cáo chạm là tín hiệu nhấn duy nhất ta có.
   */
  ipcMain.on('gesture:tap', (event, payload: unknown) => {
    trace(`gesture:tap from ${event.sender.id}`);
    const views = deps.views();
    if (!isTrustedGestureSource(views, event.sender.id)) return;
    if (payload !== null && typeof payload !== 'object') return;
    views?.notePress();
    // NTF-R11: một cú chạm ở bất kỳ view nội dung/dock/nav nào cũng phải đóng thẻ Âm lượng, vốn nằm
    // trong cửa sổ riêng và không bao giờ thấy `pointerdown` từ view khác.
    views?.dismissPopovers();
  });
}
