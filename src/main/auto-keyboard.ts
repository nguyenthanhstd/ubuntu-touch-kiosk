import type { WebContents } from 'electron';
import { trace } from './trace.js';

/**
 * Bàn phím ảo tự hiện/ẩn theo ô nhập đang được focus trong trang dịch vụ.
 *
 * Vì sao phải *hỏi DOM*: trên stack này (labwc + Wayland + Electron) cử chỉ chạm không bao giờ tới
 * `before-input-event` của main process, và các site từ xa (youtube.com, tiktok.com) không có preload
 * của ta. Cách duy nhất để biết con trỏ đang ở trong một ô nhập là đọc `document.activeElement`.
 *
 * Vì sao *poll* chứ không phải listener: `executeJavaScript` trả một promise cho mỗi lần gọi và
 * không huỷ được khi trang điều hướng đi; một listener `focusin` gọi ngược về sẽ rò rỉ qua các lần
 * điều hướng. Poll chỉ đọc, 200 ms một lần, và promise của nó reject vô hại khi document đã mất.
 *
 * NTF-R04: nhịp cũ (poll 400 ms + trễ 120 ms sau cú chạm) cộng với việc chỉ đọc `document` cấp trên
 * làm bàn phím hiện chậm và **không bao giờ** hiện khi ô nhập nằm trong iframe (khung nhúng của
 * Google, form đăng nhập của một số feed). Ba thay đổi ở đây: nhịp nhanh hơn, đọc xuống iframe cùng
 * origin, và loại `readOnly`/`disabled` khỏi đường tự mở.
 */

/** Nhanh nhất mà vẫn gộp được vài lần chạm liên tiếp; poll chỉ dùng để *đóng*. */
const POLL_MS = 200;
/** Đủ lâu để site kịp hoán đổi ô nhập thật vào, đủ nhanh để người dùng thấy tức thì. */
const PRESS_MS = 40;
/**
 * Lịch đọc lại sau cú chạm khi lượt đầu chưa thấy ô nhập — tổng cộng 450 ms.
 *
 * Trang thật đặt focus **muộn**: Google chuyển focus sau khi dropdown gợi ý render, feed thay một
 * container rỗng bằng ô nhập thật ở khung hình sau. Đo trên panel: bản cũ chỉ đọc một lần ở 40 ms nên
 * những ca này không bao giờ mở bàn phím. Bốn lần đọc là đủ phủ khoảng đó mà vẫn rẻ.
 */
const PRESS_RETRY_MS = [120, 250, 450];

/**
 * Trả 'edit' khi phần tử đang focus nhận chữ, 'blur' khi focus ở chỗ không nhận chữ, và '' khi
 * document còn đang tải.
 *
 * Đọc cả `isContentEditable` lẫn tên thẻ vì ô tìm kiếm của YouTube và nhiều ô bình luận là div
 * contenteditable, không phải <input>. Đọc xuống `contentDocument` của iframe cùng origin vì form
 * tìm kiếm của Google nằm trong khung nhúng; iframe khác origin thì `contentDocument` là null và ta
 * trả 'blur', đúng như hành vi cũ.
 *
 * **Không** đọc `doc.hasFocus()`: bàn phím của ta là một view riêng, nên ngay khi nó mở thì cửa sổ
 * kiosk không còn là cửa sổ được focus và `hasFocus()` trả false trên **mọi** trang — kể cả trang
 * đang thật sự có caret trong ô nhập. Bản cũ kiểm điều kiện đó ở cấp ngoài cùng, nên vòng poll 200 ms
 * đóng sập bàn phím ngay sau lần gõ đầu tiên. Thứ tự "ô nhập còn focus hay không" đã được trả lời
 * bằng chính `doc.activeElement`.
 *
 * Không đọc, không ghi và không trả về `el.value`: ô mật khẩu đi qua đây mỗi lần chạm, nên mọi thứ
 * gửi về main process phải là một trong ba chuỗi cố định.
 */
