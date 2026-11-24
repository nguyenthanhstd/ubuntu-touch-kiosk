/**
 * Nhận diện cú vuốt dọc giữa trang để đổi video trên TikTok và Facebook Reels.
 *
 * Vì sao phải làm ở preload: trên Cage/Wayland + Electron 45, `input-event` của main process **không
 * bao giờ** thấy ngón tay, nên main process không có toạ độ nào để biết một cú vuốt đã xảy ra. Preload
 * là nơi duy nhất còn thấy `pointer*`/`touch*` thật.
 *
 * Vì sao cú cuộn cũng phải làm ở preload — đo trên panel, không suy đoán: `sendInputEvent` với
 * `type: 'mouseWheel'` **không cuộn được** hai trang này. Sự kiện có tới DOM (đo được `deltaY` đúng
 * dấu, `cancelable: false`, không bị `preventDefault`) nhưng `scrollTop` đứng yên; cùng toạ độ đó, một
 * `Input.dispatchMouseEvent` của CDP cuộn 0 → 848, và `scrollBy` của chính trang cũng cuộn. Vậy nút
 * thắt nằm ở khâu chuyển bánh xe tổng hợp của Electron, không phải ở trang. Chỉ JavaScript trong trang
 * mới cuộn chắc chắn, nên cú cuộn chạy ở đây.
 *
 * Main process vẫn giữ quyền quyết định: preload chỉ *xin* (`swipe:video`), main kiểm sender + URL thật
 * rồi mới trả lệnh `swipe:scroll` về. Trang không có API nào trong tay; nó chỉ nhận được một bước cuộn
 * đúng bằng thứ ngón tay vừa yêu cầu.
 *
 * KHÔNG để bước hai lần: khi ta đã nhận cú vuốt thì `preventDefault()` trên `touchmove` chặn luôn cú
 * pan gốc, nếu không khách sẽ nhảy hai video cho một lần vuốt.
 *
 * SANDBOX LAW: tệp này được `scripts/fix-preload.mjs` chép nguyên văn vào preload đã build, nên nó
 * phải tự đứng một mình tuyệt đối — không import, không `require`.
 */

/** `1` = video kế tiếp (ngón đi lên), `-1` = video trước đó (ngón đi xuống). */
type SwipeDirection = 1 | -1;

/** Dải mép thuộc về cử chỉ của kiosk (trái = lùi, dưới = về Home), nên cú vuốt đổi video phải né. */
const EDGE_CSS = 40;
/** Ngón phải đi xa bao nhiêu mới tính là một cú vuốt chứ không phải cú chạm. */
const MIN_TRAVEL_CSS = 90;
/** Lệch ngang tối đa: quá số này thì khách đang vuốt ngang, không phải đổi video. */
const MAX_ORTHO_CSS = 70;
/** Bước cuộn, tính theo chiều cao khung sẽ cuộn; main ép lại lần nữa trước khi trả lệnh về. */
const STEP_RATIO = 0.9;
const STEP_MIN_PX = 400;
const STEP_MAX_PX = 1200;
/** Dư vài px thì không tính là "cuộn được", tránh khung 1–2 px do làm tròn layout. */
const SCROLL_EPSILON = 4;

/**
 * Trang nào được hưởng cử chỉ này.
 *
 * Bản sao của luật này tồn tại trong `swipe-target.ts` và bản ở đó mới là bản có hiệu lực: nó đọc URL
 * thật của `WebContents` do main process làm chủ, còn tên miền ở đây thì trang sửa được. Bản này chỉ
 * để khỏi chặn cú pan của mọi trang khác.
 */
const isVideoPage = (): boolean => {
  const host = location.hostname;
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return true;
  const onFacebook = host === 'facebook.com' || host.endsWith('.facebook.com');
  return onFacebook && location.pathname.startsWith('/reel');
};

const scrollsVertically = (el: Element): boolean => {
  const style = getComputedStyle(el);
  const overflow = `${style.overflowY}`;
  if (overflow !== 'auto' && overflow !== 'scroll' && overflow !== 'overlay') return false;
  return el.scrollHeight - el.clientHeight > SCROLL_EPSILON;
};

