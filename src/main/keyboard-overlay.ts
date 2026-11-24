import { BrowserWindow } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeLabwcGeometry } from './labwc-remap.js';
import type { Rect } from './layout.js';

/**
 * Cửa sổ bàn phím nổi **trên app ngoài** — lớp hiển thị cho NTF-R08.
 *
 * Vì sao phải là cửa sổ chứ không phải `WebContentsView`: bàn phím là view con của cửa sổ kiosk, mà
 * kiosk bị `gen-labwc-config.sh` ghim `ToggleAlwaysOnBottom`. Mọi app ngoài (Firefox, FreeTube) là
 * client `normal` riêng của compositor và vẽ trên surface của chính nó, nên một view con của kiosk
 * **luôn** nằm dưới. Báo cáo 07 đo đúng như vậy: Firefox che kín popup (R05 FAIL).
 *
 * Cơ chế đã được đo là nằm trên app ngoài trên chính máy này là *cửa sổ `alwaysOnTop` riêng* — đó là
 * cách chín mảnh khung và nút ✕ hoạt động. Tệp này dùng lại đúng cơ chế đó cho popup bàn phím, nên
 * không cần một lớp overlay Wayland tự viết và không cần cài wvkbd (bản apt của Ubuntu 26.04 là 0.15,
 * không phải 0.21; và ta chỉ cần *hiện bàn phím của mình ở trên*, không cần bàn phím vẽ bằng Wayland).
 *
 * Cùng bốn ràng buộc của `FrameWindows` và vì cùng lý do:
 *
 * 1. `title` cố định, và `page-title-updated` bị chặn — rule `title="NTF keyboard"` trong
 *    gen-labwc-config.sh là thứ duy nhất giữ cửa sổ này ra khỏi rule đại trà `type="normal"`;
 *    Electron đổi title theo `document.title` của trang vừa nạp nên không chặn thì rule hết khớp và
 *    popup bị ResizeTo 2540x1440.
 * 2. `resizable: false` ⇒ xdg_toplevel kích thước cố định ⇒ labwc xếp `type="dialog"`, cũng ra khỏi
 *    rule đại trà.
 * 3. `showInactive()` chứ không `show()`: nhận focus sẽ kéo focus khỏi app ngoài, và trên panel đó
 *    nghĩa là video dừng / caret của ô nhập đóng lại.
 * 4. Cửa sổ này **không** `setIgnoreMouseEvents` — nó phải nhận chạm, vì đó là toàn bộ mục đích.
 */

const RENDERER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'renderer');
const CHROME_PRELOAD = join(dirname(fileURLToPath(import.meta.url)), 'preload-chrome.cjs');

/** Khoá so sánh hình học; trùng với cách `writeLabwcGeometry` làm tròn toạ độ. */
function overlayKey(rect: Rect): string {
  return `${Math.round(rect.x)} ${Math.round(rect.y)} ${Math.round(rect.width)} ${Math.round(rect.height)}`;
}

/** `app_id`/`title` mà labwc dùng để nhận ra cửa sổ này; khớp rule trong gen-labwc-config.sh. */
export const KEYBOARD_OVERLAY_TITLE = 'NTF keyboard';

export class KeyboardOverlay {
  private window: BrowserWindow | null = null;
  private desiredVisible = false;
  private lastRect: Rect | null = null;

  constructor(
    private readonly parent: BrowserWindow,
    /** Hình học mong muốn, tính lại mỗi lần hiện/đổi cỡ để đi theo layout và bề ngang panel. */
    private readonly rectFor: () => Rect | null,
  ) {}

