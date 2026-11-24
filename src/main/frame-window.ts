import { BrowserWindow } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FramePart, Rect } from './layout.js';

/**
 * Bộ cửa sổ vẽ khung băng nội dung — bốn dải viền bo góc, bốn ô mặt nạ ở bốn góc, và một nút ✕ thật.
 *
 * Vì sao là *cửa sổ riêng* chứ không phải một WebContentsView của kiosk: app ngoài (Firefox,
 * Chromium, FreeTube) là client riêng của compositor, vẽ trên surface của chính nó. Một view nằm
 * trong cửa sổ kiosk luôn ở *dưới* app ngoài — kiosk bị `ToggleAlwaysOnBottom` ghim xuống đáy. Chỉ
 * một cửa sổ `alwaysOnTop` mới nằm trên được, nên khung và nút ✕ buộc phải là cửa sổ.
 *
 * Vì sao nút ✕ là cửa sổ thật thay vì để app tự đóng: app treo thì nút của nó cũng treo. Cửa sổ này
 * phủ đúng vùng chạm của ✕ (đo trên panel: cols 2504–2549 × rows 54–97), nên người dùng chạm "nút
 * ✕ của Firefox" nhưng thực chất trúng nút của ta, và ta đóng app ngoài qua kênh `chrome:close-app` —
 * một handler của main process, không phụ thuộc app còn sống hay không.
 *
 * Hình học đến từ `framePartsFor()` trong layout.ts; tệp này không chứa một số đo nào.
 */

/**
 * Thứ tự tạo chín cửa sổ.
 *
 * Cửa sổ tạo sau nằm trên cửa sổ tạo trước, và hai mươi sáu nhân hai mươi sáu pixel ở mỗi góc là
 * nơi hai mảnh gặp nhau, nên thứ tự này là hình học chứ không phải thẩm mỹ:
 *
 * 1. Bốn ô mặt nạ đi **trước**. Ô mặt nạ đục phần hình nằm ngoài cung r=24, mà cung bị hai dải
 *    ngang 2 px bóp dẹt đúng tại góc — phần đục đó chồng lên hai hàng đầu của dải. Đặt dải sau là
 *    cách duy nhất để nét vòng còn nguyên; đảo lại thì ô vuông hình nền ăn mất hai hàng ấy và góc
 *    trông như bị cắt cụt.
 * 2. Bốn dải vòng ở giữa, để nét vòng là lớp sơn trên cùng ở mọi pixel nó có mặt.
 * 3. `close` **cuối cùng**: ô mặt nạ góc trên-phải chồng lên nửa trái của nút ✕, nên nút phải được
 *    tạo sau cùng mới bấm được mà không phải raise thủ công mỗi lần.
 */
const PART_ORDER: readonly FramePart[] = [
  'corner-tl',
  'corner-tr',
  'corner-bl',
  'corner-br',
  'top',
  'bottom',
  'left',
  'right',
  'close',
];

const RENDERER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'renderer');
const CHROME_PRELOAD = join(dirname(fileURLToPath(import.meta.url)), 'preload-chrome.cjs');

interface PartWindow {
  part: FramePart;
  window: BrowserWindow;
}

export class FrameWindows {
  private parts: PartWindow[] = [];
  private ready = false;
  /**
   * Cờ hiển thị mong muốn gần nhất — NTF-R01.
   *
   * Phải nhớ chứ không suy ra từ `window.isVisible()`: lúc khởi động chín cửa sổ còn đang nạp, nên
   * `isVisible()` trả `false` cho tất cả và lần `setVisible(true)` đầu tiên sẽ là no-op nếu so với
   * trạng thái thật. Ghi nhớ ở đây cũng cho phép `create()` áp cờ ngay sau khi dựng xong, thay vì
   * phải chờ một lần gọi từ bên ngoài.
   */
  private visible = false;
  /**
   * Bản sao cuối của mỗi kênh đã phát.
   *
   * Một mảnh khung có thể nạp xong *sau* lần phát đầu tiên (chín cửa sổ nạp song song lúc khởi
   * động), và `webContents.send` cho một trang chưa nạp xong thì mất hút. Giữ lại bản cuối và phát
   * lại ở `did-finish-load` là cách duy nhất để mảnh nạp chậm vẫn nhận được hình nền đúng.
   */
  private lastMessage = new Map<string, unknown>();