/**
 * Khung sẽ cuộn cho cú vuốt này: khung **gần ngón nhất** tự cuộn được, hoặc `null` nghĩa là cả trang.
 *
 * Đo trên panel: bảng video thật của TikTok (`/foryou`) nằm trong `DIV#column-list-container` với
 * `scroll-snap-type: y mandatory` — chính nó là khung cuộn, `document` đứng yên ở `scrollTop: 0`.
 *
 * Phải duyệt **cả chồng** phần tử tại điểm chạm (`elementsFromPoint`), không phải phần tử trên cùng
 * (`elementFromPoint`): nút thích/bình luận/âm lượng của TikTok là lớp phủ `fixed` nằm **ngoài** khung
 * trong DOM, nên khi ngón đặt trúng một nút đó thì `elementFromPoint` trả về nút, chuỗi tổ tiên của nút
 * không chứa khung, và khung bị bỏ sót. Đo trên panel trước khi sửa: chạm ở y=1250 và y=1350 rơi vào
 * nút phủ → không tìm thấy khung → rơi về `window.scrollBy`, mà `document` không cuộn được trên `/foryou`
 * nên cú vuốt **im lặng không làm gì**. Duyệt cả chồng thì dưới lớp phủ vẫn thấy đúng khung.
 *
 * Lấy khung gần nhất (không phải xa nhất) là đúng cho cả hai trường hợp: chạm vào bảng video thì khung
 * gần nhất là bảng video, chạm vào danh sách bình luận thì khung gần nhất là danh sách đó — bình luận
 * cuộn, video không nhảy. Vì duyệt từ lớp trên cùng xuống, danh sách bình luận (nằm trên) vẫn thắng.
 */
const nearestOwnerOf = (top: Element | null): HTMLElement | null => {
  let el = top as HTMLElement | null;
  while (el && el !== document.body && el !== document.documentElement) {
    if (scrollsVertically(el)) return el;
    el = el.parentElement;
  }
  return null;
};

const scrollOwner = (x: number, y: number): HTMLElement | null => {
  const stack = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [];
  for (const top of stack) {
    const found = nearestOwnerOf(top);
    if (found) return found;
  }
  return nearestOwnerOf(document.elementFromPoint(x, y));
};


/** Một bước bằng gần trọn khung cuộn, để khung bắt được nấc kế tiếp của `scroll-snap`. */
const scrollStep = (owner: HTMLElement | null): number => {
  const view = owner ? owner.clientHeight : window.innerHeight;
  return Math.round(Math.min(STEP_MAX_PX, Math.max(STEP_MIN_PX, view * STEP_RATIO)));
};

/** `owner` có thể đã bị gỡ khỏi DOM sau khi main trả lệnh; lúc đó cuộn cả trang. */
const applyScroll = (owner: HTMLElement | null, dir: SwipeDirection, step: number): void => {
  const amount = dir * step;
  if (owner && owner.isConnected) {
    owner.scrollBy({ top: amount, behavior: 'smooth' });
    return;
  }
  window.scrollBy({ top: amount, behavior: 'smooth' });
};

/** `onScroll` do main process gọi lại, sau khi nó đã kiểm sender và URL thật của trang. */
export type ScrollCommand = (payload: unknown) => void;

/**
 * Cài bộ nhận diện. `send` là đường duy nhất ra khỏi trang; ở đây nó là `ipcRenderer.send`.
 *
 * Trả về hàm nhận lệnh cuộn để `preload-service.cts` nối vào `ipcRenderer.on('swipe:scroll')`.
 */
