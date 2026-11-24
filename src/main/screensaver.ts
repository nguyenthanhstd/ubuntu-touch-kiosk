/**
 * Màn hình chờ của panel: hình học, đồng hồ nhàn rỗi, và vòng đời cửa sổ phủ.
 *
 * Vì sao là một lớp riêng: `main.ts` đã chạm trần nợ 720 dòng từ trước tính năng này, và bốn thứ ở
 * đây — hình học toàn panel, phép đo "có media đang phát", đường khóa, và việc đọc nút evdev — không
 * cần biết gì về dock, thanh trên hay `ViewManager` ngoài đúng những gì `ScreensaverDeps` khai báo.
 *
 * Vì sao không phải `lock-panel.ts`: tệp đó là bộ điều khiển trạng thái (thuần hành vi khóa/mở), còn
 * tệp này trả lời ba câu hỏi chỉ main process biết — panel rộng bao nhiêu, ai đang phát media, và ẩn
 * thẻ nào trước khi khóa.
 */

import { readFileSync } from 'node:fs';
import type { WebContents } from 'electron';
import { LockPanel } from './lock-panel.js';
import { parseInputDevices } from './input-devices.js';
import { trace } from './trace.js';
import type { Rect } from './layout.js';

/** Ước lượng an toàn khi cửa sổ kiosk chưa kịp đo: panel mặc định của dự án. */
const FALLBACK_PANEL = { width: 2560, height: 1600 };

/** Những gì tệp này cần từ main process. */
export interface ScreensaverDeps {
  /** Kích thước panel thật; `null` khi cửa sổ kiosk chưa dựng xong. */
  panelSize(): { width: number; height: number } | null;
  /** Ngưỡng nhàn rỗi hiện hành, milis; `0` là tắt hẳn. */
  timeoutMs(): number;
  /** Cấu hình của người quản trị: có cho media giữ panel sáng không. */
  keepAwakeOnMedia(): boolean;
  /** WebContents đang hiện trong băng nội dung; `null` ở Home. */
  activeContents(): WebContents | null;
  /** Ẩn ba thẻ nổi — phải chạy **trước** khi khóa, xem `lock()`. */
  hidePanels(): void;
}

export class Screensaver {
  private panel: LockPanel | null = null;

  constructor(private readonly deps: ScreensaverDeps) {}

  get locked(): boolean {
    return this.panel?.locked ?? false;
  }

  /**
   * Dựng cửa sổ phủ và bật đồng hồ nhàn rỗi. Idempotent, không ném lỗi.
   *
   * Đọc nút vào ở đây chứ không ở đầu `bootstrap()`: `openSync('/dev/input/eventN')` cần quyền đọc
   * `/dev/input`, và trên panel QA quyền đó đến từ nhóm `input` của chính tiến trình — đã có sẵn từ
   * lúc exec, nên đọc sớm hay muộn không khác nhau; đọc muộn giữ phần khởi động nhanh.
   */
  start(): void {
    if (this.panel) return;
    const nodes = this.readInputNodes();
    this.panel = new LockPanel({
      rectFor: () => this.rect(),
      timeoutMs: this.deps.timeoutMs,
      keepAwake: () => this.mediaIsPlaying(),
      inputDevices: () => nodes,
    });
    this.panel.start();
  }

  /**
   * Đưa panel vào màn hình chờ — nút Khóa ở dock, menu Nguồn và IPC.
   *
   * Không chạm vào `ViewManager`: không điều hướng, không đóng bàn phím, không dừng media. Một cú chạm
   * nhầm vào nút Khóa phải trả lại đúng trang đang xem sau khi mở khóa — và dừng video của khách vì họ
   * lỡ chạm là hành vi không sửa lại được.
   */
  lock(): void {
    // Ẩn thẻ trước: thẻ đặt `AlwaysOnTop('screen-saver')`, màn hình chờ cũng vậy, và hai cửa sổ cùng
    // mức thì cửa sổ map sau thắng — thẻ đang mở sẽ nằm trên và lộ đúng nội dung vừa bị khóa.
    this.deps.hidePanels();
    if (!this.panel) {
      trace('[lock] yêu cầu khóa nhưng màn hình chờ chưa sẵn sàng');
      return;
    }
    this.panel.lock();
  }

  /** Cú chạm trên chính màn hình chờ xin mở khóa. `false` = bị chặn hoặc chưa khóa. */
  requestUnlock(at: number): boolean {
    return this.panel?.requestUnlock(at) ?? false;
  }

  /** Chính sách nhàn rỗi vừa đổi: dựng lại bộ đếm nếu cần. */
  refresh(): void {
    this.panel?.refresh();
  }

  /** Panel đổi cỡ: theo kịp để màn hình chờ không hở một dải phía sau. */
  resize(): void {
    this.panel?.resize();
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = null;
  }

  /**
   * Hình học của màn hình chờ: **toàn bộ** panel, không phải phần băng nội dung.
   *
   * Cố tình không dùng `layoutFor().content`: băng nội dung chừa chỗ cho thanh trên và dock, còn màn
   * hình chờ phải che cả hai — để lộ một dải dock sáng ở dưới là để lộ đúng thứ đang bị khóa.
   */
  private rect(): Rect {
    const panel = this.deps.panelSize() ?? FALLBACK_PANEL;
    return { x: 0, y: 0, width: panel.width, height: panel.height };
  }

  /**
   * Có media đang thật sự phát trong băng nội dung không.
   *
   * `isCurrentlyAudible()` là câu trả lời Chromium đưa ra cho chính câu hỏi này, và nó đúng cho cả
   * `<video>` của YouTube lẫn audio của một trang tin — không cần tự dò thẻ. `activeContents()` là
   * `null` ở Home, nên Home không bao giờ tính là "đang phát".
   *
   * Chỉ **nghe** là media, không tính video tắt tiếng: một video tắt tiếng vẫn có người nhìn, nhưng nó
   * cũng đúng là thứ dễ bị bỏ quên nhất — và cấu hình `keepAwakeOnMedia` là lựa chọn của người quản
   * trị, nên nó phải dễ hiểu: có tiếng thì giữ sáng.
   */
  private mediaIsPlaying(): boolean {
    if (!this.deps.keepAwakeOnMedia()) return false;
    const contents = this.deps.activeContents();
    if (!contents || contents.isDestroyed()) return false;
    return contents.isCurrentlyAudible();
  }

  /**
   * Nút vào cần theo dõi, đọc **một lần** lúc khởi động.
   *
   * `/proc/bus/input/devices` chỉ đổi khi cắm thêm thiết bị, và một panel kiosk treo tường thì không ai
   * cắm. Đọc lại mỗi giây sẽ là 1 lần mở tệp + 1 lần parse cho một kết quả không bao giờ khác.
   */
  private readInputNodes(): string[] {
    try {
      return parseInputDevices(readFileSync('/proc/bus/input/devices', 'utf8')).map((d) => d.node);
    } catch (error) {
      trace(`[lock] không đọc được /proc/bus/input/devices: ${(error as Error).message}`);
      return [];
    }
  }
}
