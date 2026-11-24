import { BrowserWindow } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Rect } from './layout.js';

/**
 * Cửa sổ màn hình chờ — một cửa sổ `alwaysOnTop` riêng phủ kín panel.
 *
 * Vì sao phải là cửa sổ chứ không phải `WebContentsView` của kiosk: kiosk bị
 * `gen-labwc-config.sh` ghim `ToggleAlwaysOnBottom`, nên mọi view con của nó **luôn** nằm dưới mọi
 * app ngoài. Đó chính là lý do R05 của báo cáo 07 thất bại với popup bàn phím. Màn hình chờ mà để lộ
 * video FreeTube đang chạy phía sau thì không phải màn hình chờ.
 *
 * Cơ chế đã được đo là nằm trên app ngoài trên chính máy này là cửa sổ `alwaysOnTop` riêng — cách
 * `keyboard-overlay.ts` và `frame-window.ts` đang dùng. Tệp này theo đúng khuôn đó, khác hai điểm:
 *
 * 1. **Nhận focus.** Bàn phím ảo cố tình không nhận, vì nhận là mất đích gõ. Màn hình chờ thì ngược
 *    lại: nó phải giữ focus để phím và chạm không rơi xuống trang bên dưới trong lúc panel đang khóa.
 * 2. **Dựng sẵn lúc khởi động.** Bàn phím dựng khi cần vì nó to và hiếm; màn hình chờ phải hiện ngay
 *    giây phút hết giờ nhàn rỗi, và một khung hình trắng của trang chưa nạp xong là thứ người đi
 *    ngang nhìn thấy. Dựng sẵn một cửa sổ ẩn đổi lấy việc hiện tức thì.
 */

const RENDERER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'renderer');
const CHROME_PRELOAD = join(dirname(fileURLToPath(import.meta.url)), 'preload-chrome.cjs');

/** `title` cố định; khớp rule `title="NTF lock"` trong gen-labwc-config.sh. */
export const LOCK_OVERLAY_TITLE = 'NTF lock';

export class LockOverlay {
  private window: BrowserWindow | null = null;
  private desiredVisible = false;

  constructor(private readonly rectFor: () => Rect) {}

  /**
   * Dựng cửa sổ (một lần) và nạp trang màn hình chờ.
   *
   * Trả `false` khi không dựng được. Nơi gọi vẫn khóa được bằng cách khác (`main.ts` ghi một lớp phủ
   * lên chính kiosk), nhưng lớp phủ đó chỉ che được trang nội bộ — nên lỗi ở đây được ghi nhật ký chứ
   * không làm sập luồng khóa.
   */
  create(): boolean {
    if (this.window && !this.window.isDestroyed()) return true;
    const rect = this.rectFor();
    try {
      const window = new BrowserWindow({
        ...rect,
        show: false,
        frame: false,
        // Đen đặc, không trong suốt: màn hình chờ là "nền đen sâu để đỡ tốn điện" theo yêu cầu, và
        // một cửa sổ trong suốt sẽ để lộ đúng thứ nó cần che.
        backgroundColor: '#000000',
        hasShadow: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        closable: false,
        skipTaskbar: true,
        // Nhận focus: xem ghi chú đầu tệp. Đây là khác biệt có chủ đích so với `KeyboardOverlay`.
        focusable: true,
        acceptFirstMouse: true,
        title: LOCK_OVERLAY_TITLE,
        webPreferences: {
          preload: CHROME_PRELOAD,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webviewTag: false,
          spellcheck: false,
          // Panel khóa vẫn phải vẽ đồng hồ mỗi giây. Chromium hạ nhịp một cửa sổ ẩn hoặc bị che; màn
          // hình chờ bị che bởi chính nó thì không, nhưng đặt tường minh để không phụ thuộc suy đoán.
          backgroundThrottling: false,
        },
      });
      window.setMenuBarVisibility(false);
      // Electron đổi title theo `document.title`; rule labwc khớp theo title, nên không chặn thì
      // rule hết khớp và cửa sổ rơi vào rule đại trà `type="normal"` rồi bị ResizeTo 2540x1440.
      window.on('page-title-updated', (event) => event.preventDefault());
      window.setAlwaysOnTop(true, 'screen-saver');
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      window.webContents.on('did-fail-load', (_event, code, description, url) => {
        console.error(`[lock-overlay] không nạp được ${url}: ${code} ${description}`);
      });
      // Trang tự xin giờ đầu tiên qua IPC, nhưng đẩy một lần ở đây để đồng hồ không trống trong
      // khoảng 200 ms đầu — đó đúng là khoảng thời gian người dùng nhìn thấy khi bấm Khóa.
      window.webContents.on('did-finish-load', () => {
        window.webContents.send('ntf:lock-state', { locked: this.desiredVisible });
      });
      void window.loadFile(join(RENDERER_DIR, 'lock', 'index.html'));
      this.window = window;
      return true;
    } catch (error) {
      console.error('[lock-overlay] không dựng được cửa sổ:', (error as Error).message);
      this.window = null;
      return false;
    }
  }

  /**
   * Phủ panel. Idempotent.
   *
   * `show()` chứ không `showInactive()`: xem ghi chú đầu tệp — màn hình chờ phải giữ focus.
   */
  show(): boolean {
    if (!this.create()) return false;
    const window = this.window;
    if (!window || window.isDestroyed()) return false;
    this.desiredVisible = true;
    window.setBounds(this.rectFor());
    if (!window.isVisible()) window.show();
    window.focus();
    window.moveTop();
    window.webContents.send('ntf:lock-state', { locked: true });
    return true;
  }

  hide(): void {
    this.desiredVisible = false;
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    window.webContents.send('ntf:lock-state', { locked: false });
    if (window.isVisible()) window.hide();
  }

  /**
   * Đưa lên trên app ngoài vừa mở.
   *
   * Cần riêng khỏi `show()`: một app ngoài được dock khởi động trong lúc panel đang khóa sẽ map sau
   * màn hình chờ. Trên labwc, `ToggleAlwaysOnTop` chỉ chạy lúc map, nên thứ tự map quyết định ai ở
   * trên — và lớp `screen-saver` của Electron chỉ là gợi ý. Gọi `moveTop()` sau khi app ngoài map
   * xong là cách duy nhất không phụ thuộc thứ tự đó.
   */
  raise(): void {
    const window = this.window;
    if (!window || window.isDestroyed() || !this.desiredVisible) return;
    if (!window.isVisible()) {
      this.show();
      return;
    }
    window.moveTop();
  }

  /**
   * Đổi cỡ theo panel hiện tại. Chỉ áp khi đang hiện: lúc ẩn, `show()` sẽ đặt lại hình học.
   */
  resize(): void {
    const window = this.window;
    if (!window || window.isDestroyed() || !window.isVisible()) return;
    window.setBounds(this.rectFor());
  }

  get isVisible(): boolean {
    return Boolean(this.window && !this.window.isDestroyed() && this.window.isVisible());
  }

  /** Gửi trạng thái khóa xuống trang — dùng khi trang cần biết mà không phải hỏi lại. */
  pushState(locked: boolean): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    window.webContents.send('ntf:lock-state', { locked });
  }

  destroy(): void {
    this.desiredVisible = false;
    const window = this.window;
    this.window = null;
    if (!window || window.isDestroyed()) return;
    try {
      window.hide();
      window.destroy();
    } catch {
      /* đã bị huỷ bởi lượt đóng kiosk */
    }
  }
}