const PROBE = `(() => {
  const textual = ['text','search','url','tel','email','password','number',''];
  const inspect = (doc, depth) => {
    if (!doc) return 'blur';
    if (doc.readyState === 'loading') return '';
    const el = doc.activeElement;
    if (!el) return 'blur';
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      if (depth >= 3) return 'blur';
      let inner = null;
      try { inner = el.contentDocument; } catch (e) { inner = null; }
      return inner ? inspect(inner, depth + 1) : 'blur';
    }
    if (el === doc.body || el === doc.documentElement) return 'blur';
    // Trường chỉ đọc hoặc bị khoá không nhận chữ, mở bàn phím lên chỉ che màn hình.
    if (el.readOnly === true || el.disabled === true) return 'blur';
    if (el.getAttribute && el.getAttribute('aria-readonly') === 'true') return 'blur';
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return 'edit';
    if (el.isContentEditable) return 'edit';
    if (tag !== 'INPUT') return 'blur';
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return textual.includes(type) ? 'edit' : 'blur';
  };
  return inspect(document, 0);
})()`;

export interface AutoKeyboardOptions {
  /** View đang giữ focus: trang dịch vụ nếu có, ngược lại là trang nav. */
  target(): WebContents | null;
  /** Chỉ được gọi với `false` từ poll; `true` chỉ đến từ đường chạm (`notePress`). */
  onEditable?: (editable: boolean) => void;
  /**
   * Poll chỉ có nghĩa khi bàn phím đang mở — nó chỉ dùng để *đóng*. Khi bàn phím đóng, đọc
   * `document.activeElement` 5 lần/giây trên trang từ xa là chi phí vô ích, nên `arm()` (bật đường
   * chạm) tách khỏi điều kiện poll.
   */
  shouldPoll?: () => boolean;
  /** Bàn phím đang mở chưa — để cửa sổ thử dừng ngay khi lượt trước đã mở nó. */
  isOpen?: () => boolean;
}

export class AutoKeyboard {
  private armed = false;
  private seen = '';
  /**
   * Đã từng thấy một ô nhập có focus trong thế hệ arm hiện tại chưa.
   *
   * Poll chỉ được *đóng* bàn phím khi nó đã từng thấy ô nhập: nếu không, mở bàn phím thủ công từ
   * dock trên một trang không có ô nhập (trang kết quả tìm kiếm, video) sẽ bị lần poll kế tiếp đóng
   * lại sau ~200 ms.
   */
  private sawEdit = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  /** Số lần đã đọc lại trong cửa sổ thử của cú chạm hiện tại. */
  private attempt = 0;
  /**
   * Tăng mỗi lần arm/disarm. Một `executeJavaScript` đã bay đi thì không huỷ được, nên kết quả của
   * nó chỉ được dùng khi thế hệ chưa đổi — nếu không, đổi app trong lúc đang đọc sẽ mở bàn phím cho
   * trang vừa bị gỡ.
   */
  private generation = 0;

  constructor(private readonly options: AutoKeyboardOptions) {}

  arm(): void {
    trace(`arm gen=${this.generation} -> ${this.generation + 1}`);
    this.armed = true;
    this.seen = '';
    this.sawEdit = false;
    this.generation += 1;
    if (this.pollTimer !== null) return;
    this.pollTimer = setInterval(() => this.poll(), POLL_MS);
  }