  /**
   * Dựng cửa sổ overlay (một lần) và nạp trang bàn phím.
   *
   * Trả `false` khi không dựng được, và nơi gọi rơi về popup view con cũ — chế độ suy giảm đó vẫn
   * dùng được cho trang nội bộ kiosk, chỉ không nằm trên app ngoài.
   */
  create(): boolean {
    if (this.window && !this.window.isDestroyed()) return true;
    const rect = this.rectFor();
    if (!rect) return false;
    try {
      const window = new BrowserWindow({
        ...rect,
        show: false,
        frame: false,
        // Transparent, with a fully transparent `backgroundColor` — the fix for the four dark corner
        // pixels that made the popup look like a box screwed onto the screen. The card inside the
        // page has a 24 px radius; the window's own background used to paint `#12100C` behind those
        // corners, so the arc showed four opaque notches of chrome colour on top of whatever app the
        // visitor was typing into. Measured: sampling 1 px inside the arc at (1451,1223),
        // (2548,1223), (1451,1480), (2548,1480) returned exactly `#12100C`. `frame-window.ts`
        // already uses this same pair for the nine frame pieces, so it is a proven configuration
        // under Cage rather than a new one.
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        closable: false,
        skipTaskbar: true,
        // Nhận focus là mất đích: app ngoài sẽ nhả focus và phím đi qua virtual keyboard không còn
        // chỗ đến. Bàn phím ảo không cần focus của compositor để nhận chạm.
        focusable: false,
        acceptFirstMouse: true,
        title: KEYBOARD_OVERLAY_TITLE,
        webPreferences: {
          preload: CHROME_PRELOAD,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webviewTag: false,
          spellcheck: false,
          backgroundThrottling: false,
        },
      });
      window.setMenuBarVisibility(false);
      window.on('page-title-updated', (event) => event.preventDefault());
      window.setAlwaysOnTop(true, 'screen-saver');
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      window.webContents.on('did-fail-load', (_event, code, description, url) => {
        console.error(`[keyboard-overlay] không nạp được ${url}: ${code} ${description}`);
      });
      void window.loadFile(join(RENDERER_DIR, 'keyboard', 'index.html'));
      this.window = window;
      return true;
    } catch (error) {
      console.error('[keyboard-overlay] không dựng được cửa sổ:', (error as Error).message);
      this.window = null;
      return false;
    }
  }

  /** Hiện overlay ở hình học hiện tại. Gọi nhiều lần là idempotent. */
  show(): boolean {
    if (!this.create()) return false;
    const window = this.window;
    if (!window || window.isDestroyed()) return false;
    const rect = this.rectFor();
    if (rect) {
      this.lastRect = rect;
      // Cỡ do Electron quyết, và phải đặt trước khi map.
      window.setBounds(rect);
    }
    this.desiredVisible = true;
    // Đĩa đã mang đúng hình học này thì map ngay — không có lý do bắt người dùng chờ 20 ms.
    // Chỉ lần đầu (chưa ghi gì) hoặc khi hình học vừa đổi mới phải đi qua hàng đợi.
    if (!rect || overlayKey(rect) === this.written) {
      this.pending = null;
      this.pendingMap = false;
      if (!window.isVisible()) window.showInactive();
      else window.moveTop();
      if (rect) this.mappedPos = `${Math.round(rect.x)} ${Math.round(rect.y)}`;
      return true;
    }
    this.enqueue(rect, true);
    return true;
  }

  /**
   * Dời overlay tới `rect`, và đặt cỡ trước khi map.
   *
   * Hai nửa của hình học có hai chủ khác nhau, và đó là kết quả đo chứ không phải lựa chọn: `setBounds`
   * **đặt được cỡ** (đang hiện mà xin 389 → 300 thì vùng vẽ co tại chỗ) nhưng **không dời được chỗ**
   * (kéo −240 px thì IPC trả đúng hình học mới còn màn hình không đổi). Nên `setBounds` ở đây chỉ để
   * lo cỡ; chỗ đi qua `writeLabwcGeometry` rồi map lại.
   *
   * Khi đang ẩn thì chỉ ghi xuống đĩa: `show()` kế tiếp sẽ map đúng ngay lần đầu, không nháy.
   */
  remap(rect: Rect): void {
    this.lastRect = rect;
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    window.setBounds(rect);
    this.enqueue(rect, this.desiredVisible && window.isVisible());
  }

