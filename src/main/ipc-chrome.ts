import { ipcMain } from 'electron';
import { DOCK_ORDER, isZoomLevel } from '../shared/services.js';
import { KEYBOARD_MAX_H, KEYBOARD_MIN_H, type DockAction } from '../shared/chrome.js';
import { isIdleChoice } from '../shared/settings.js';
import { readAdblockStats } from './adblock.js';
import { saveSettings } from './security.js';
import { closeExternalApps, closeFrontExternalApp, scanExternalApps, scanExternalGroups } from './external-apps.js';
import type { ChromeIpcHost } from './ipc-host.js';
import type { PanelId } from './panel-window.js';
import { readVolume, writeMuted, writeVolume } from './volume.js';

/**
 * Kênh IPC của thanh trên, dock và bàn phím — tức là toàn bộ bridge `ntfChrome`/`ntfDock`/`ntfTop`
 * trong `preload-chrome.cts`.
 *
 * Gom vào một tệp để tên channel nằm cùng chỗ với nơi đăng ký: trước đây chúng rải trong `main.ts`
 * trộn với vòng đời cửa sổ, nên một lần đổi tên trong preload là một lỗi chỉ hiện ra khi bấm nút
 * trên panel. Tệp này không giữ trạng thái nào — mọi thứ đi qua `ChromeIpcHost`.
 */

export type { ChromeIpcHost } from './ipc-host.js';

