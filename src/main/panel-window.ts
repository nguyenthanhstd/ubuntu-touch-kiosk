import { BrowserWindow } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PanelId } from '../shared/ipc.js';

/**
 * Cửa sổ nổi dùng chung cho bốn thẻ: Cài đặt, Âm lượng, Cỡ chữ, Nguồn.
 *
 * Vì sao là cửa sổ riêng chứ không phải `WebContentsView`: kiosk bị `gen-labwc-config.sh` ghim
 * `ToggleAlwaysOnBottom`, nên mọi view con của nó **luôn** nằm dưới mọi app ngoài. Đó chính là lý do
 * R05 của báo cáo QA thất bại với popup bàn phím, và cũng là lý do popup âm lượng hiện tại chỉ mở
 * được sang ngang trong lòng thanh trên 44 px — nó bị chính *view* cắt, không phải bị CSS cắt.
 *
 * Vì sao không dùng `LockOverlay`: khác nhau đúng ba điểm có chủ đích, và cả ba đều là thứ một cái
 * thẻ không được có.
 *
 * 1. **Trong suốt.** Thẻ là một tấm kính bo góc nổi trên nội dung, nên cửa sổ phải trong suốt —
 *    cặp `transparent:true` + `backgroundColor:'#00000000'` là cấu hình đã đo là chạy trên panel này
 *    (`keyboard-overlay.ts` đang dùng), không phải suy đoán. Góc bo của thẻ sẽ lộ bốn điểm đen nếu
 *    cửa sổ vẽ nền đặc phía sau.
 * 2. **Không phủ kín panel.** Kích thước là hằng số nhỏ, đặt giữa (hoặc giữa-trên) bởi rule labwc.
 * 3. **Đóng được.** `Esc`, nút ✕ trong trang, hoặc chạm ra ngoài đều gọi `close()`; cửa sổ chỉ bị
 *    `hide()` chứ không `destroy()` — nạp lại trang mỗi lần mở sẽ làm thẻ nháy trắng đúng lúc người
 *    dùng vừa chạm.
 *
 * Điều KHÔNG khác: vẫn phải `focusable:true` và vẫn phải giữ focus. Bàn phím ảo cố tình không nhận
 * focus vì nhận là mất đích gõ; thẻ thì ngược lại — nó là bàn phím số của chính nó (mã PIN), nên
 * phím cứng và chạm phải rơi vào trang của thẻ.
 */

const RENDERER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'renderer');
const CHROME_PRELOAD = join(dirname(fileURLToPath(import.meta.url)), 'preload-chrome.cjs');

export interface PanelSpec {
  /**
   * Title cố định, khớp rule `<windowRule title="...">` trong `gen-labwc-config.sh`.
   *
   * Đây là **hợp đồng** giữa hai tệp: labwc khớp theo title, và Electron ghi đè title bằng
   * `document.title` ngay khi trang nạp xong. Đổi chuỗi này mà quên đổi bên kia thì cửa sổ rơi vào
   * rule đại trà `type="normal"` và bị `ResizeTo` về kích thước band — thẻ sẽ phủ gần hết panel.
   */
  title: string;
  /** Thư mục dưới `dist/renderer/`. */
  folder: string;
  width: number;
  height: number;
}

/**
 * Bốn thẻ, khai báo một chỗ để `main.ts` và script labwc cùng đọc được một nguồn số.
 *
 * `satisfies Record<PanelId, PanelSpec>` ràng buộc **hai chiều**: thiếu một tên trong `PanelId` thì
 * `ipc-chrome.ts` có một kênh không có cửa sổ, và thừa một tên thì đây là lỗi biên dịch.
 */
export const PANEL_SPECS = {
  settings: { title: 'NTF settings', folder: 'settings', width: 1020, height: 800 },
  volume: { title: 'NTF volume', folder: 'volume-panel', width: 760, height: 430 },
  zoom: { title: 'NTF zoom', folder: 'zoom-panel', width: 760, height: 470 },
  power: { title: 'NTF power', folder: 'power', width: 880, height: 620 },
} as const satisfies Record<PanelId, PanelSpec>;

