import type { AppSettings, FrameSettings } from '../shared/ipc.js';
import { type DockAction } from '../shared/chrome.js';
import type { PanelPolicy, PowerResult } from '../shared/panel.js';
import type { ZoomLevel } from '../shared/services.js';
import type { PanelId } from './panel-window.js';
import type { SettingsStore } from './settings.js';
import type { SystemMonitor } from './system-monitor.js';
import type { ViewManager } from './view-manager.js';

/**
 * Hợp đồng giữa `ipc-chrome.ts` và main process.
 *
 * Tách khỏi `ipc-chrome.ts` vì hai tệp có nhịp thay đổi khác hẳn nhau: bề mặt channel chỉ đổi khi
 * preload đổi, còn danh sách hàm main cung cấp đổi mỗi lần một thẻ nổi cần thêm khả năng. Để chung
 * một tệp thì mỗi lần thêm một hàm là một lần sửa tệp đang giữ cả trăm dòng đăng ký channel.
 */
/** Những gì tệp này cần từ main process: trạng thái sống, không phải bản sao. */
export interface ChromeIpcHost {
  views(): ViewManager | null;
  store(): SettingsStore | null;
  monitor: SystemMonitor;
  currentSettings(): AppSettings;
  /**
   * Settings + hình học panel, đúng payload mà bốn mặt nạ góc cần. Main process tính vì chỉ nó biết
   * kích thước output; tệp này không được tự đo.
   */
  frameSettings(): FrameSettings;
  pushState(): void;
  pushApps(labels: string[]): void;
  parseAction(raw: unknown): DockAction | null;
  handleDockAction(action: DockAction): Promise<void>;

  /**
   * Đưa panel vào màn hình chờ — nút Khóa ở dock và nút Khóa trong menu Nguồn.
   *
   * Không hỏi lại và không có xác nhận: khóa là hành động *không* phá huỷ, nên một lần chạm là đủ,
   * và một hộp thoại ở đây chỉ làm khách khó chịu khi họ muốn tối màn hình ngay.
   */
  lock(): void;
  /** Trạng thái khóa hiện tại, cho trang màn hình chờ hỏi lúc nạp. */
  lockState(): { locked: boolean };
  /**
   * Cú chạm/vuốt *trên chính màn hình chờ* xin mở khóa.
   *
   * Đi qua main process chứ không tự ẩn trang: chỉ main biết mốc `lockedAt` để chặn ngón tay còn đang
   * đặt lúc khóa, và chỉ main đóng được cửa sổ overlay.
   */
  requestUnlock(at: number): boolean;
  /**
   * Mở một thẻ nổi theo tên. `null` khi main process chưa dựng xong thẻ đó — nơi gọi không phải
   * kiểm, vì nút trên thanh trên chỉ hiện sau khi panel đã lên.
   */
  openPanel(id: PanelId): boolean;
  /** Đóng một thẻ nổi. Trang gọi khi bấm ✕ hoặc Esc. */
  closePanel(id: PanelId): void;
  /**
   * Cấu hình mà thẻ Cài đặt được phép thấy — *không* phải `AppSettings`.
   *
   * Tách khỏi `currentSettings()` vì thẻ Cài đặt không có việc gì với zoom, hình nền hay cỡ bàn phím,
   * và vì một bề mặt hẹp thì không thể vô tình phình ra theo `AppSettings`.
   */
  panelPolicy(): PanelPolicy;
  /** Ghi giờ chờ + giữ sáng. Trả trạng thái **sau** khi ghi. */
  writePanelPolicy(patch: { idleTimeoutMs?: number; keepAwakeOnMedia?: boolean }): PanelPolicy;
  /** Mức cỡ chữ của trang đang hiện; `null` khi ở Home. */
  currentZoom(): ZoomLevel | null;
  /** Đặt thẳng một mức cỡ chữ (bốn mức trên thẻ Cỡ chữ), trả mức sau khi áp dụng. */
  setZoom(level: ZoomLevel): ZoomLevel | null;
  /** Xác thực mã rồi thoát kiosk ra console. `code` chỉ sống trong lời gọi này. */
  exitToConsole(code: string): Promise<PowerResult>;
  /** Tắt hoặc khởi động lại máy, sau khi xác thực mã. */
  powerAction(kind: 'restart' | 'shutdown', code: string): Promise<PowerResult>;
}