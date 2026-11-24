/**
 * Bộ điều khiển khóa panel — tầng ③ I/O, ghép ba mảnh rời thành một hành vi.
 *
 * Ba mảnh: `lock-state.ts` quyết định (thuần, kiểm được bằng `node --test`), `idle-watch.ts` đọc
 * evdev, `lock-overlay.ts` vẽ cửa sổ. Tệp này chỉ nối chúng và sở hữu đúng hai thứ mà không mảnh nào
 * sở hữu được: **đồng hồ nhàn rỗi** và **việc đọc lại cấu hình**.
 *
 * Vì sao đồng hồ ở đây chứ không ở `idle-watch`: watcher báo "có thao tác", còn "đã bao lâu rồi" là
 * câu hỏi so với một ngưỡng *thay đổi được lúc chạy* (thẻ cài đặt). Watcher không biết ngưỡng, và
 * không nên biết — nó chỉ là một cái loa báo sự kiện.
 *
 * Vì sao kiểm mỗi giây chứ không hẹn `setTimeout(ngưỡng)`: người dùng đổi ngưỡng từ 30 phút xuống 2
 * phút phải có hiệu lực ngay, và một lần hẹn đã đặt thì không rút lại được mà không phải huỷ-tạo lại.
 * Một phép trừ mỗi giây là giá rẻ nhất cho tính đúng đó.
 */

import { LockOverlay } from './lock-overlay.js';
import { canUnlockAt, decide, INITIAL_LOCK_STATE, type LockState } from './lock-state.js';
import { IdleWatch } from './idle-watch.js';
import { trace } from './trace.js';
import type { Rect } from './layout.js';

/** Milis giữa hai lần so ngưỡng. 1 s: sai số lớn nhất là 1 s trên một ngưỡng tính bằng phút. */
const TICK_MS = 1_000;

export interface LockPanelOptions {
  /** Hình học panel hiện tại — đọc lại mỗi lần hiện, vì panel có thể đã đổi cỡ. */
  rectFor: () => Rect;
  /** Ngưỡng nhàn rỗi hiện hành, milis; `0` là tắt hẳn. */
  timeoutMs: () => number;
  /** `true` khi có media đang phát **và** cấu hình cho phép giữ sáng theo media. */
  keepAwake: () => boolean;
  /** Danh sách nút evdev cần theo dõi. Rỗng thì bộ đếm không chạy được. */
  inputDevices: () => string[];
  /** Gọi mỗi khi trạng thái khóa đổi, để nơi khác (menu Nguồn, dock) vẽ lại. */
  onLockChange?: (locked: boolean) => void;
}

export class LockPanel {
  private readonly overlay: LockOverlay;
  private watch: IdleWatch | null = null;
  private state: LockState = INITIAL_LOCK_STATE;
  /** Mốc thao tác thật gần nhất. `Date.now()` tại lúc khởi tạo = vừa có người, không phải vừa nhàn rỗi. */
  private lastActivityAt = Date.now();
  private ticker: NodeJS.Timeout | null = null;

  constructor(private readonly options: LockPanelOptions) {
    this.overlay = new LockOverlay(options.rectFor);
  }

  get locked(): boolean {
    return this.state.phase === 'locked';
  }

  /** Trạng thái cho IPC. Hình dạng cố định để trang khóa không phải kiểm `undefined`. */
  snapshot(): { locked: boolean } {
    return { locked: this.locked };
  }

  /**
   * Dựng cửa sổ và bật đồng hồ. Idempotent.
   *
   * Trả `false` khi không dựng được cửa sổ — không ném lỗi, vì mất màn hình chờ không phải lý do để
   * panel không lên. Nơi gọi ghi nhật ký rồi chạy tiếp.
   */
  start(): boolean {
    const ready = this.overlay.create();
    if (!ready) trace('[lock] không dựng được cửa sổ màn hình chờ');
    this.restartWatch();
    if (!this.ticker) {
      this.ticker = setInterval(() => this.check(), TICK_MS);
      this.ticker.unref?.();
    }
    return ready;
  }

  /**
   * Đọc lại cấu hình và dựng lại bộ đếm nếu cần.
   *
   * Chỉ `IdleWatch` cần dựng lại, và chỉ khi bật lại từ trạng thái tắt: đóng rồi mở lại fd evdev mỗi
   * lần khách đổi ngưỡng là vô ích và có thể mất một sự kiện trong khe hở.
   */
  refresh(): void {
    if (this.options.timeoutMs() <= 0) {
      this.watch?.stop();
      return;
    }
    if (!this.watch?.running) this.restartWatch();
  }

