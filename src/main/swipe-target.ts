/**
 * Trang nào được hưởng cử chỉ vuốt đổi video.
 *
 * Một tệp riêng vì đây là **toàn bộ** luật bảo mật của cử chỉ đó, và luật này phải kiểm được bằng
 * unit test mà không cần Electron: `swipe-ipc.ts` nạp `ipcMain` nên không import được trong `node`.
 *
 * Luật đọc URL do main process làm chủ (`webContents.getURL()`), không đọc tham số từ trang: một
 * khung iframe quảng cáo vẫn chạy preload của ta và vẫn khai báo được bất kỳ tên miền nào.
 */

/** Đuôi tên miền hợp lệ khi tên miền đúng bắt đầu bằng `host` và theo sau là dấu chấm. */
const matchesHost = (host: string, base: string): boolean =>
  host === base || host.endsWith(`.${base}`);

export function isVideoSwipeUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (matchesHost(host, 'tiktok.com')) return true;
  if (!matchesHost(host, 'facebook.com')) return false;
  // `/reel/` và `/reels/` đều là bảng cuộn video; `/watch`, `/marketplace`, trang chủ thì không.
  return url.pathname.startsWith('/reel');
}