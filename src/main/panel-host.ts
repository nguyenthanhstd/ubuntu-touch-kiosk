/**
 * Chủ sở hữu bốn thẻ nổi: Cài đặt, Âm lượng, Cỡ chữ, Nguồn.
 *
 * Vì sao là một lớp riêng chứ không phải tám hàm rải trong `main.ts`: bốn thẻ này có chung đúng bốn
 * việc — dựng cửa sổ theo `PANEL_SPECS`, đọc/ghi chính sách, kiểm mã cho hành động phá huỷ, và gọi
 * lệnh hệ thống — và `main.ts` đã quá trần 300 dòng từ trước khi có tính năng này. Tệp này không biết
 * gì về dock, thanh trên hay `ViewManager`; nó chỉ nhận một `PanelHostDeps` hẹp, nên kiểm được mà
 * không cần Electron.
 *
 * Vì sao cửa kiểm mã nằm ở đây chứ không ở trang menu Nguồn: bộ đếm số lần sai phải sống ở main
 * process — nếu trang giữ bộ đếm thì đóng thẻ rồi mở lại là xoá sạch hình phạt, và giới hạn số lần
 * thử trở thành hình thức. Cùng lý do với màn hình chờ ở `screensaver.ts`.
 */

import type { AppSettings } from '../shared/ipc.js';
import type { PanelPolicy, PowerResult } from '../shared/panel.js';
import type { ZoomLevel } from '../shared/services.js';
import { CodeGuard } from './code-guard.js';
import { PANEL_SPECS, PanelWindow, type PanelId } from './panel-window.js';
import { exitToConsole as stopKioskForConsole } from './exit-console.js';
import { powerOff, reboot } from './power.js';
import { verifySudoCode } from './sudo-check.js';

/**
 * Những gì tệp này cần từ main process.
 *
 * `read`/`write` trả **AppSettings** chứ không trả `PanelPolicy` để một lần ghi có thể mang nhiều
 * trường hơn những gì thẻ Cài đặt được thấy; việc hạ xuống `PanelPolicy` làm đúng một lần, ở `policy()`.
 */
export interface PanelHostDeps {
  read(): AppSettings;
  /** Ghi **một** lần xuống đĩa và trả trạng thái sau khi ghi. */
  write(patch: { idleTimeoutMs?: number; keepAwakeOnMedia?: boolean }): AppSettings;
  /** Đưa panel vào màn hình chờ. */
  lock(): void;
  /** Chính sách vừa đổi — bộ đếm nhàn rỗi cần dựng lại. */
  onPolicyChanged(): void;
  /** Mức cỡ chữ của trang đang hiện, `null` khi ở Home — không có trang nào để phóng. */
  getZoom(): ZoomLevel | null;
  /** Đặt mức cỡ chữ cho trang đang hiện; trả mức **sau khi** áp dụng. */
  setZoom(level: ZoomLevel): ZoomLevel | null;
  /** Phép kiểm mã; mặc định là `sudo-check.ts`. Chỗ tiêm cho test. */
  verifyCode?(code: string): Promise<boolean>;
}

const PANEL_IDS = Object.keys(PANEL_SPECS) as PanelId[];

export class PanelHost {
  private readonly panels = new Map<PanelId, PanelWindow>();
  private readonly guard: CodeGuard;

  constructor(private readonly deps: PanelHostDeps) {
    this.guard = new CodeGuard(deps.verifyCode ?? verifySudoCode);
  }

  /** Dựng cửa sổ (một lần, ẩn) và nạp trang. Trả `false` khi không dựng được. */
  open(id: PanelId): boolean {
    return this.panelFor(id).show();
  }

  close(id: PanelId): void {
    this.panels.get(id)?.hide();
  }

