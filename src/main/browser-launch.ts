/**
 * Mở trình duyệt hệ thống như một client *riêng*, kèm bước dọn profile trước khi spawn (`QA-11`).
 *
 * Tách khỏi `dock-actions.ts` vì hai lý do. Thứ nhất, `dock-actions.ts` đã chạm trần LOC và phần
 * "mở app ngoài" là mảng duy nhất ở đó không phụ thuộc `ViewManager`/`SettingsStore` — tách ra thì
 * nó test được mà không cần dựng cả kiosk. Thứ hai, `prepareFirefoxProfile()` từng **không có nơi
 * gọi nào** trong app: chỉ test import nó, nên `user.js` khôi phục đúng nhưng `recovery.jsonlz4` cũ
 * không bao giờ bị xoá lúc mở trình duyệt. Đo trên panel 22/11: trồng dấu vào
 * `sessionstore-backups/recovery.jsonlz4`, chạm tile trình duyệt, dấu vẫn còn nguyên — Firefox nạp
 * lại phiên cũ và hiện thanh "Khôi phục phiên". Đưa lời gọi vào đây thì nó nằm ngay trên đường mở.
 */

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { SYSTEM_BROWSERS } from '../shared/services.js';
import { prepareFirefoxProfile, type FirefoxProfilePrepResult } from './firefox-prefs.js';

/** Firefox được ưu tiên khi script cài đặt tuỳ chọn đã chạy; Chromium là snap luôn có sẵn. */
export function resolveSystemBrowser(): string | null {
  for (const candidate of SYSTEM_BROWSERS) {
    if (candidate.command === 'firefox' && existsSync('/snap/bin/firefox')) return '/snap/bin/firefox';
    if (candidate.command === 'chromium' && existsSync('/snap/bin/chromium')) return '/snap/bin/chromium';
  }
  return null;
}

/**
 * Chromium là app duy nhất *cố tình* không chạy Wayland gốc.
 *
 * Đo trên chính panel này: Chromium chạy Wayland gốc phớt lờ labwc hoàn toàn. Rule đại trà resize
 * và move nó, rồi Chromium khôi phục hình học đã lưu trong profile đè lên — `--window-size` và
 * `--window-position` cũng bị bỏ qua, và ngay cả một profile mới hay một yêu cầu 800x600 cũng đáp
 * xuống thành cửa sổ phủ toàn output tại x 0–2559, y 44–1525, vẽ đè lên thanh trên, hai rãnh và
 * đỉnh dock. Dưới XWayland thì đúng binary đó tuân theo WM và đo ra đúng rows 54–1493, cols
 * 10–2549, thanh/dock/rãnh còn nguyên.
 *
 * Nên chỉ Chromium bị đẩy sang XWayland, còn FreeTube và Firefox vẫn là Wayland gốc.
 * `--ozone-platform=x11` là switch tường minh nên nó thắng mặc định wayland của kiosk. DISPLAY được
 * ép chứ không dò: labwc bật XWayland theo yêu cầu khi client đầu tiên kết nối tới :0, nên socket
 * có thể chưa tồn tại lúc dock action chạy.
 */
const CHROMIUM_IS_X11 = true;

/**
 * XWayland của labwc được bật theo yêu cầu khi client đầu tiên kết nối, nhưng labwc không export
 * DISPLAY cho tiến trình con — run-kiosk.sh unset nó để Electron của kiosk chọn Wayland. Một app
 * chỉ có X11 sẽ chết với "Missing X server". Đưa :0 khi socket đã tồn tại để labwc bật XWayland
 * theo yêu cầu. Cờ ozone tường minh vẫn thắng, nên hàm này không kéo app Wayland gốc về X11.
 */
function x11FallbackEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_SESSION_TYPE: 'wayland' };
  if (!env.DISPLAY && existsSync('/tmp/.X11-unix/X0')) env.DISPLAY = ':0';
  return env;
}

/**
 * Dọn profile Firefox **trước** khi spawn. Trả `null` cho mọi binary không phải Firefox: Chromium
 * không có khái niệm khôi phục phiên kiểu này nên không được chạm vào profile của nó.
 *
 * Nhận `options` chỉ để test trỏ vào thư mục tạm; trên panel luôn gọi không tham số và
 * `firefox-prefs.ts` tự lấy `~/snap/firefox/common/.mozilla/firefox`.
 */
export function prepareBrowserProfile(
  binary: string,
  options?: Parameters<typeof prepareFirefoxProfile>[0],
): FirefoxProfilePrepResult | null {
  if (!binary.toLowerCase().includes('firefox')) return null;
  const result = prepareFirefoxProfile(options);
  if (result.errors.length > 0) console.error('[browser] dọn profile Firefox lỗi:', result.errors.join('; '));
  if (result.removedBackups.length > 0) console.log(`[browser] đã xoá ${result.removedBackups.length} bản sao lưu phiên cũ`);
  return result;
}

export function launchDetached(
  binary: string,
  args: string[],
  tag: string,
  extraEnv: NodeJS.ProcessEnv = {},
): void {
  try {
    const child = spawn(binary, args, {
      stdio: 'ignore',
      detached: true,
      env: { ...x11FallbackEnv(), ...extraEnv },
    });
    child.unref();
    console.log(`[${tag}] đã mở ${binary}`);
  } catch (error) {
    console.error(`[${tag}] không mở được:`, (error as Error).message);
  }
}

/**
 * Mở trình duyệt hệ thống trong khung giữa thanh trên và dock, nên kiosk vẫn thấy và vẫn chạm được
 * quanh nó; không có gì bị che và Ctrl+C trên kiosk vẫn trả về console.
 */
export function launchSystemBrowser(): string | null {
  const browser = resolveSystemBrowser();
  if (!browser) {
    console.error('[browser] không tìm thấy firefox hoặc chromium');
    return null;
  }
  prepareBrowserProfile(browser);
  if (browser.includes('chromium') && CHROMIUM_IS_X11) {
    launchDetached(browser, ['--ozone-platform=x11'], 'browser', { DISPLAY: ':0' });
    return browser;
  }
  launchDetached(browser, [], 'browser');
  return browser;
}
