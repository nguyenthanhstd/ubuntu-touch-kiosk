/**
 * Tắt máy và khởi động lại — hai lệnh hệ thống duy nhất trong ứng dụng.
 *
 * Vì sao đi qua `systemctl` chứ không gọi thẳng D-Bus: `systemctl poweroff`/`reboot` là đúng đường
 * logind dùng, nên nó đi qua đúng quy tắc polkit mà `scripts/install-power-policy.sh` cài. Gọi D-Bus
 * bằng tay chỉ đổi cú pháp, không đổi quyền — và thêm một tầng phải tự kiểm.
 *
 * Vì sao trả `PowerResult` chứ không ném lỗi: thất bại ở đây **luôn** có lý do người đứng ở panel cần
 * đọc (chưa cài quy tắc polkit, logind từ chối, hết thời gian chờ). Một promise bị từ chối sẽ thành
 * "Không làm được" chung chung trên màn hình, tức là không chẩn đoán được gì từ xa.
 */

import { execFile } from 'node:child_process';
import type { PowerResult } from '../shared/panel.js';

/**
 * Giới hạn thời gian. `systemctl poweroff` trả về ngay sau khi logind nhận lệnh, nên 8 giây là rất
 * rộng; treo ở đây là treo luôn IPC handler và cửa sổ menu Nguồn không bao giờ nhận câu trả lời.
 */
const POWER_TIMEOUT_MS = 8000;

/** Rút gọn stderr của systemctl thành một câu đọc được trên màn hình 2560 px. */
function explain(stderr: string, fallback: string): string {
  const line = stderr
    .split('\n')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.startsWith('===='))
    .pop();
  if (!line) return fallback;
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

function runSystemctl(verb: 'poweroff' | 'reboot'): Promise<PowerResult> {
  return new Promise((resolve) => {
    execFile('systemctl', [verb], { timeout: POWER_TIMEOUT_MS }, (error, _stdout, stderr) => {
      if (!error) return resolve({ ok: true, message: '' });
      resolve({ ok: false, message: explain(stderr, `Không ${verb === 'poweroff' ? 'tắt' : 'khởi động lại'} được máy`) });
    });
  });
}

/**
 * Tắt máy.
 *
 * Không tự kiểm "có quyền không" trước khi gọi: câu trả lời duy nhất đáng tin là kết quả của chính
 * lệnh, còn `pkcheck` chỉ nói về phiên gọi nó (phiên SSH không phải phiên của panel) — đo trên máy
 * này, `CanPowerOff` trả `"challenge"` cho một phiên mà lệnh thật vẫn có thể thành công sau khi cài
 * quy tắc.
 */
export function powerOff(): Promise<PowerResult> {
  return runSystemctl('poweroff');
}

export function reboot(): Promise<PowerResult> {
  return runSystemctl('reboot');
}