  /** Hình học đang chắc chắn nằm trên đĩa, để bỏ những lần ghi trùng. */
  private written: string | null = null;
  /** Góc trên-trái của lần map gần nhất; đổi cỡ không đụng tới nó, nên không cần remap. */
  private mappedPos: string | null = null;
  private pending: Rect | null = null;
  private pendingMap = false;
  private draining = false;

  private enqueue(rect: Rect, map: boolean): void {
    this.pending = rect;
    this.pendingMap = this.pendingMap || map;
    if (!this.draining) void this.drain();
  }

  /**
   * Hàng đợi *latest-wins*: một cú kéo ở nhịp 30 ms sinh ra ~30 yêu cầu, mỗi yêu cầu tốn 20 ms, nên
   * xếp hàng tất cả sẽ trễ hàng giây. Chỉ hình học **mới nhất** được ghi và map sau khi lần đang chạy
   * xong, và mỗi vòng chỉ map nhiều nhất một lần.
   *
   * Cú `hide()` + `showInactive()` dưới đây **là** hiện tượng nháy mà QA09-01/02 báo, và nó không thể
   * bỏ: trên Wayland chỉ lần map lại mới khiến labwc đọc `MoveTo`, tức là chỉ nó mới *dời* được cửa
   * sổ. Nhưng nó chỉ cần thiết khi **chỗ** đổi. `setBounds` đã đặt cỡ ngay tại chỗ, nên một cú đổi
   * chiều cao (grip, đổi scale) mà góc trên-trái giữ nguyên thì không phải map lại — và đó chính là
   * nửa số lần nháy trước đây không có lý do gì phải xảy ra.
   */
  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.pending) {
        const rect = this.pending;
        const map = this.pendingMap;
        this.pending = null;
        this.pendingMap = false;
        const key = overlayKey(rect);
        if (key !== this.written) {
          if (await writeLabwcGeometry(rect)) this.written = key;
        }
        const live = this.window;
        if (!live || live.isDestroyed()) return;
        if (!map) continue;
        // Trong lúc chờ đã có hình học mới: gộp vào vòng sau thay vì map một vị trí đã lỗi thời.
        if (this.pending) {
          this.pendingMap = true;
          continue;
        }
        if (!this.desiredVisible) continue;
        const pos = `${Math.round(rect.x)} ${Math.round(rect.y)}`;
        // Chỉ đổi cỡ: `setBounds` đã lo xong, map lại chỉ tạo một khung hình nháy.
        if (pos === this.mappedPos && live.isVisible()) continue;
        // Map lại: đây là lần duy nhất labwc chịu đọc `MoveTo` cho cửa sổ này.
        live.hide();
        live.showInactive();
        live.moveTop();
        this.mappedPos = pos;
      }
    } finally {
      this.draining = false;
    }
  }

  hide(): void {
    this.desiredVisible = false;
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    if (window.isVisible()) window.hide();
  }

  /** Đưa lên trên app ngoài vừa mở — cùng lý do với `FrameWindows.raise()`. */
  raise(): void {
    const window = this.window;
    if (!window || window.isDestroyed() || !this.desiredVisible) return;
    // Đang ẩn mà hiện lại thì phải đi qua `show()`: chỉ nó mới đảm bảo đĩa mang đúng hình học
    // trước khi cửa sổ được map, nếu không popup hiện ra ở chỗ labwc tự xếp.
    if (!window.isVisible()) {
      this.show();
      return;
    }
    window.moveTop();
  }

  get isVisible(): boolean {
    return Boolean(this.window && !this.window.isDestroyed() && this.window.isVisible());
  }

  get rect(): Rect | null {
    return this.lastRect;
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