  /** Khóa theo yêu cầu người dùng (dock, menu Nguồn). Trả về `true` nếu trạng thái đã đổi. */
  lock(): boolean {
    return this.apply({ type: 'lock', at: Date.now() });
  }

  /**
   * Cú chạm trên màn hình chờ xin mở. Trả `true` khi được mở.
   *
   * Trả `false` cho cửa sổ "vừa khóa xong" (`UNLOCK_ARM_MS`) — đó là ngón tay vẫn đang đặt trên kính
   * từ thao tác vừa khóa panel, không phải ý định mở khóa. Trang khóa dựa vào giá trị này để biết có
   * chạy hiệu ứng hay không, nên nó phải là câu trả lời thật chứ không phải "đã nhận yêu cầu".
   */
  requestUnlock(at: number): boolean {
    if (!canUnlockAt(this.state, at)) return false;
    return this.apply({ type: 'unlock', at });
  }

  /** Panel đổi cỡ: theo kịp để màn hình chờ không hở một dải phía sau. */
  resize(): void {
    this.overlay.resize();
  }

  dispose(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.watch?.stop();
    this.watch = null;
    this.overlay.destroy();
  }

  /**
   * Áp một sự kiện và đồng bộ cửa sổ theo trạng thái mới.
   *
   * `decide()` trả **chính object cũ** khi không đổi, nên so sánh tham chiếu là đủ để biết có phải làm
   * gì — không cần một cờ `dirty` riêng để lệch pha với trạng thái thật.
   */
  private apply(event: Parameters<typeof decide>[1]): boolean {
    const next = decide(this.state, event);
    if (next === this.state) return false;
    this.state = next;
    if (next.phase === 'locked') {
      // Dừng bộ đếm khi đã khóa: mọi thao tác lúc này là chạm lên chính màn hình chờ, không phải hoạt
      // động cần đo. Để nó chạy chỉ tốn fd và làm nhiễu chẩn đoán.
      this.watch?.stop();
      const shown = this.overlay.show();
      trace(`[lock] khóa (${event.type}) — overlay=${shown ? 'hiện' : 'LỖI'}`);
    } else {
      this.overlay.hide();
      // Mốc thao tác đặt lại khi mở khóa: nếu không, bộ đếm so với mốc cũ và khóa lại ngay giây sau
      // khi người dùng vừa chạm (cộng thêm ngưỡng là đúng bằng 0 giây còn lại).
      this.lastActivityAt = Date.now();
      this.restartWatch();
      trace(`[lock] mở khóa (${event.type})`);
    }
    this.options.onLockChange?.(next.phase === 'locked');
    return true;
  }

  /**
   * Kiểm mỗi giây: có media đang phát thì coi như có người, hết ngưỡng thì khóa.
   *
   * `keepAwake()` đẩy mốc thao tác về hiện tại thay vì chỉ bỏ qua lần kiểm này. Khác biệt quan trọng:
   * nếu chỉ bỏ qua, một video 2 giờ vẫn để bộ đếm tích đến 2 giờ, và khách tắt video xong thì panel
   * khóa trong tích tắc ngay khi họ đang cầm điều khiển. Đẩy mốc làm đồng hồ bắt đầu lại từ lúc video
   * dừng.
   */
  private check(): void {
    const timeout = this.options.timeoutMs();
    if (timeout <= 0 || this.locked) return;
    if (this.options.keepAwake()) {
      this.lastActivityAt = Date.now();
      return;
    }
    if (Date.now() - this.lastActivityAt < timeout) return;
    this.apply({ type: 'idle', at: Date.now() });
  }

  private restartWatch(): void {
    this.watch?.stop();
    const devices = this.options.inputDevices();
    if (devices.length === 0) {
      trace('[lock] không có nút vào nào đọc được — bộ đếm nhàn rỗi tắt');
      this.watch = null;
      return;
    }
    const watch = new IdleWatch({
      devices,
      onActivity: () => {
        if (this.locked) return;
        this.lastActivityAt = Date.now();
      },
    });
    if (!watch.start()) {
      trace('[lock] bộ đếm nhàn rỗi không mở được nút nào');
      this.watch = null;
      return;
    }
    this.watch = watch;
    trace(`[lock] bộ đếm nhàn rỗi theo dõi ${watch.deviceCount} nút`);
  }
}
