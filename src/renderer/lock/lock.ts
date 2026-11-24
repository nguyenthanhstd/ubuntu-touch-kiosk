/**
 * Trang màn hình chờ.
 *
 * Ba việc, không hơn: vẽ đồng hồ mỗi giây, nhận cú chạm hoặc cú vuốt để xin mở khóa, và phản hồi khi
 * được mở. Mọi quyết định "có cho mở không" nằm ở main process (`lock-state.ts`), không nằm ở đây —
 * trang này không biết mốc vừa khóa, nên nếu nó tự quyết thì ngón tay còn đang đặt trên kính lúc khóa
 * xong sẽ mở lại ngay (đúng lỗi mà `UNLOCK_ARM_MS` sinh ra để chặn).
 *
 * Tệp chỉ import hai mô-đun thuần (không I/O, không `require`): bộ định dạng giờ dùng chung và bộ quay
 * chữ số. Trang khóa là trang duy nhất phải nạp được kể cả khi phần còn lại của giao diện đang hỏng,
 * nên nó không kéo theo mô-đun nào chạm vào đĩa, mạng hay IPC. Trước đây nó tự định dạng giờ bằng
 * `new Date()` của renderer — đó chính là lý do đồng hồ màn hình chờ lệch bảy giờ so với thanh trên.
 */

import { clockParts } from '../../shared/clock.js';
import { mountDigitClock } from '../shared/clock-digits.js';

const lock = window.ntfLock;
if (!lock) throw new Error('ntfLock bridge missing');

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const root = $('lock');
const timeEl = $('time');
const dateEl = $('date');
const hintText = $('hint-text');

/** Ngưỡng coi là vuốt — hiện không dùng để quyết định, giữ cho lần mở rộng sau (vuốt mới mở). */
const SWIPE_MIN_PX = 56;
void SWIPE_MIN_PX;

/**
 * Vẽ đồng hồ. 24 giờ vì đây là bảng giờ trong phòng gym, không phải đồng hồ để bàn — và 24 giờ không
 * bao giờ cần tới AM/PM, tức là không có thêm chữ nào phải dịch.
 *
 * Giờ lấy từ `clockParts()` chứ không từ `new Date()` tại chỗ: cùng một hàm với thanh trên, nên hai
 * mặt đồng hồ không thể lệch nhau lần nữa dù máy chạy múi giờ nào.
 */
const digits = mountDigitClock(timeEl);

const paintClock = (): void => {
  const parts = clockParts(new Date());
  digits.update(parts.digits);
  dateEl.textContent = parts.date;
  // Nhãn đọc cho trình đọc màn hình: sáu ô chữ số đều `aria-hidden`, nên nếu không đặt ở đây thì
  // đồng hồ câm hoàn toàn với trợ năng.
  timeEl.setAttribute('aria-label', `Giờ Hồ Chí Minh ${parts.time}:${parts.seconds}`);
};

paintClock();
// Trôi theo giây chứ không theo phút: mặt đồng hồ có kim giây, và một cú nhảy trễ tới 59 s trông như
// máy treo. Hẹn lại theo mốc giây kế tiếp thay vì `setInterval` để không tích luỹ sai số và để lần vẽ
// đầu rơi đúng vào lúc số vừa đổi.
const scheduleTick = (): void => {
  const now = new Date();
  const msToNextSecond = 1000 - now.getMilliseconds();
  setTimeout(() => {
    paintClock();
    scheduleTick();
  }, msToNextSecond);
};
scheduleTick();

let unlocking = false;

/**
 * Xin mở khóa. `at` là đồng hồ của trang, và main so nó với mốc vừa khóa.
 *
 * Không kiểm tra `locked` trước khi gửi: trang có thể nạp xong trước khi main kịp đẩy trạng thái, và
 * main đã là nơi quyết định. Gửi rồi bị từ chối là đúng, còn tự chặn ở đây thì có lúc cú chạm hợp lệ
 * bị nuốt.
 */
const requestUnlock = async (): Promise<void> => {
  if (unlocking) return;
  unlocking = true;
  try {
    const granted = await lock.requestUnlock(Date.now());
    if (!granted) {
      // Chưa đủ thời gian "arm": bỏ qua im lặng, nhưng vẫn cho phép chạm lại.
      unlocking = false;
      return;
    }
    root.classList.add('is-unlocking');
    // 320 ms: dài hơn animation 260 ms + vệt quét, ngắn hơn mức người dùng thấy là chậm.
    setTimeout(() => {
      root.classList.remove('is-unlocking');
      unlocking = false;
    }, 320);
  } catch {
    unlocking = false;
  }
};

// --- Cử chỉ -------------------------------------------------------------------------------------
// Dùng Pointer Events chứ không dùng `touchstart`: Chromium tổng hợp pointer event cho cả chạm và
// chuột, và `pointerup` chỉ bắn một lần cho mỗi ngón — đúng thứ cần để không mở khóa hai lần.
//
// Không phân biệt chạm với vuốt, và không bắt hướng: trên tấm kính lớn, bắt đúng một hướng vuốt chỉ
// thêm một điều phải học mà không thêm được bảo mật nào. Màn hình chờ ở đây để tối panel, không phải
// ổ khóa — khóa thật là mật khẩu khi Thoát ra console.

let tracking = false;

root.addEventListener('pointerdown', () => {
  tracking = true;
  root.classList.add('is-touched');
});

root.addEventListener('pointerup', () => {
  root.classList.remove('is-touched');
  if (!tracking) return;
  tracking = false;
  void requestUnlock();
});

// Ngón tay bị kéo ra ngoài cửa sổ rồi nhấc: không có `pointerup`, nên phải dọn trạng thái.
root.addEventListener('pointercancel', () => {
  tracking = false;
  root.classList.remove('is-touched');
});

// --- Trạng thái ---------------------------------------------------------------------------------
// Main đẩy `locked: false` ngay trước khi ẩn cửa sổ. Trang dùng nó để gỡ hiệu ứng, không dùng để tự
// quyết định gì thêm.
lock.onState((state) => {
  if (state.locked) {
    root.classList.remove('is-unlocking');
    hintText.textContent = 'Chạm để mở khóa';
    unlocking = false;
    paintClock();
  }
});

// Một cú chạm vào trang mà không phải chỗ nào khác: chặn menu ngữ cảnh của Chromium, thứ duy nhất
// Chromium còn tự bật trên trang không có phần tử nhập.
window.addEventListener('contextmenu', (event) => event.preventDefault());