  constructor(private readonly parent: BrowserWindow) {}

  /**
   * Dựng đủ chín cửa sổ và nạp `dist/renderer/frame/index.html?part=…`.
   *
   * Kích thước ban đầu phải truyền ngay vào constructor, không đặt sau bằng `setBounds`: cửa sổ
   * `resizable: false` khai báo min == max cho compositor, và labwc phân loại một xdg_toplevel có
   * kích thước cố định là `type="dialog"`. Đó chính là thứ giữ chín cửa sổ này ra khỏi rule đại trà
   * `type="normal"` trong gen-labwc-config.sh — nếu chúng bị rule đó khớp, mỗi mảnh sẽ bị ResizeTo
   * thành 2540×1440 và nút ✕ phủ kín cả băng, ăn mọi cú chạm.
   *
   * `show: false` rồi `showInactive()`: một cửa sổ always-on-top hiện lên bằng `show()` sẽ cướp
   * focus khỏi trang đang xem, và trên panel cảm ứng điều đó nghĩa là bàn phím ảo của app ngoài bị
   * đóng ngay khi khung vừa vẽ xong. `showInactive` không lấy focus.
   */
  create(rects: Record<FramePart, Rect>): void {
    if (this.parts.length > 0) return;
    for (const part of PART_ORDER) {
      const rect = rects[part];
      const window = new BrowserWindow({
        ...rect,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        closable: false,
        skipTaskbar: true,
        // Không nhận focus: nếu nhận, cửa sổ này thành cửa sổ "đang hoạt động" và app ngoài mất
        // focus, kéo theo việc đóng bàn phím ảo và dừng phát video.
        focusable: false,
        acceptFirstMouse: true,
        title: `NTF frame ${part}`,
        webPreferences: {
          // Dùng lại đúng preload của thanh trên: nút ✕ cần `chrome:close-apps`, và bốn ô mặt nạ
          // góc cần `chrome:settings`. Preload này không require tương đối nên nạp được cho cả
          // chín cửa sổ.
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
      // Tiêu đề phải đứng yên: rule `title="NTF frame *"` trong gen-labwc-config.sh là thứ duy nhất
      // giữ chín cửa sổ này ra khỏi rule đại trà. Electron tự đổi tiêu đề cửa sổ theo
      // `document.title` của trang vừa nạp, nên không chặn thì renderer của khung — bất kể nó đặt
      // tiêu đề gì — sẽ làm rule hết khớp và các mảnh bị ResizeTo thành cả băng.
      window.on('page-title-updated', (event) => event.preventDefault());
      // 'screen-saver' là mức cao nhất Electron cho phép: app ngoài ở layer `normal`, nên chỉ cần
      // trên nó một bậc là đủ, nhưng mức cao nhất tránh việc chính app ngoài tự bật alwaysOnTop.
      window.setAlwaysOnTop(true, 'screen-saver');
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      if (part !== 'close') {
        // Bốn dải chỉ dày 2 px và bốn ô mặt nạ chỉ 26x26. Nếu compositor không xuyên được chạm thì
        // vùng chết chỉ vài chục pixel — chấp nhận được, trong khi một dải chặn chạm sẽ ăn mất mép
        // nội dung của app. Ô góc trên-phải bắt buộc phải xuyên: nó chồng lên nửa trái của nút ✕.
        window.setIgnoreMouseEvents(true);
      }
      window.webContents.on('did-fail-load', (_event, code, description, url) => {
        console.error(`[frame:${part}] không nạp được ${url}: ${code} ${description}`);
      });
      // Phát lại bản cuối của mọi kênh: một mảnh có thể đã bỏ lỡ lần phát trước khi nó nạp xong.
      window.webContents.on('did-finish-load', () => {
        for (const [channel, payload] of this.lastMessage) {
          if (!window.isDestroyed()) window.webContents.send(channel, payload);
        }
      });
      void window.loadFile(join(RENDERER_DIR, 'frame', 'index.html'), { query: { part } });
      this.parts.push({ part, window });
    }
    this.ready = true;
    // Cờ có thể đã được đặt trước khi dựng xong (nội dung nạp nhanh hơn khung), nên áp lại ngay.
    this.applyVisibility();
  }

  /**
   * Đặt lại hình học cho cả chín mảnh. Gọi từ `relayout()` nên panel đổi kích thước thì khung đi
   * theo. Rect `close` phải phủ trọn vùng chạm thật của ✕ app ngoài; cắt bớt một vài pixel là app
   * nhận lại cú chạm và nút của ta thành vô dụng đúng lúc cần nhất.
   */
  apply(rects: Record<FramePart, Rect>): void {
    if (!this.ready) return;
    for (const { part, window } of this.parts) {
      if (window.isDestroyed()) continue;
      window.setBounds(rects[part]);
    }
  }

  /**
   * Hiện/ẩn cả bộ.
   *
   * NTF-R01: khung phải có mặt **ngay khi băng nội dung có nội dung**, không chờ vòng poll 2 giây.
   * Báo cáo QA đo khung hiện sau 0.51 s ở ca nhanh nhất và 4.11 s ở ca chậm — trong khoảng đó băng
   * nội dung là một hình vuông nhọn, lệch hẳn với bốn góc đã bo. Vì vậy cờ này do *nội dung* điều
   * khiển (qua `onContentShown`/`onContentHidden` của `ViewManager`), và app ngoài chỉ cộng thêm vào
   * chứ không phải điều kiện duy nhất.
   *
   * Vẫn giữ nguyên ý định cũ: nút ✕ nằm đè lên góc trên phải của băng, nên khi không có gì để đóng và
   * không có nội dung nào cần bo góc thì cả bộ phải ẩn.
   */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.applyVisibility();
  }

  /** Áp `this.visible` xuống chín cửa sổ; tách ra để `create()` gọi lại được mà không lật cờ. */
  private applyVisibility(): void {
    for (const { window } of this.parts) {
      if (window.isDestroyed()) continue;
      if (this.visible) {
        if (!window.isVisible()) window.showInactive();
      } else if (window.isVisible()) {
        window.hide();
      }
    }
  }

  /** Trạng thái mong muốn gần nhất; `main.ts` hợp nhất hai nguồn (nội dung + app ngoài) trước khi gọi. */
  get isVisible(): boolean {
    return this.visible;
  }

  /**
   * Đưa khung lên trên app ngoài vừa mở.
   *
   * Trên labwc, một cửa sổ mới map sẽ được đặt lên trên theo thứ tự map, bất kể layer — nên app
   * ngoài vừa mở có thể phủ mất khung cho tới khi có ai đó raise lại. Gọi hàm này mỗi khi danh sách
   * app ngoài thay đổi là đủ, vì đó là những lúc duy nhất một surface mới xuất hiện.
   */
  raise(): void {
    for (const { window } of this.parts) {
      if (window.isDestroyed() || !window.isVisible()) continue;
      window.moveTop();
    }
  }

  /**
   * Gửi một payload tới cả chín mảnh và ghi nhớ nó để phát lại cho mảnh nạp muộn.
   *
   * Một phương thức duy nhất thay vì để nơi gọi tự vòng qua từng cửa sổ: thứ tự tạo (và do đó thứ tự
   * chồng) là chi tiết riêng của lớp này, và `pushSettings()` trong main.ts không nên biết tới nó.
   */
  broadcast(channel: string, payload: unknown): void {
    this.lastMessage.set(channel, payload);
    for (const { window } of this.parts) {
      if (window.isDestroyed()) continue;
      window.webContents.send(channel, payload);
    }
  }

  destroy(): void {
    this.ready = false;
    this.visible = false;
    this.lastMessage.clear();
    for (const { window } of this.parts) {
      if (!window.isDestroyed()) window.destroy();
    }
    this.parts = [];
  }

  /** Chỉ dùng cho chẩn đoán: `main.ts` không đọc giá trị này. */
  get count(): number {
    return this.parts.length;
  }

  /** Cửa sổ cha, để nơi gọi không phải giữ hai tham chiếu. */
  get owner(): BrowserWindow {
    return this.parent;
  }
}
