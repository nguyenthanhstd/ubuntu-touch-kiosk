import { execFile } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Rect } from './layout.js';

/**
 * Ghi hình học bàn phím nổi vào chỗ **compositor** đọc được, rồi buộc nó đọc lại.
 *
 * Vì sao phải có cơ chế riêng cho việc này — `xdg_toplevel` **không có** request đặt vị trí, và trên
 * panel này điều đó đo được bảy lần, cả bảy đều khớp:
 *
 * - Có rule `MoveTo`: cửa sổ nằm đúng chỗ rule ghi; `setBounds` của Electron dời chỗ không hiệu quả.
 * - Gỡ `fixedPosition`: vẫn không dời được bằng `setBounds`.
 * - Gỡ hẳn `MoveTo`: cửa sổ rơi về chỗ labwc tự xếp (402x1104 giữa màn hình), không phải chỗ Electron xin.
 *
 * Còn **kích thước thì Electron sở hữu**: đang hiện mà xin `setKeyboardScale(300)` thì vùng vẽ co từ
 * 389 xuống 305 px tại chỗ, trong khi `ResizeTo 900x420` trong rule là no-op (nhận 1119x400, đúng cỡ
 * Electron đặt). Đúng như giao thức: toplevel có `set_size`, không có `set_position`.
 *
 * Nên phân công là: **Electron lo cỡ, labwc lo chỗ** — và đường đổi chỗ là ba bước dưới. Đo chi phí
 * trên panel: sinh lại `rc.xml` 12,9 ms, `labwc --reconfigure` 13,5 ms, cả chuỗi **20,2 ms** (5 lần),
 * tức vẫn nằm dưới nhịp throttle 30 ms của ngăn kéo nên dời theo từng bước là vừa.
 *
 * Thứ tự ba bước là kết quả đo, không phải sở thích: labwc chỉ áp `windowRule` **lúc cửa sổ được map**
 * và đọc **cấu hình trong bộ nhớ** của nó. Ghi tệp trên đĩa mà không `--reconfigure` thì lần map sau
 * vẫn đi theo cấu hình cũ; `--reconfigure` mà không map lại thì cửa sổ đang hiện **không** bị dời.
 */

/** `dist/main/labwc-remap.js` -> `<app>/scripts/gen-labwc-config.sh`. */
const GEN_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'gen-labwc-config.sh');

const PGREP = '/usr/bin/pgrep';
const LABWC = '/usr/bin/labwc';
/** Lệnh này nằm trên đường chạm của người dùng, nên không được phép treo lâu. */
const TIMEOUT_MS = 1500;

/** Cùng biểu thức `run-kiosk.sh` dùng, để tệp vị trí rơi đúng cạnh `rc.xml` mà nó vừa sinh. */
function configDir(): string {
  const override = process.env.NTF_LABWC_DIR;
  if (override && override.length > 0) return override;
  return join(homedir(), '.config', 'labwc');
}

/**
 * Môi trường cho client Wayland — cùng lý do và cùng giá trị dự phòng với `wlrEnv()` trong
 * `compositor.ts`: thiếu hai biến này thì lệnh im lặng không làm gì.
 *
 * Không dựa vào việc tiến trình kiosk có sẵn `HOME` hay `XDG_RUNTIME_DIR`: `/proc/<pid>/environ` của
 * Electron trên panel trả về toàn NUL (tiến trình không cho dump), nên không có cách nào xác nhận.
 */
function wlEnv(): NodeJS.ProcessEnv {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  return {
    ...process.env,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || 'wayland-0',
  };
}

function run(file: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(file, [...args], { env, timeout: TIMEOUT_MS }, (error) => {
      if (error) {
        console.log(`[labwc-remap] ${file} ${args.join(' ')} lỗi: ${error.message}`);
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}

/**
 * `labwc --reconfigure` từ chối chạy nếu thiếu `LABWC_PID` (`ERROR [../src/main.c:112] LABWC_PID not
 * set`), và biến đó **không** được thừa hưởng từ unit systemd cấp người dùng. Tự dò lấy.
 */
function labwcPid(env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(PGREP, ['-x', 'labwc'], { env, timeout: TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const first = stdout.split('\n')[0]?.trim() ?? '';
      resolve(first.length > 0 ? first : null);
    });
  });
}

let warnedMissing = false;

/**
 * Một hàng đợi duy nhất: một cú kéo nhanh có thể commit hai lần, và hai chuỗi chồng nhau sẽ để
 * `rc.xml` mang hình học của lần trước trong khi `--reconfigure` của lần sau đã chạy xong.
 */
let chain: Promise<void> = Promise.resolve();

/**
 * Ghi `x y w h` xuống đĩa và buộc labwc nạp lại. Trả `true` khi cả ba bước đều xong.
 *
 * Bốn số chứ không hai: `y` phải kẹp theo chiều cao **thật** của popup (200-470 px qua tay nắm), nên
 * chỉ lưu hai toạ độ thì lần map sau sẽ kẹp theo chiều cao mặc định và popup tự nhảy lên.
 *
 * Lưu ý: hàm này **chỉ** làm phần của compositor. Cửa sổ đang hiện vẫn chưa nhúc nhích cho tới lần
 * map kế tiếp — `KeyboardOverlay.remap()` lo phần đó.
 */
export function writeLabwcGeometry(rect: Rect): Promise<boolean> {
  const key = `${Math.round(rect.x)} ${Math.round(rect.y)} ${Math.round(rect.width)} ${Math.round(rect.height)}`;
  const result = chain.then(async () => {
    if (!existsSync(GEN_SCRIPT)) {
      if (!warnedMissing) {
        warnedMissing = true;
        console.warn(`[labwc-remap] không thấy ${GEN_SCRIPT} — bàn phím sẽ không dời được chỗ`);
      }
      return false;
    }
    try {
      writeFileSync(join(configDir(), 'ntf-keyboard.pos'), `${key}\n`);
    } catch (error) {
      console.log(`[labwc-remap] không ghi được tệp vị trí: ${(error as Error).message}`);
      return false;
    }
    const env = wlEnv();
    if (!(await run('/bin/bash', [GEN_SCRIPT], env))) return false;
    const pid = await labwcPid(env);
    if (!pid) {
      console.log('[labwc-remap] không thấy tiến trình labwc — bỏ qua --reconfigure');
      return false;
    }
    return run(LABWC, ['--reconfigure'], { ...env, LABWC_PID: pid });
  });
  // Hàng đợi phải sống sót qua lỗi: một lần hỏng không được làm kẹt mọi lần sau.
  chain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}