export function registerChromeIpc(host: ChromeIpcHost): void {
  ipcMain.on('chrome:press', (_event, raw: unknown) => {
    // parseDockAction nằm trong dock-actions.ts, cùng chỗ với người dùng nó, để hình dạng hợp lệ
    // của DockAction chỉ được mô tả ở một nơi.
    const action = host.parseAction(raw);
    if (!action) return;
    // Mục bàn phím là mục duy nhất không đi qua kiểm tra DOCK_ORDER bên dưới, vì nó là công tắc
    // bật/tắt chứ không phải một đích đến. `close-app` và `session` cũng vậy: chúng không phải đích
    // đến mà là hai hành động khác hẳn nhau (NTF-R09).
    if (
      action.type !== 'keyboard' &&
      action.type !== 'home' &&
      action.type !== 'session' &&
      action.type !== 'close-app'
    ) {
      const key =
        action.type === 'service'
          ? action.id
          : action.type === 'web'
            ? `web:${action.id}`
            : action.type === 'app'
              ? `app:${action.id}`
              : 'browser';
      if (!DOCK_ORDER.includes(key)) return;
    }
    void host.handleDockAction(action);
  });

  ipcMain.handle('chrome:clock', () => host.monitor.snapshot());

  // Số liệu chặn quảng cáo do một timer root ghi ra tệp JSON; ở đây chỉ đọc tệp đó. Không có tham
  // số đầu vào nên bên gọi không thể hỏi gì ngoài "cho tôi con số mới nhất".
  ipcMain.handle('chrome:adblock', () => readAdblockStats());

  // Lời gọi duy nhất có tính phá huỷ trong bridge. Nó chỉ với tới các executable trong
  // EXTERNAL_PROCS, nên không thể chạm vào chính kiosk dù bên gọi có bị chiếm.
  ipcMain.handle('chrome:close-apps', async () => {
    const closed = await closeExternalApps();
    // Vòng poll sẽ tự thấy, nhưng đẩy ngay để nút ✕ không nán lại tới 2 s.
    host.pushApps(scanExternalApps().labels);
    return closed;
  });

  // NTF-R09: nút ✕ của khách đóng **đúng một** thứ đang ở phía trước — trong một lần chạm, không hỏi
  // kết thúc phiên và không xoá dữ liệu duyệt web. Trước đây kênh này gọi `closeExternalApps()` nên
  // Firefox và FreeTube cùng mở thì một cú chạm giết cả hai.
  //
  // Thứ tự xét đúng theo lớp nhìn thấy: app ngoài nằm *trên* băng nội dung, nên nếu có app ngoài thì
  // nó là thứ đang che kiosk và nó là thứ phải đóng; app còn lại (nếu có) vẫn chạy. Chỉ khi không có
  // app ngoài nào thì mới đóng băng nội dung nhúng — dừng media rồi gỡ view qua `leaveToHome()`, tức
  // là cùng đường dọn đã sửa cho NTF-R13.
  ipcMain.handle('chrome:close-app', async () => {
    // Cùng lý do như nhánh `close-app` của dock: overlay bàn phím đang map thì chính nó giữ
    // `state:active` của compositor, nên phải tắt nó trước khi hỏi app nào đang ở phía trước.
    const views = host.views();
    if (views?.keyboardVisible) await views.setKeyboardOpen(false);
    const label = await closeFrontExternalApp();
    if (label !== null) {
      host.pushApps(scanExternalApps().labels);
      if (views && scanExternalGroups().length === 0) {
        // Hết app ngoài thì đích phím trả về kiosk, và popup đang phục vụ app vừa đóng phải tắt —
        // nếu không nó nằm lại trên màn Home, nơi không còn ô nhập nào.
        await views.setKeyboardOpen(false);
        await views.setKeyboardTarget('kiosk');
      }
      // `pushApps` chỉ cập nhật hàng đợi app ngoài; `dockState` (chứa cờ `keyboardOpen`) là payload
      // khác. Thiếu dòng này thì ô bàn phím còn sáng sau khi popup đã tắt.
      host.pushState();
      return label;
    }
    const viewsAfter = host.views();
    if (!viewsAfter?.hasVisibleContent()) return null;
    await viewsAfter.setKeyboardOpen(false);
    await viewsAfter.setKeyboardTarget('kiosk');
    await viewsAfter.leaveToHome();
    host.pushState();
    return 'nội dung kiosk';
  });

  // Back và Reload thuộc về dải trên. Chúng tác động lên view nội dung đang ở trước mặt, nên vẫn
  // dùng được phía trên một trang từ xa — nơi nút của chính trang đó không với tới.
  ipcMain.on('chrome:nav', (_event, which: unknown) => {
    if (which === 'back') host.views()?.back();
    else if (which === 'reload') host.views()?.reload();
  });

  ipcMain.on('chrome:key', (_event, raw: unknown) => {
    if (!raw || typeof raw !== 'object') return;
    const kind = (raw as { kind?: unknown }).kind;
    if (kind === 'text') {
      const data = (raw as { data?: unknown }).data;
      // NTF-R06: giới hạn cũ là 8 là dấu vết của thời gửi cả chuỗi trong một `keyCode`. Bàn phím
      // hiện gửi từng code point một, nên chỉ cần chặn một payload bất thường — không cắt chữ người
      // dùng gõ. 64 đủ cho một chuỗi dán dài mà vẫn không thành đường đổ dữ liệu vào trang.
      if (typeof data !== 'string' || data.length === 0 || data.length > 64) return;
      host.views()?.sendKey({ kind: 'text', data });
      return;
    }
    if (kind === 'backspace' || kind === 'enter' || kind === 'space') {
      host.views()?.sendKey({ kind });
    }
  });

  ipcMain.handle('chrome:keyboard-scale', () => host.currentSettings().keyboardScale);

  // Mặt nạ góc của khung cần đúng bức hình nền mà nav page đang vẽ, nếu không bốn góc sẽ là bốn ô
  // lệch màu. Trả cả settings lẫn hình học panel: riêng bức hình không đủ, mặt nạ 26x26 còn phải
  // biết cắt mảnh nào ra khỏi hình nền cỡ panel.
  ipcMain.handle('chrome:settings', () => host.frameSettings());
  ipcMain.handle('chrome:set-keyboard-scale', (_event, value: unknown) => {
    const store = host.store();
    if (!store || typeof value !== 'number' || !Number.isFinite(value)) return host.currentSettings().keyboardScale;
    const scale = Math.min(KEYBOARD_MAX_H, Math.max(KEYBOARD_MIN_H, Math.round(value)));
    // Áp dụng trực tiếp thay vì đóng rồi mở lại: grip gọi kênh này ở mỗi pointermove, và một lần
    // huỷ view mỗi frame sẽ làm bàn phím nhấp nháy tắt/bật.
    const views = host.views();
    views?.setKeyboardScale(scale);
    saveSettings(store.setKeyboardScale(scale));
    views?.keyboardContents?.send('ntf:keyboard-scale', scale);
    return scale;
  });

  // Di chuyển popup bàn phím (NTF-R10): ba kênh begin/move/end thay cho một kênh delta cộng dồn.
  //
  // Bản cũ nhận *delta* và cộng vào `view.getBounds()` ở mỗi bước. Nhưng chính view đó đang bị dời,
  // nên `clientX` trong trang trôi theo và mỗi bước tự khử đúng phần vừa dịch — đo trên panel: kéo
  // (−240, −112) px thì popup chỉ đi (−120, −56). Nay main chốt origin lúc `pointerdown` và mỗi bước
  // nhận **offset tuyệt đối** so với origin đó, nên sai số không cộng dồn.
  ipcMain.handle('chrome:keyboard-drag-begin', () => {
    const views = host.views();
    return views ? views.beginKeyboardDrag() : null;
  });
  ipcMain.handle('chrome:move-keyboard', (_event, dx: unknown, dy: unknown, commit: unknown) => {
    const views = host.views();
    if (!views) return null;
    const landed = views.dragKeyboardTo(
      typeof dx === 'number' && Number.isFinite(dx) ? dx : 0,
      typeof dy === 'number' && Number.isFinite(dy) ? dy : 0,
    );
    // Chỉ ghi đĩa khi thả tay. Preview trong lúc kéo không được chạm `settings.json`.
    if (commit === true) {
      const origin = views.keyboardOriginValue;
      const store = host.store();
      if (store) saveSettings(store.setKeyboardOrigin(origin));
    }
    return landed;
  });
  ipcMain.handle('chrome:keyboard-drag-cancel', () => {
    const views = host.views();
    return views ? views.cancelKeyboardDrag() : null;
  });
  ipcMain.handle('chrome:reset-keyboard-origin', () => {
    const views = host.views();
    if (!views) return null;
    views.setKeyboardOrigin(null);
    saveSettings(host.store()?.setKeyboardOrigin(null) ?? host.currentSettings());
    return views.keyboardRect ? { x: views.keyboardRect.x, y: views.keyboardRect.y } : null;
  });

  // Âm lượng: ba kênh này là đường duy nhất để đổi âm lượng trên panel, vì panel không có phím
  // cứng. Backend nằm ở volume.ts (wpctl) và luôn trả trạng thái *thật* sau khi ghi.
  ipcMain.handle('chrome:get-volume', () => readVolume());
  ipcMain.handle('chrome:set-volume', (_event, level: unknown) =>
    writeVolume(typeof level === 'number' && Number.isFinite(level) ? level : 0),
  );
  ipcMain.handle('chrome:set-muted', (_event, muted: unknown) => writeMuted(muted === true));

  // NTF-R11: bàn phím là view duy nhất không có bộ nhận cử chỉ (kéo grip không được thành cú vuốt
  // điều hướng), nên nó tự báo "cú chạm này nằm ngoài popover". Đi qua cùng `dismissPopovers()` mà
  // `gesture:tap` dùng để chỉ có một đường đóng.
  ipcMain.on('chrome:dismiss-popovers', () => host.views()?.dismissPopovers());


  // Màn hình chờ: ba kênh, và cả ba đều chỉ đi qua `host` — tệp này không giữ trạng thái khóa, để
  // "đang khóa hay không" chỉ có một nguồn là máy trạng thái ở `lock-state.ts`.
  ipcMain.on('chrome:lock', () => host.lock());
  ipcMain.handle('chrome:lock-state', () => host.lockState());
  ipcMain.handle('chrome:unlock', (_event, at: unknown) =>
    host.requestUnlock(typeof at === 'number' && Number.isFinite(at) ? at : 0),
  );

  // ---- Thẻ nổi -------------------------------------------------------------------------------

  /*
   * Mở/đóng theo `PanelId`, không theo toạ độ hay tiêu đề: danh sách hợp lệ nằm trong
   * `PANEL_SPECS` (panel-window.ts), nên một cái tên lạ bị từ chối ngay ở đây thay vì tạo ra một cửa
   * sổ 0×0 không ai đóng được.
   */
  const PANEL_IDS: PanelId[] = ['settings', 'volume', 'zoom', 'power'];
  const readPanelId = (raw: unknown): PanelId | null =>
    typeof raw === 'string' && (PANEL_IDS as string[]).includes(raw) ? (raw as PanelId) : null;

  for (const id of PANEL_IDS) {
    ipcMain.on(`chrome:open-${id}`, () => host.openPanel(id));
  }

  ipcMain.on('chrome:close-panel', (_event, raw: unknown) => {
    const id = readPanelId(raw);
    if (id) host.closePanel(id);
  });

  ipcMain.handle('chrome:get-panel-policy', () => host.panelPolicy());

  /*
   * Chỉ nhận `idleTimeoutMs` nằm trong `IDLE_CHOICES_MS`: một giá trị lạ (kể cả `NaN` hay số âm) sẽ
   * làm bộ đếm nhàn rỗi khóa màn hình ngay hoặc không bao giờ, và cả hai đều là lỗi người dùng không
   * tự sửa được từ panel. Giá trị sai bị bỏ qua và main trả trạng thái cũ, nên màn hình tự quay về
   * đúng thực tế.
   */
  ipcMain.handle('chrome:set-panel-policy', (_event, raw: unknown) => {
    const patch: { idleTimeoutMs?: number; keepAwakeOnMedia?: boolean } = {};
    if (raw !== null && typeof raw === 'object') {
      const record = raw as Record<string, unknown>;
      if (typeof record.idleTimeoutMs === 'number' && isIdleChoice(record.idleTimeoutMs)) {
        patch.idleTimeoutMs = record.idleTimeoutMs;
      }
      if (typeof record.keepAwakeOnMedia === 'boolean') {
        patch.keepAwakeOnMedia = record.keepAwakeOnMedia;
      }
    }
    return host.writePanelPolicy(patch);
  });

  // Cỡ chữ của thẻ Cỡ chữ. Nhận một `ZoomLevel` chứ không nhận số: bốn mức là bốn tỉ lệ đã biết, và
  // một số thực từ trang sẽ đẩy trang tới một tỉ lệ không ai kiểm được.
  ipcMain.handle('chrome:get-zoom', () => host.currentZoom());
  ipcMain.handle('chrome:set-zoom', (_event, raw: unknown) =>
    isZoomLevel(raw) ? host.setZoom(raw) : host.currentZoom(),
  );

  /*
   * Nguồn: ba hành động phá huỷ, cả ba đều phải kèm mã. Mã được đọc thành chuỗi ở đây rồi đi thẳng
   * vào `host`, nơi `CodeGuard` đếm và `sudo-check.ts` kiểm. Không có kênh "đã mở khoá" riêng — một
   * trạng thái mở khoá sống lâu hơn một lời gọi là một cửa sổ thời gian không ai cần.
   */
  const readCode = (raw: unknown): string => (typeof raw === 'string' ? raw : '');
  ipcMain.handle('chrome:power', (_event, kind: unknown, code: unknown) => {
    if (kind !== 'restart' && kind !== 'shutdown') {
      return Promise.resolve({ ok: false, message: 'Hành động không hợp lệ' });
    }
    return host.powerAction(kind, readCode(code));
  });

  ipcMain.handle('chrome:exit-console', (_event, code: unknown) => host.exitToConsole(readCode(code)));
}

