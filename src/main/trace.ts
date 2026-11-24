import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Nhật ký chẩn đoán ghi ra tệp.
 *
 * `console.log` của main process trong bản đóng gói không tới được `journalctl --user` trên kiosk
 * (đã kiểm: dòng `[keyboard] popup` không bao giờ xuất hiện dù bàn phím mở thành công), nên không
 * dùng được làm kênh điều tra. Hàm này ghi nối tiếp vào `$XDG_RUNTIME_DIR/ntf-trace.log` để đọc lại
 * bằng `cat`. Chỉ bật khi có biến môi trường `NTF_TRACE=1` để bản chạy thật không ghi đĩa.
 */
const ENABLED = process.env['NTF_TRACE'] === '1';

let file: string | null = null;

function target(): string {
  if (file !== null) return file;
  const base = process.env['XDG_RUNTIME_DIR'] ?? tmpdir();
  file = join(base, 'ntf-trace.log');
  return file;
}

export function trace(message: string): void {
  if (!ENABLED) return;
  try {
    appendFileSync(target(), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Chẩn đoán không bao giờ được làm hỏng ứng dụng.
  }
}
