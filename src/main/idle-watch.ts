/**
 * Bộ đếm nhàn rỗi đọc từ evdev — tầng ③ I/O, không quyết định gì.
 *
 * Vì sao không dùng ba cách hiển nhiên hơn, mỗi cách đã kiểm trên chính panel này:
 *
 * 1. `powerMonitor.getSystemIdleTime()` — Electron chỉ cài đặt nó cho X11, Windows và macOS. Trên
 *    Wayland/headless nó trả 0 vĩnh viễn, tức là panel sẽ khóa ngay giây đầu.
 * 2. `ext_idle_notifier_v1` của Wayland — đúng chuẩn, nhưng Electron không mở được protocol tuỳ biến;
 *    phải viết một helper C và cài thêm gói. Không đáng cho một bộ đếm.
 * 3. `input-event` của main process — CLAUDE.md đã ghi rõ nó **không bao giờ** thấy chạm trên stack
 *    này. Đó là lý do cử chỉ phải sống trong preload.
 *
 * Còn lại evdev, và nó đọc được ngay: trên panel QA, `groups=…,995(input)` nên user kiosk mở được cả
 * 23 nút `/dev/input/event*` mà không cần root và không cần NNP. Điểm mạnh riêng của cách này là nó
 * thấy chạm **bên trong app ngoài** (FreeTube, Firefox) — thứ mà một listener ở cửa sổ kiosk không
 * bao giờ thấy — nên video đang phát vẫn tính là có người.
 */

import { closeSync, openSync, readSync } from 'node:fs';
import { trace } from './trace.js';

/** `sizeof(struct input_event)` trên x86_64: `timeval` (2×8) + type + code + value (3×2) + đệm 6. */
const INPUT_EVENT_SIZE = 24;

/**
 * `EV_ABS` cũng tính là thao tác, và đây là tín hiệu **chắc nhất** cho màn cảm ứng trên panel này.
 *
 * Đo thật trên `ELAN Touchscreen` (04f3:8512): `B: KEY=400 0 0 0 0 0` — sáu word, chỉ đúng một bit ở
 * word cao nhất, tức mã 170 = `BTN_TOOL_FINGER`. Bitmap `KEY` **không** khai `BTN_TOUCH`. Nếu chỉ đếm
 * `EV_KEY`, bộ đếm phụ thuộc vào việc driver có gửi `BTN_TOOL_FINGER` hay không; còn mỗi gói chạm thì
 * luôn có `ABS_MT_POSITION_*`, nên `EV_ABS` là nguồn không thể thiếu.
 */
const EV_ABS = 0x03;

/** `EV_SYN` chiếm đa số tuyệt đối các gói (mỗi gói kết thúc bằng một `SYN_REPORT`), nên lọc ra. */
const EV_KEY = 0x01;

/**
 * Trạng thái nút: nhấn (1), tự lặp (2), nhả (0). Chỉ `EV_KEY` mới có ba giá trị này, và chỉ hai giá
 * trị đầu mới là thao tác.
 */
const VALUE_PRESS = 1;
const VALUE_REPEAT = 2;

/** Số byte một lần `readSync` — đủ cho ~8 gói, và không bao giờ rơi nửa gói. */
const READ_CHUNK = 192;

export interface IdleWatchOptions {
  /** Danh sách nút `/dev/input/event*` đã lọc bởi nơi gọi (xem `listInputDevices`). */
  devices: string[];
  /** Gọi mỗi khi có thao tác thật. Có thể gọi nhiều lần trong một mili giây. */
  onActivity: () => void;
  /** Milis giữa hai lần đọc; 500 ms là đủ mịn cho một bộ đếm tính bằng phút. */
  pollMs?: number;
}

/**
 * Mở mọi nút đọc được. Nút không mở được thì bỏ qua chứ không làm hỏng cả bộ đếm: một webcam hay
 * headset cắm thêm không phải lý do để màn hình chờ ngừng hoạt động.
 */