  disarm(): void {
    trace(`disarm gen=${this.generation}`);
    this.armed = false;
    this.seen = '';
    this.sawEdit = false;
    this.generation += 1;
    if (this.pressTimer !== null) {
      clearTimeout(this.pressTimer);
      this.pressTimer = null;
    }
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private poll(): void {
    if (!this.armed || this.options.onEditable === undefined) return;
    if (this.options.shouldPoll?.() === false) return;
    const contents = this.options.target();
    if (!contents || contents.isDestroyed()) return;
    const generation = this.generation;
    const id = contents.id;
    void contents
      .executeJavaScript(PROBE, true)
      .then((result: unknown) => {
        if (!this.armed || generation !== this.generation) return;
        if (this.options.target()?.id !== id) return;
        const editable = result === 'edit';
        // Một view đang tải trả '' và không được tính là blur, nếu không mỗi lần điều hướng sẽ đóng
        // bàn phím mà người dùng vừa dùng để gửi tìm kiếm.
        if (result !== 'edit' && result !== 'blur') return;
        const key = `${id}:${editable ? 'edit' : 'blur'}`;
        if (key === this.seen) return;
        this.seen = key;
        if (editable) this.sawEdit = true;
        // Chỉ việc *đóng* đi qua poll. Việc mở là của cú chạm, nên một trang tự focus vào ô nhập
        // trong lúc video đang chạy không thể gọi bàn phím lên.
        //
        // `sawEdit` chặn ca bàn phím mở thủ công từ dock trên một trang chưa từng có focus: nếu
        // không, lần poll đầu tiên thấy `blur` và đóng ngay cái bàn phím vừa mở.
        if (!editable && this.sawEdit) this.options.onEditable?.(false);
      })
      .catch(() => undefined);
  }

  /**
   * Gọi từ `before-input-event` của cửa sổ chính ở mỗi lần nhấn. Một lần nhấn chỉ là *có thể* là
   * chạm vào ô nhập; chỉ trang mới trả lời được, nên hẹn đọc `document.activeElement` sau một nhịp
   * và mở bàn phím nếu cú chạm đã đưa focus vào ô nhập.
   *
   * Đây là lý do việc mở do cú chạm quyết định chứ không do poll: TikTok và YouTube render một
   * container rỗng trước rồi mới hoán đổi ô nhập thật vào ở khung hình sau, nên lúc pointerdown ô
   * nhập chưa tồn tại. Một lần đọc hoãn giá đúng một `executeJavaScript` mỗi cú chạm trên trang từ
   * xa, và không tốn gì khi cú chạm rơi vào video hay liên kết.
   */
  notePress(): void {
    if (this.options.onEditable === undefined) return;
    if (!this.armed) {
      trace('notePress skipped: not armed');
      return;
    }
    // NTF-R04 (đợt này): một lần đọc 40 ms nữa là chưa đủ. Trang thật thường đặt focus **muộn** —
    // Google chuyển focus sau khi dropdown gợi ý render, feed thì thay container rỗng bằng ô nhập
    // thật ở khung hình sau — nên cú chạm đầu tiên rơi vào lúc `document.activeElement` vẫn là body
    // và bàn phím không bao giờ mở. Bản cũ đọc đúng một lần rồi thôi.
    //
    // Nay cùng một cú chạm mở một **cửa sổ thử** hữu hạn: đọc lại ở 40 / 120 / 250 / 450 ms, dừng
    // ngay khi thấy ô nhập hoặc khi bàn phím đã mở (do lượt đọc trước) hoặc khi rời trang. Trần
    // 450 ms và 4 lần đọc giữ chi phí ở mức một `executeJavaScript` ngắn — nhưng nó phủ đúng khoảng
    // mà đo trên panel cho thấy focus đến muộn.
    this.attempt = 0;
    this.schedulePress(PRESS_MS);
  }

  /** Huỷ cửa sổ thử còn treo (đổi trang, tắt bàn phím, beam blur). */
  cancelPress(): void {
    if (this.pressTimer !== null) {
      clearTimeout(this.pressTimer);
      this.pressTimer = null;
    }
    this.attempt = 0;
  }

  private schedulePress(delay: number): void {
    if (this.pressTimer !== null) clearTimeout(this.pressTimer);
    this.pressTimer = setTimeout(() => this.resolvePress(), delay);
  }

  private resolvePress(): void {
    this.pressTimer = null;
    if (!this.armed) return;
    const contents = this.options.target();
    if (!contents || contents.isDestroyed()) return;
    const generation = this.generation;
    const id = contents.id;
    const attempt = this.attempt;
    void contents
      .executeJavaScript(PROBE, true)
      .then((result: unknown) => {
        if (!this.armed || generation !== this.generation) return;
        if (this.options.target()?.id !== id) return;
        trace('resolvePress result=' + JSON.stringify(result));
        if (result === 'edit') {
          if (this.options.onEditable === undefined) return;
          // Một cú chạm vào ô nhập cũng là lần đầu poll biết trang này có ô nhập, nên nó mở đường
          // cho phép poll *đóng* bàn phím ở lần chạm kế tiếp ra ngoài.
          this.sawEdit = true;
          // Mở lại một bàn phím đã mở sẽ khởi động lại document của nó và mất caret, nên main process
          // quyết định — nó là nơi biết view hiện có tồn tại hay không.
          this.options.onEditable(true);
          return;
        }
        // Focus đến muộn: thử lại theo lịch, tối đa hết `PRESS_RETRY_MS`.
        this.attempt = attempt + 1;
        if (this.attempt >= PRESS_RETRY_MS.length) return;
        // Bàn phím đã mở thì thử tiếp là vô ích (và mở lại sẽ làm mất caret của lần mở trước).
        if (this.options.isOpen?.() === true) return;
        this.schedulePress(PRESS_RETRY_MS[this.attempt] ?? PRESS_MS);
      })
      .catch(() => undefined);
  }
}
