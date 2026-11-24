/**
 * Kiểm mã bằng chính PAM của hệ thống: `printf '<mã>\n' | sudo -k -S -v`.
 *
 * ## Vì sao không tự giữ mã
 *
 * Yêu cầu là "mã giống sudo". Cách trung thực nhất để làm đúng câu đó là **hỏi sudo**, chứ không phải
 * chép mật khẩu sudo vào một tệp cấu hình riêng rồi băm nó — bản sao đó sẽ cũ đi ngay lần đầu ai đổi
 * mật khẩu trên máy, và nó là một bí mật thứ hai phải bảo vệ. Ở đây mã chỉ sống trong bộ nhớ trang
 * Nguồn cho tới lúc bấm nút, rồi đi vào stdin của một tiến trình con và biến mất theo nó.
 *
 * ## Vì sao có `-k`
 *
 * `-k` xoá timestamp trước khi kiểm, nên một phiên sudo còn ấm không thể biến một mã **sai** thành
 * "đúng". Đo trên máy QA: nhập đúng rồi nhập sai kèm `-k` vẫn trả rc=1. Không có `-k` thì lần nhập
 * thứ hai trong 15 phút luôn thành công mà không kiểm gì — tức là cửa mở toang.
 *
 * ## Vì sao `-S` và không có cờ `T`
 *
 * `-S` đọc mật khẩu từ stdin. Thiếu `-S` thì `sudo` đòi một TTY và tiến trình con treo tới hết giờ.
 * `-v` chỉ cập nhật timestamp, không chạy lệnh nào — nên phép kiểm này không thể bị lợi dụng để chạy
 * một lệnh khác qua đường này.
 *
 * ## Vì sao `rc 0` mới là đúng
 *
 * Ba trạng thái phải khác nhau: 0 = đúng, 1 = sai mã, còn mọi thứ khác (thiếu sudo, hết giờ, bị
 * chặn) là **không kiểm được** — và không kiểm được thì phải đóng cửa. Vì thế hàm dưới trả `boolean`
 * và mọi nhánh không phải 0 đều là `false`.
 *
 * ## Ghi chú: timestamp còn lại sau khi kiểm
 *
 * Một lần kiểm đúng để lại timestamp sudo cho user này. Trên máy này điều đó **không** mở thêm đường
 * nào: hai lệnh tắt/khởi động lại đi qua polkit của logind (`systemctl poweroff/reboot`) chứ không qua
 * sudo, và ứng dụng không có lệnh sudo nào khác để ai đó lợi dụng timestamp đó.
 */

import { spawn } from 'node:child_process';
import { codeIsValid } from './code-gate.js';

/** Rộng hơn nhiều so với 11 ms đo được; treo ở đây là treo luôn IPC handler và thẻ Nguồn đứng im. */
const SUDO_TIMEOUT_MS = 8000;

/**
 * Kiểm một mã với sudo. `false` cho mọi trường hợp không phải "sudo trả về 0".
 *
 * Mã không đúng khuôn bị từ chối **trước khi** chạm tới tiến trình con: một mã rỗng mà vẫn được gửi
 * đi thì sudo nhận một dòng trống và hành xử theo cách ta không kiểm soát được.
 */
export function verifySudoCode(code: string): Promise<boolean> {
  if (!codeIsValid(code)) return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    const child = spawn('sudo', ['-k', '-S', '-v'], { stdio: ['pipe', 'ignore', 'ignore'] });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false);
    }, SUDO_TIMEOUT_MS);

    child.on('error', () => {
      clearTimeout(timer);
      finish(false);
    });

    child.on('close', (rc) => {
      clearTimeout(timer);
      finish(rc === 0);
    });

    // Ghi mã rồi đóng stdin ngay: sudo đọc đúng một dòng. Không dùng `console`/`trace` ở đây — mã
    // không bao giờ được xuất hiện trong log.
    child.stdin.on('error', () => {
      /* EPIPE khi sudo thoát trước khi đọc xong; kết quả đã có qua 'close'. */
    });
    child.stdin.end(`${code}\n`);
  });
}