function openDevices(devices: string[]): number[] {
  const handles: number[] = [];
  for (const device of devices) {
    try {
      // O_NONBLOCK để `readSync` không treo main process khi không có sự kiện. Node không xuất
      // hằng số này nên dùng đúng giá trị của Linux x86_64 (0o4000).
      handles.push(openSync(device, 0o4000 | 0));
    } catch (error) {
      trace(`[idle] bỏ qua ${device}: ${(error as Error).message}`);
    }
  }
  return handles;
}

/**
 * Đọc hết những gì có trong một nút, trả `true` nếu có ít nhất một sự kiện nhấn.
 *
 * Đọc theo vòng lặp vì một cú chạm sinh ra nhiều sự kiện hơn một lần đọc: `BTN_TOUCH` nhấn, rồi
 * `BTN_TOUCH` nhả, rồi `ABS_MT_POSITION_*` — bỏ phần dư sẽ làm mất chính sự kiện nhấn.
 */
function drain(handle: number, buffer: Buffer): boolean {
  let activity = false;
  for (;;) {
    let read = 0;
    try {
      read = readSync(handle, buffer, 0, READ_CHUNK, null);
    } catch {
      // EAGAIN: hết sự kiện. Mọi lỗi khác cũng dừng vòng này — lần đọc sau thử lại.
      return activity;
    }
    if (read <= 0) return activity;
    // Chỉ duyệt các gói trọn vẹn; `read` luôn là bội số của 24 với evdev, nhưng chặn dưới đây để
    // một nút lạ không đọc ra rác rồi trượt con trỏ.
    for (let offset = 0; offset + INPUT_EVENT_SIZE <= read; offset += INPUT_EVENT_SIZE) {
      const type = buffer.readUInt16LE(offset + 16);
      // Toạ độ tuyệt đối: mỗi gói chạm của panel đều có ít nhất một `ABS_MT_POSITION_*`, kể cả khi
      // driver không gửi `BTN_TOUCH` (xem ghi chú ở đầu tệp).
      if (type === EV_ABS) return true;
      if (type !== EV_KEY) continue;
      const value = buffer.readInt32LE(offset + 20);
      // `VALUE_RELEASE` không tính: nhấc ngón tay không phải thao tác mới. Nếu tính, một cú chạm
      // kéo dài sẽ tự gia hạn bộ đếm ngay lúc nhả và màn hình chờ không bao giờ hiện.
      if (value === VALUE_PRESS || value === VALUE_REPEAT) return true;
    }
    if (read < READ_CHUNK) return activity;
  }
}

/**
 * Bộ đếm nhàn rỗi. `start()`/`stop()` idempotent để `main.ts` gọi được ở mọi nhánh khởi động.
 */
export class IdleWatch {
  private handles: number[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly buffer = Buffer.alloc(READ_CHUNK);

  constructor(private readonly options: IdleWatchOptions) {}

  /** Số nút thật sự mở được — `main.ts` ghi con số này vào nhật ký để biết bộ đếm có chạy không. */
  get deviceCount(): number {
    return this.handles.length;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  start(): boolean {
    if (this.timer) return true;
    this.handles = openDevices(this.options.devices);
    if (this.handles.length === 0) return false;
    const pollMs = this.options.pollMs ?? 500;
    this.timer = setInterval(() => this.poll(), pollMs);
    // Bộ đếm không được giữ tiến trình sống khi cửa sổ cuối đóng — Electron tự thoát theo cửa sổ.
    this.timer.unref?.();
    return true;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const handle of this.handles) {
      try {
        closeSync(handle);
      } catch {
        /* đã đóng, hoặc nút bị rút ra giữa chừng */
      }
    }
    this.handles = [];
  }

  private poll(): void {
    let activity = false;
    for (const handle of this.handles) {
      if (drain(handle, this.buffer)) activity = true;
    }
    if (activity) this.options.onActivity();
  }
}
