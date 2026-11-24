/**
 * Kênh `swipe:video` — thẩm định một cú vuốt dọc trên TikTok/Facebook Reels rồi trả lệnh cuộn về.
 *
 * Vì sao không tổng hợp bánh xe ở đây — đo trên panel, không suy đoán: `sendInputEvent` với
 * `type: 'mouseWheel'` **không cuộn được** hai trang này. Sự kiện tới được DOM (đo được `deltaY` đúng
 * dấu, `cancelable: false`, `defaultPrevented: false`) nhưng `scrollTop` đứng yên; ở cùng toạ độ đó một
 * `Input.dispatchMouseEvent` của CDP cuộn 0 → 848 và `scrollBy` của trang cũng cuộn. Thêm
 * `wheelTicksY` chỉ làm trang nhảy 111 px đúng một lần rồi 0 px ở bốn lần lặp lại. Vậy khâu hỏng là
 * chuyển bánh xe tổng hợp của Electron, không phải trang — nên cú cuộn chạy bằng JavaScript trong
 * trang, và preload là nơi duy nhất có JavaScript của trang.
 *
 * Vì sao vẫn phải qua main process: preload không được tự quyết. Nó *xin* một bước cuộn, main kiểm
 * sender và URL thật (`webContents.getURL()`) rồi mới trả `swipe:scroll` về đúng view đó. Một iframe
 * quảng cáo trong trang cũng chạy preload của ta nhưng không có `WebContents` riêng, nên nó không gửi
 * được gì; và URL do main đọc thì trang không sửa được.
 *
 * Biên tin cậy: đây là kênh **duy nhất** trong hệ cử chỉ chỉ nhận đúng một sender — `serviceContents`.
 * `navContents` và `dockContents` là trang của ta, chúng không bao giờ có lý do gửi cuộn vào một dịch
 * vụ từ xa, nên nhận chúng ở đây chỉ mở thêm một đường tấn công.
 */

import { ipcMain } from 'electron';
import type { ViewManager } from './view-manager.js';
import { isVideoSwipeUrl } from './swipe-target.js';
import { trace } from './trace.js';

export interface SwipeIpcDeps {
  /** `null` trước khi `bootstrap()` dựng xong các view. */
  views(): ViewManager | null;
}

/** Bước cuộn nhỏ nhất / lớn nhất chấp nhận được, tính bằng px CSS của trang. */
const STEP_MIN = 400;
const STEP_MAX = 1200;

/** `+1` = video kế tiếp (ngón vuốt lên), `-1` = video trước (ngón vuốt xuống). */
function parseDir(payload: unknown): 1 | -1 | null {
  const dir = (payload as { dir?: unknown } | null)?.dir;
  if (dir === 1) return 1;
  if (dir === -1) return -1;
  return null;
}

/** Bước cuộn do trang đề nghị, ép vào khoảng an toàn trước khi trả về cho chính nó. */
function parseStep(payload: unknown): number {
  const raw = (payload as { step?: unknown } | null)?.step;
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : STEP_MIN;
  return Math.round(Math.min(STEP_MAX, Math.max(STEP_MIN, value)));
}

export function registerSwipeIpc(deps: SwipeIpcDeps): void {
  ipcMain.on('swipe:video', (event, payload: unknown) => {
    const views = deps.views();
    const service = views?.serviceContents;
    if (!service || service.isDestroyed() || service.id !== event.sender.id) {
      trace(`swipe:video from ${event.sender.id} rejected (not the service view)`);
      return;
    }
    const dir = parseDir(payload);
    if (dir === null) return;
    const url = service.getURL();
    if (!isVideoSwipeUrl(url)) {
      trace(`swipe:video ignored on ${url}`);
      return;
    }
    const step = parseStep(payload);
    event.sender.send('swipe:scroll', { dir, step });
    trace(`swipe:video dir=${dir} step=${step} on ${url}`);
  });
}