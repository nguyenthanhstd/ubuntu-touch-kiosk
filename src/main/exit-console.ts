/**
 * Thoát kiosk ra màn hình console Ubuntu.
 *
 * Cơ chế: nhờ systemd dừng chính unit kiosk, sau 1 giây. Khi labwc nhả DRM master, fbcon lấy lại
 * console và panel hiện đúng màn hình đăng nhập Ubuntu — đã đo trên máy này (xem §4.1 của
 * `upgrade/ke-hoach-kiosk.md`).
 *
 * Ba ràng buộc, mỗi cái đã thử và **hỏng nếu thiếu**:
 *
 * 1. Không tự gọi `systemctl --user stop` trực tiếp: dừng unit sẽ SIGTERM đúng cây tiến trình đang
 *    gọi, nên lời gọi không bao giờ chạy xong. Phải nhờ một unit tạm của systemd.
 * 2. Phải bọc trong `/bin/sh -c` và export hai biến môi trường. Truyền thẳng
 *    `/usr/bin/systemctl --user stop …` cho `systemd-run` thì **không làm gì cả** — kể cả khi thêm
 *    `--setenv=` — vì tiến trình con của unit tạm không có địa chỉ bus phiên.
 * 3. Phải trễ `--on-active=1`: không trễ thì unit tạm chết theo cây tiến trình bị dừng.
 */

import { execFile } from 'node:child_process';
import type { PowerResult } from '../shared/panel.js';

/**
 * `systemd-run` trả về ngay sau khi tạo timer, nên 5 giây là rất rộng. Treo ở đây là treo luôn IPC
 * handler và cửa sổ menu Nguồn không bao giờ nhận câu trả lời.
 */
const EXIT_TIMEOUT_MS = 5000;

/** Đường dẫn runtime của phiên người dùng đang chạy kiosk. Cố định trong image này (uid 1000). */
const RUNTIME_DIR = '/run/user/1000';

/**
 * Lệnh mà unit tạm sẽ chạy.
 *
 * `DBUS_SESSION_BUS_ADDRESS` phải nằm trong lệnh chứ không phải trong `--setenv=`: đo trên máy này,
 * `--setenv=` không tới được tiến trình con còn export trong shell thì tới.
 */
const STOP_COMMAND =
  `export XDG_RUNTIME_DIR=${RUNTIME_DIR}; ` +
  `export DBUS_SESSION_BUS_ADDRESS=unix:path=${RUNTIME_DIR}/bus; ` +
  'systemctl --user stop ntfitness-kiosk.service';

/** Rút gọn stderr thành một câu đọc được trên màn hình cảm ứng. */
function explain(stderr: string, fallback: string): string {
  const line = stderr
    .split('\n')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.startsWith('===='))
    .pop();
  if (!line) return fallback;
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

/**
 * Dừng kiosk để nhường panel cho console.
 *
 * Không bao giờ ném lỗi: mọi thất bại ở đây đều có lý do người đứng ở panel cần đọc, và một promise
 * bị từ chối sẽ thành "Không làm được" chung chung — không chẩn đoán được gì từ xa.
 */
export function exitToConsole(): Promise<PowerResult> {
  return new Promise((resolve) => {
    execFile(
      'systemd-run',
      [
        '--user',
        '--collect',
        '--unit=ntf-exit-console',
        '--on-active=1',
        '/bin/sh',
        '-c',
        STOP_COMMAND,
      ],
      { timeout: EXIT_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        if (!error) return resolve({ ok: true, message: '' });
        resolve({ ok: false, message: explain(stderr, 'Không thoát ra console được') });
      },
    );
  });
}