  /**
   * Ẩn cả bốn thẻ.
   *
   * Phải gọi **trước** khi khóa: thẻ đặt `AlwaysOnTop('screen-saver')`, còn `LockOverlay` cũng vậy —
   * hai cửa sổ cùng mức thì cửa sổ map sau thắng, nên một thẻ đang mở sẽ nằm **trên** màn hình chờ và
   * lộ nguyên nội dung vừa bị khóa.
   */
  hideAll(): void {
    for (const panel of this.panels.values()) panel.hide();
  }

  /** Đóng hẳn cả bốn cửa sổ — lúc cửa sổ kiosk đóng. */
  destroy(): void {
    for (const panel of this.panels.values()) panel.destroy();
    this.panels.clear();
  }

  policy(): PanelPolicy {
    const settings = this.deps.read();
    return {
      idleTimeoutMs: settings.idleTimeoutMs,
      keepAwakeOnMedia: settings.keepAwakeOnMedia,
    };
  }

  writePolicy(patch: { idleTimeoutMs?: number; keepAwakeOnMedia?: boolean }): PanelPolicy {
    const next = this.deps.write(patch);
    this.deps.onPolicyChanged();
    return {
      idleTimeoutMs: next.idleTimeoutMs,
      keepAwakeOnMedia: next.keepAwakeOnMedia,
    };
  }

  /** Cỡ chữ hiện tại của trang đang hiện. Chỉ đọc — thẻ Cài đặt cỡ chữ tự vẽ theo giá trị này. */
  zoom(): ZoomLevel | null {
    return this.deps.getZoom();
  }

  /** Đặt một mức cỡ chữ, không đi qua bước ± để bốn mức trên thẻ đều tới được trực tiếp. */
  setZoom(level: ZoomLevel): ZoomLevel | null {
    return this.deps.setZoom(level);
  }

  /**
   * Xác thực mã rồi thoát kiosk ra console Ubuntu.
   *
   * Không còn nhánh "chưa đặt mã": mã là mật khẩu sudo của máy, luôn tồn tại. Nhánh chặn thì nằm trong
   * `CodeGuard` — dùng chung với hai hành động dưới, nên nhập sai ở thẻ này cũng khoá luôn thẻ kia.
   */
  async exitToConsole(code: string): Promise<PowerResult> {
    const verdict = await this.guard.check(code);
    if (!verdict.ok) return { ok: false, message: verdict.message };
    // Ẩn thẻ trước khi unit kiosk bị dừng: cửa sổ thẻ là cửa sổ riêng của Electron, không thuộc unit,
    // nên nếu để mở thì nó vẫn nằm trên console cho tới khi tiến trình chết hẳn.
    this.hideAll();
    return stopKioskForConsole();
  }

  /**
   * Tắt máy hoặc khởi động lại, sau khi xác thực mã.
   *
   * Mã được kiểm **trước** khi ẩn thẻ: nếu ẩn trước rồi mã sai thì khách nhìn thấy panel trống và phải
   * mở lại menu Nguồn từ đầu, còn tệ hơn là đứng yên tại chỗ với câu "Sai mã".
   */
  async powerAction(kind: 'restart' | 'shutdown', code: string): Promise<PowerResult> {
    const verdict = await this.guard.check(code);
    if (!verdict.ok) return { ok: false, message: verdict.message };
    this.hideAll();
    return kind === 'shutdown' ? powerOff() : reboot();
  }

  /** Nút Khóa trong menu Nguồn: ẩn thẻ rồi vào màn hình chờ. */
  lockNow(): void {
    this.hideAll();
    this.deps.lock();
  }

  /** Thẻ chưa được mở lần nào thì `panels` chưa có nó — dựng ở đây, không dựng sẵn lúc khởi động. */
  private panelFor(id: PanelId): PanelWindow {
    let panel = this.panels.get(id);
    if (!panel) {
      panel = new PanelWindow(PANEL_SPECS[id]);
      this.panels.set(id, panel);
    }
    return panel;
  }
}

/** Số thẻ đang khai báo — chỉ để `main.ts` khỏi phải biết danh sách. */
export const PANEL_COUNT = PANEL_IDS.length;