export function installVideoSwipe(send: (channel: string, payload: unknown) => void): ScrollCommand {
  const noop: ScrollCommand = () => undefined;
  if (!window.addEventListener) return noop;
  const w = window as unknown as { __ntfVideoSwipe?: boolean };
  if (w.__ntfVideoSwipe) return noop;
  w.__ntfVideoSwipe = true;

  let ownerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let claimed = false;
  let blocked = false;
  /** Khung đã được chọn lúc `touchstart`; giữ lại để lệnh cuộn của main nhắm đúng khung đó. */
  let target: HTMLElement | null = null;

  const reset = (): void => {
    ownerId = null;
    claimed = false;
    blocked = false;
    target = null;
  };

  const begin = (x: number, y: number, t: number, id: number | null): void => {
    if (ownerId !== null) return;
    if (!isVideoPage()) return;
    const height = window.innerHeight;
    const width = window.innerWidth;
    if (y <= EDGE_CSS || y >= height - EDGE_CSS) return;
    if (x <= EDGE_CSS || x >= width - EDGE_CSS) return;
    ownerId = id;
    startX = x;
    startY = y;
    claimed = false;
    blocked = false;
    target = scrollOwner(x, y);
  };

  /** Trả về true khi ta nhận cú vuốt và phải chặn cú pan gốc. */
  const move = (x: number, y: number, t: number, id: number | null): boolean => {
    if (ownerId === null || id !== ownerId) return false;
    const dx = x - startX;
    const dy = y - startY;
    if (!blocked) {
      if (Math.abs(dy) < 12 && Math.abs(dx) < 12) return false;
      if (Math.abs(dx) > Math.abs(dy)) {
        reset();
        return false;
      }
      blocked = true;
    }
    if (claimed) return true;
    if (Math.abs(dy) < MIN_TRAVEL_CSS) return true;
    if (Math.abs(dx) > MAX_ORTHO_CSS) {
      reset();
      return true;
    }
    claimed = true;
    const dir: SwipeDirection = dy < 0 ? 1 : -1;
    send('swipe:video', { dir, step: scrollStep(target) });
    return true;
  };

  const end = (id: number | null): void => {
    if (ownerId === null || id !== ownerId) return;
    reset();
  };

  /*
   * `touchmove` phải là `{ passive: false }` mới chặn được cú pan gốc; đây là lý do duy nhất tệp này
   * đăng ký một listener không thụ động, và nó chỉ `preventDefault()` khi đã chắc chắn là vuốt dọc
   * trên trang video. Mọi trang khác đi qua đây mà không bị chạm gì.
   */
  window.addEventListener('touchstart', (e: TouchEvent) => {
    if (e.touches.length > 1) {
      reset();
      return;
    }
    const t = e.touches[0];
    if (!t) return;
    begin(t.clientX, t.clientY, e.timeStamp, t.identifier);
  }, { capture: true, passive: true });

  window.addEventListener('touchmove', (e: TouchEvent) => {
    if (ownerId === null) return;
    if (e.touches.length > 1) {
      reset();
      return;
    }
    const t = e.touches[0];
    if (!t || t.identifier !== ownerId) return;
    if (move(t.clientX, t.clientY, e.timeStamp, ownerId) && e.cancelable) e.preventDefault();
  }, { capture: true, passive: false });

  window.addEventListener('touchend', (e: TouchEvent) => {
    if (ownerId === null) return;
    end(ownerId);
  }, { capture: true, passive: true });

  window.addEventListener('touchcancel', () => reset(), { capture: true, passive: true });

  /*
   * Lệnh cuộn do main process trả về. Chỉ nhận đúng bước mà main đã kiểm và ép khoảng; khung đích lấy
   * từ lần chạm hiện tại (hoặc lần chạm vừa rồi, nếu main trả lời sau `touchend`).
   */
  return (payload: unknown): void => {
    const raw = payload as { dir?: unknown; step?: unknown } | null;
    const dir = raw?.dir === 1 ? 1 : raw?.dir === -1 ? -1 : null;
    const step = typeof raw?.step === 'number' && Number.isFinite(raw.step) ? raw.step : null;
    if (dir === null || step === null) return;
    const el = target;
    reset();
    applyScroll(el, dir, Math.round(Math.min(STEP_MAX_PX, Math.max(STEP_MIN_PX, step))));
  };
}