/**
 * Một đồng hồ duy nhất cho cả thanh trên và màn hình chờ.
 *
 * Trước đây mỗi nơi tự định dạng: `system-monitor.ts` ép `Asia/Ho_Chi_Minh` (UTC+7), còn `lock.ts`
 * dùng `new Date()` của tiến trình renderer. Khi máy chạy `Etc/UTC`, hai mặt đồng hồ lệch nhau đúng
 * bảy giờ — người dùng thấy "đồng hồ ngoài màn hình chờ và đồng hồ trong hệ thống không giống nhau".
 * Gộp về một hàm thuần ở đây thì không còn đường nào để chúng lệch lại.
 *
 * Hàm không đọc `process.env`, không đọc tệp, không `require` gì — nên renderer nạp được dù đang bị
 * sandbox (điều mà `lock.ts` cần: trang khóa phải sống kể cả khi phần còn lại của giao diện hỏng).
 */

/**
 * Kiosk chào người ở Việt Nam nên luôn hiện giờ Hồ Chí Minh (UTC+7, không có giờ mùa hè), bất kể TZ
 * của máy. Một thanh đọc sai bảy giờ tệ hơn không có đồng hồ, và người đứng ở phòng gym không có cách
 * nào biết là máy đang sai.
 */
export const CLOCK_TIME_ZONE = 'Asia/Ho_Chi_Minh';

const DAY_NAMES = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * `h23` chứ không `h24`: `h24` biến nửa đêm thành "24:00", và một bảng giờ phòng gym hiện 24:00 đúng
 * lúc sang ngày mới là sai. `hour: '2-digit'` giữ số 0 đứng trước để cột giờ không co giãn.
 */
const CLOCK_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: CLOCK_TIME_ZONE,
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

export interface ClockParts {
  /** "09:07" — 24 giờ, luôn đủ hai chữ số. */
  time: string;
  /** "07" — hai chữ số giây, tách riêng để tô đỏ mà không phải cắt chuỗi. */
  seconds: string;
  /** "Thứ hai, 24/11/2026" — thứ đứng trước vì tiếng Việt đọc thứ trước ngày. */
  date: string;
  /** Sáu chữ số của giờ/phút/giây, đúng thứ tự vẽ trên màn hình chờ. */
  digits: [string, string, string, string, string, string];
}

/** Định dạng một mốc thời gian thành giờ tường Hồ Chí Minh. */
export function clockParts(now: Date): ClockParts {
  const parts = CLOCK_FORMAT.formatToParts(now);
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  const hour = pick('hour');
  const minute = pick('minute');
  const second = pick('second');
  const weekday = WEEKDAY_INDEX[pick('weekday')] ?? 0;
  return {
    time: `${hour}:${minute}`,
    seconds: second,
    date: `${DAY_NAMES[weekday]}, ${pick('day')}/${pick('month')}/${pick('year')}`,
    digits: [hour[0] ?? '0', hour[1] ?? '0', minute[0] ?? '0', minute[1] ?? '0', second[0] ?? '0', second[1] ?? '0'],
  };
}