export type { PanelId };

export class PanelWindow {
  private window: BrowserWindow | null = null;
  private desiredVisible = false;

  constructor(private readonly spec: PanelSpec) {}

  get isVisible(): boolean {
    return Boolean(this.window && !this.window.isDestroyed() && this.window.isVisible());
  }

  /** Dựng cửa sổ (một lần, ẩn) và nạp trang. Trả `false` khi không dựng được. */
  create(): boolean {
    if (this.window && !this.window.isDestroyed()) return true;
    try {
      const window = new BrowserWindow({
        width: this.spec.width,
        height: this.spec.height,
        show: false,
        frame: false,
        // Xem ghi chú đầu tệp: cặp này đã được đo trên chính panel này ở `keyboard-overlay.ts`.
        transparent: true,
        backgroundColor: '#00000000',
        // Bóng đổ để thẻ trông nổi. Trên Wayland đây là bóng phía client, không phải decoration của
        // compositor, nên nó không kéo theo titlebar.
        hasShadow: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        // `closable:false` — cùng lý do với màn hình chờ: được đóng bằng nút trong trang, không ai
        // được đóng nó bằng cử chỉ hệ thống rồi để lại một cửa sổ chết trong danh sách.
        closable: false,
        skipTaskbar: true,
        focusable: true,
        acceptFirstMouse: true,
        title: this.spec.title,
        webPreferences: {
          preload: CHROME_PRELOAD,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webviewTag: false,
          spellcheck: false,
          // Cửa sổ ẩn bị Chromium hạ nhịp vẽ; thanh trượt âm lượng cần khung hình đều trong lúc kéo.
          backgroundThrottling: false,
        },
      });
      window.setMenuBarVisibility(false);
      // Rule labwc khớp theo title; Electron đổi title theo `document.title` ngay sau khi nạp. Không
      // chặn thì rule hết khớp và cửa sổ rơi vào rule đại trà `type="normal"`.
      window.on('page-title-updated', (event) => event.preventDefault());
      window.setAlwaysOnTop(true, 'screen-saver');
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      window.webContents.on('did-fail-load', (_event, code, description, url) => {
        console.error(`[panel:${this.spec.folder}] không nạp được ${url}: ${code} ${description}`);
      });
      // Đóng khi cửa sổ mất focus: chạm ra ngoài thẻ là ý định rõ ràng, và không có lớp phủ bắt chạm
      // nào bên dưới để tự phát hiện điều đó. Màn hình chờ thì KHÔNG làm vậy — nó phải giữ focus.
      window.on('blur', () => {
        if (this.desiredVisible) this.hide();
      });
      void window.loadFile(join(RENDERER_DIR, this.spec.folder, 'index.html'));
      this.window = window;
      return true;
    } catch (error) {
      console.error(`[panel:${this.spec.folder}] không dựng được cửa sổ:`, (error as Error).message);
      this.window = null;
      return false;
    }
  }

  /** Hiện thẻ. Idempotent — gọi khi đang hiện chỉ đưa lên trên. */
  show(): boolean {
    if (!this.create()) return false;
    const window = this.window;
    if (!window || window.isDestroyed()) return false;
    this.desiredVisible = true;
    // `setBounds` chỉ đổi **cỡ** trên Wayland, không đổi vị trí; vị trí do rule `MoveTo` quyết định.
    // Gọi ở đây để cỡ luôn khớp `spec` dù rule có bị sửa tay.
    window.setBounds({ width: this.spec.width, height: this.spec.height });
    if (!window.isVisible()) window.show();
    window.focus();
    window.moveTop();
    return true;
  }

  hide(): void {
    this.desiredVisible = false;
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    if (window.isVisible()) window.hide();
  }

  toggle(): void {
    if (this.isVisible) this.hide();
    else this.show();
  }

  /** Gửi một sự kiện xuống trang, ví dụ yêu cầu vẽ lại giá trị âm lượng thật. */
  send(channel: string, payload?: unknown): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    window.webContents.send(channel, payload);
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
