/**
 * Máy trạng thái khóa — tầng ② logic thuần.
 *
 * Không I/O, không `Date.now()`, không đồng hồ: mọi sự kiện mang `at` của chính nó, nên toàn bộ quyết
 * định ở đây kiểm được bằng `node --test` mà không cần panel, không cần Wayland, không cần chờ.
 *
 * Vì sao phải là máy trạng thái chứ không phải một cờ boolean: có ba nguồn cùng đòi đổi trạng thái
 * (hết giờ nhàn rỗi, nút Khóa ở dock, nút trong menu Nguồn) và một nguồn đòi thoát ra (cú chạm trên
 * màn hình chờ). Gộp chúng vào một hàm thuần là cách duy nhất để chứng minh "ngón tay đang đặt lúc
 * khóa không tự mở khóa" mà không phải diễn lại trên máy thật.
 */

/** Chỉ hai trạng thái: panel đang dùng được, hoặc đang phủ màn hình chờ. */
export type LockPhase = 'awake' | 'locked';

export interface LockState {
  phase: LockPhase;
  /**
   * Thời điểm vào trạng thái `locked`; `0` khi đang `awake`.
   *
   * Cần giữ lại chứ không chỉ giữ `phase`: cú chạm đầu tiên ngay sau khi khóa là ngón tay còn đang
   * đặt trên ô dock, không phải ý định mở khóa.
   */
  lockedAt: number;
}

/**
 * Cửa sổ "vừa khóa xong" — trong khoảng này, thao tác **không** mở khóa.
 *
 * 400 ms: dài hơn một lần `pointerup` + `pointercancel` thường thấy trên panel này, và ngắn hơn
 * nhịp người dùng thật sự chạm lại để mở khóa (đo được ở các ca chạm liên tiếp là > 600 ms).
 */
export const UNLOCK_ARM_MS = 400;

export type LockEvent =
  /** Có thao tác thật trên panel (chạm, phím, chuột) — do `idle-watch` phát. */
  | { type: 'activity'; at: number }
  /** Bộ đếm nhàn rỗi vừa hết hạn. */
  | { type: 'idle'; at: number }
  /** Người dùng yêu cầu khóa (nút Khóa ở dock hoặc menu Nguồn). */
  | { type: 'lock'; at: number }
  /**
   * Cú chạm trên màn hình chờ.
   *
   * Chỉ có hiệu lực khi **bắt đầu** sau `lockedAt + UNLOCK_ARM_MS`, nên ngón tay đang đặt lúc khóa
   * không thể mở khóa chính nó.
   */
  | { type: 'unlock'; at: number };

export const INITIAL_LOCK_STATE: LockState = { phase: 'awake', lockedAt: 0 };

/**
 * Áp một sự kiện. Luôn trả về **object mới khi trạng thái đổi**, và trả về **chính object cũ** khi
 * không đổi — nhờ vậy nơi gọi so sánh bằng tham chiếu là biết có phải vẽ lại hay không.
 */
export function decide(state: LockState, event: LockEvent): LockState {
  switch (event.type) {
    case 'lock':
      if (state.phase === 'locked') return state;
      return { phase: 'locked', lockedAt: event.at };

    case 'idle':
      // Nhàn rỗi khi đã khóa là chuyện bình thường: panel đang chờ, không có gì để làm thêm. Không
      // đặt lại `lockedAt` — nếu đặt lại, mỗi lần bộ đếm hết hạn sẽ gia hạn cửa sổ chống mở-khóa-nhầm
      // và người dùng thật sẽ bị chặn mở khóa mãi mãi.
      if (state.phase === 'locked') return state;
      return { phase: 'locked', lockedAt: event.at };

    case 'unlock':
      if (state.phase !== 'locked') return state;
      if (event.at - state.lockedAt < UNLOCK_ARM_MS) return state;
      return INITIAL_LOCK_STATE;

    case 'activity':
      // Thao tác chỉ có nghĩa khi panel đang dùng được; nó đặt lại bộ đếm ở tầng gọi.
      if (state.phase !== 'awake') return state;
      return state;

    default:
      return state;
  }
}

/**
 * Cú chạm này có được phép mở khóa ngay bây giờ không?
 *
 * Tách khỏi `decide()` để tầng vẽ hỏi được mà không phải tự tạo một sự kiện: cùng một luật
 * `UNLOCK_ARM_MS`, một chỗ viết.
 */
export function canUnlockAt(state: LockState, at: number): boolean {
  return state.phase === 'locked' && at - state.lockedAt >= UNLOCK_ARM_MS;
}
