/**
 * Âm lượng — đường đọc/ghi có tuần tự.
 *
 * Vì sao phải là một tệp riêng: `pointermove` bắn nhanh hơn panel xử lý được, và mỗi lần `setVolume`
 * tốn một tiến trình `wpctl` ở phía xa. Một lần ghi mỗi khung hình giữ cú kéo ở mức vài chục tiến
 * trình thay vì vài trăm, và số thứ tự `issued` vứt bỏ những trả lời về sau khi một lượt kéo mới đã
 * thắng.
 *
 * Tệp này **không chạm DOM**: nó nhận một hàm `render` và chỉ lo "đọc gì, ghi gì, theo thứ tự nào".
 * Nhờ vậy phần vẽ (`volume-popover.ts`) và phần tuần tự hoá ở đây kiểm được độc lập.
 */
import type { VolumeState } from '../../shared/ipc.js';

/**
 * Ba kênh âm lượng mà bộ tuần tự hoá cần. Khai báo theo cấu trúc chứ không import `TopApi` hay
 * `VolumePanelApi`: hai bề mặt đó trùng đúng ba thành viên này, nên một kiểu hẹp ở đây nhận được cả
 * hai mà không phải chọn phe.
 */
export interface VolumeBridge {
  getVolume(): Promise<VolumeState>;
  setVolume(level: number): Promise<VolumeState>;
  setMuted(muted: boolean): Promise<VolumeState>;
}

export interface VolumeWriterOptions {
  /** Vẽ một trạng thái đã biết là đúng thứ tự mới nhất. */
  render: (state: VolumeState) => void;
  /**
   * Ngón đang đặt trên thanh kéo.
   *
   * Đọc **sau khi** promise trả về, không phải trước: một cú kéo có thể bắt đầu trong lúc lệnh đọc
   * còn đang bay, và lúc đó số trên nhãn thuộc về ngón tay chứ không thuộc về trả lời IPC.
   */
  isDragging: () => boolean;
  /** Cầu nối không có kênh âm lượng (bản preload cũ). */
  onUnavailable: () => void;
  onError: (error: unknown) => void;
  /**
   * Cầu nối để đọc/ghi. Mặc định `window.ntfTop` — thanh trên là nơi tệp này ra đời.
   *
   * Thẻ Âm lượng truyền `window.ntfVolume` vào đây. Không truyền được thì thẻ đó buộc phải chép lại
   * toàn bộ phần tuần tự hoá (số thứ tự `issued`, gộp mỗi khung một lời gọi, lạc quan rồi sửa), tức
   * là hai bản sao của cùng một logic chống đua — đúng thứ tệp này được tách ra để tránh.
   */
  bridge?: VolumeBridge;
}

export interface VolumeWriter {
  /** Đọc lại sự thật từ tiến trình chính. */
  read: () => void;
  /** Xếp một mức vào khung hình kế tiếp; mức mới nhất thắng. */
  writePercent: (percent: number) => void;
  /**
   * Lật trạng thái tắt tiếng.
   *
   * Trạng thái hiện tại do tệp này giữ, không phải do DOM: đọc ngược từ `aria-pressed` sẽ khiến một
   * lớp trình bày thành nguồn sự thật và hỏng ngay khi ai đó vẽ lại thuộc tính đó.
   */
  toggleMute: () => void;
  /**
   * Cú nhấc ngón tay.
   *
   * Chưa ghi gì (chạm vào rãnh mà không kéo) thì phải đọc lại, nếu không cần gạt giữ vị trí cú chạm
   * gợi ý thay vì vị trí thật.
   */
  settle: () => void;
}

export function createVolumeWriter(options: VolumeWriterOptions): VolumeWriter {
  const bridge = options.bridge ?? window.ntfTop;
  /** Sự thật gần nhất đã biết; `null` trước lần đọc thành công đầu tiên. */
  let current: VolumeState | null = null;
  /** Số thứ tự tăng dần của lần ghi mới nhất; trả lời mang số cũ bị vứt. */
  let issued = 0;
  /** Handle khung hình đang chờ, để cả cú kéo thành một lần invoke mỗi khung. */
  let queued = 0;
  /** Mức sẽ ghi ở khung hình kế tiếp. */
  let pendingLevel: number | null = null;

  const render = (next: VolumeState): void => {
    current = next;
    options.render(next);
  };

  const flush = (): void => {
    queued = 0;
    const level = pendingLevel;
    pendingLevel = null;
    if (level === null || typeof bridge?.setVolume !== 'function') return;
    const id = ++issued;
    // Lạc quan: cần gạt đã chạy theo ngón, nên nhãn theo ngay và trả lời chỉ còn việc sửa lại. Backend
    // tự bỏ mute khi mức lên trên 0, nên `muted` hạ xuống false ở đây là đúng hướng.
    if (current) render({ ...current, level: level / 100, muted: level === 0 ? current.muted : false });
    void bridge
      .setVolume(level / 100)
      .then((next) => {
        if (id !== issued) return;
        render(next);
      })
      .catch((error: unknown) => {
        if (id !== issued) return;
        options.onError(error);
      });
  };

  const read = (): void => {
    if (typeof bridge?.getVolume !== 'function') {
      options.onUnavailable();
      return;
    }
    void bridge
      .getVolume()
      .then((next) => {
        if (options.isDragging()) return;
        render(next);
      })
      .catch((error: unknown) => {
        options.onError(error);
      });
  };

  const writePercent = (percent: number): void => {
    pendingLevel = percent;
    if (queued === 0) queued = requestAnimationFrame(flush);
  };

  const setMuted = (next: boolean): void => {
    if (typeof bridge?.setMuted !== 'function') return;
    const id = ++issued;
    // Lật lạc quan để glyph trả lời cú chạm ngay trong khung hình của ngón tay.
    if (current) render({ ...current, muted: next });
    void bridge
      .setMuted(next)
      .then((result) => {
        if (id !== issued) return;
        render(result);
      })
      .catch((error: unknown) => {
        if (id !== issued) return;
        options.onError(error);
        if (current) render({ ...current, muted: !next });
      });
  };

  const toggleMute = (): void => {
    setMuted(!(current?.muted ?? false));
  };

  const settle = (): void => {
    if (queued === 0 && pendingLevel === null) read();
  };

  return { read, writePercent, toggleMute, settle };
}
