/**
 * Cửa kiểm mã dùng chung cho cả ba hành động phá huỷ.
 *
 * Ba hành động (khởi động lại, tắt máy, thoát ra console) cùng phá một phiên đang chạy, nên chúng phải
 * dùng **đúng một** phép kiểm, **đúng một** bộ đếm và **đúng một** câu báo lỗi. Ba bản sao là ba chỗ
 * có thể quên `-k`, quên đếm, hoặc đếm riêng nên nhập sai ở thẻ này không ảnh hưởng thẻ kia.
 *
 * Tách khỏi `panel-host.ts` để kiểm được bằng `node --test`: `panel-host` cần `PANEL_SPECS` (tức là
 * Electron), còn tệp này chỉ cần một hàm `verify` được tiêm vào.
 */

import { CodeAttempts } from './code-gate.js';

/** Câu trả lời của cửa kiểm. `ok: false` luôn kèm một câu người đứng ở panel đọc được. */
export type CodeVerdict = { ok: true } | { ok: false; message: string };

export class CodeGuard {
  private readonly attempts: CodeAttempts;

  /**
   * @param verify Phép kiểm thật — `sudo-check.ts` khi chạy thật, một hàm giả khi chạy test.
   */
  constructor(
    private readonly verify: (code: string) => Promise<boolean>,
    now: () => number = Date.now,
  ) {
    this.attempts = new CodeAttempts(now);
  }

  /**
   * Kiểm một mã, có đếm số lần sai.
   *
   * Thứ tự ba nhánh là quan trọng: **chặn trước** rồi mới kiểm. Nếu kiểm trước thì một người đang bị
   * chặn vẫn dùng được panel để thử mã miễn phí, và hình phạt chỉ còn là lời nói.
   */
  async check(code: string): Promise<CodeVerdict> {
    const blocked = this.attempts.blockedFor();
    if (blocked > 0) {
      return { ok: false, message: `Sai mã quá nhiều lần, thử lại sau ${Math.ceil(blocked / 1000)} giây` };
    }
    let passed = false;
    try {
      passed = await this.verify(code);
    } catch {
      // Lỗi bất ngờ (không spawn được sudo) cũng phải là "không qua": cửa này chỉ có hai trạng thái.
      passed = false;
    }
    if (!passed) {
      const wait = this.attempts.recordFailure();
      return {
        ok: false,
        message: wait > 0 ? `Sai mã quá nhiều lần, thử lại sau ${Math.ceil(wait / 1000)} giây` : 'Sai mã',
      };
    }
    this.attempts.recordSuccess();
    return { ok: true };
  }
}
