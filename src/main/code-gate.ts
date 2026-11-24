/**
 * Cửa mã cho ba hành động phá huỷ: khởi động lại, tắt máy, thoát ra console.
 *
 * Tệp này **không giữ mã** và **không so mã** — nó chỉ biết hình dạng hợp lệ của một mã và đếm số
 * lần nhập sai. Việc so mã thuộc về `sudo-check.ts`, tức là PAM của hệ thống: mã cần nhập chính là
 * mật khẩu sudo, nên không có bí mật nào của người dùng phải lưu trong tệp cấu hình ứng dụng.
 *
 * Vì sao vẫn cần bộ đếm: `sudo` không giới hạn số lần thử của một tiến trình cha gọi lại nhiều lần.
 * Không có bộ đếm thì người đứng ở panel thử 0000, 0001, … cả buổi. Chặn 30 giây sau 5 lần sai biến
 * 10^4 khả năng thành khoảng 30 000 giây, và đó mới là thứ khiến mã 4 số dùng được.
 *
 * Vì sao là lớp thuần, không I/O: bộ đếm là trạng thái bảo mật, nên nó phải kiểm được bằng
 * `node --test` mà không cần dựng Electron. Đồng hồ được **tiêm vào** đúng vì lý do đó.
 */

/** Mã ngắn nhất và dài nhất. Cận trên rộng vì mật khẩu sudo của máy thật có thể dài hơn 4 số. */
export const CODE_MIN_LEN = 4;
export const CODE_MAX_LEN = 10;

/** Số lần nhập sai liên tiếp trước khi tạm chặn, và thời gian chặn. */
export const MAX_CODE_ATTEMPTS = 5;
export const CODE_LOCKOUT_MS = 30_000;

/**
 * Mã chỉ gồm chữ số, đúng độ dài cho phép.
 *
 * Kiểm bằng biểu thức chính quy chứ không bằng `Number()`: `Number(' 12 ')` là `12`, và một mã có dấu
 * cách ở hai đầu mà vẫn qua được thì nó sẽ được gửi cho `sudo` kèm dấu cách và không bao giờ khớp.
 */
export function codeIsValid(code: unknown): code is string {
  return typeof code === 'string'
    && code.length >= CODE_MIN_LEN
    && code.length <= CODE_MAX_LEN
    && /^[0-9]+$/.test(code);
}

/** Bộ đếm số lần nhập sai, dùng chung cho cả ba hành động phá huỷ. */
export class CodeAttempts {
  private failures = 0;
  private blockedUntil = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Còn bao nhiêu mili-giây bị chặn. `0` là đang cho phép thử.
   *
   * Tự xoá số lần sai khi hết hạn chặn: nếu không, lần sai tiếp theo sau khi chờ đủ sẽ chặn ngay lập
   * tức, và người nhập đúng mã cũng không bao giờ vào được nữa.
   */
  blockedFor(): number {
    const remaining = this.blockedUntil - this.now();
    if (remaining <= 0) {
      if (this.blockedUntil !== 0) {
        this.blockedUntil = 0;
        this.failures = 0;
      }
      return 0;
    }
    return remaining;
  }

  /** Ghi nhận một lần sai; trả về số mili-giây bị chặn (0 nếu chưa tới ngưỡng). */
  recordFailure(): number {
    this.failures += 1;
    if (this.failures < MAX_CODE_ATTEMPTS) return 0;
    this.failures = 0;
    this.blockedUntil = this.now() + CODE_LOCKOUT_MS;
    return CODE_LOCKOUT_MS;
  }

  /** Ghi nhận một lần đúng: xoá sạch cả bộ đếm lẫn hạn chặn. */
  recordSuccess(): void {
    this.failures = 0;
    this.blockedUntil = 0;
  }
}
