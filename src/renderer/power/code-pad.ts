/**
 * Bàn phím số để nhập mã quản trị — một khối tự đứng.
 *
 * Khác bản `PinPad` trước đây ở đúng một điểm: chỉ còn **một** đường. Mã không còn do ứng dụng đặt ra
 * mà là mật khẩu sudo của máy (xem `main/sudo-check.ts`), nên không có bước "tạo mã hai lần" và không
 * có nút "Bỏ mã": thứ duy nhất bàn phím này làm là gom đủ chữ số rồi chuyển cho tiến trình chính.
 * Việc so mã nằm ở `main/code-guard.ts` — nơi này không được, và không thể, biết mã đúng.
 *
 * Tự dựng lưới phím thay vì dùng bàn phím ảo dùng chung: `ViewManager.sendKey()` chỉ có hai đích
 * (`keyboardTarget` là `'kiosk'` hoặc `'external'`), nên nó không gõ được vào cửa sổ thẻ nổi.
 */

import type { PowerResult } from '../../shared/panel.js';

/** Độ dài mã, khớp `CODE_MIN_LEN`/`CODE_MAX_LEN` trong `main/code-gate.ts`. */
export const CODE_MIN = 4;
export const CODE_MAX = 10;

export interface CodePadParts {
  root: HTMLElement;
  dots: HTMLElement;
  keys: HTMLElement;
  title: HTMLElement;
  hint: HTMLElement;
  cancel: HTMLButtonElement;
  submit: HTMLButtonElement;
}

export interface CodePadOptions extends CodePadParts {
  /** Gọi khi đã đủ độ dài tối thiểu. Ném lỗi cũng được — khối này tự đổi thành câu thất bại. */
  send(code: string): Promise<PowerResult>;
  /** Báo ra ngoài để dòng trạng thái của thẻ hiện đúng kết quả. */
  onResult(result: PowerResult): void;
}

export class CodePad {
  private code = '';
  /** Chặn bấm đúp khi một lời gọi IPC đang bay: một mã gửi hai lần là hai lần đếm vào bộ đếm sai. */
  private busy = false;

  constructor(private readonly options: CodePadOptions) {
    this.buildKeys();
    this.options.cancel.addEventListener('click', () => this.close());
    this.options.submit.addEventListener('click', () => void this.advance());
  }

  get isOpen(): boolean {
    return !this.options.root.hidden;
  }

  open(): void {
    this.reset();
    this.options.root.hidden = false;
  }

  close(): void {
    this.options.root.hidden = true;
    this.reset();
  }

  private draw(): void {
    this.options.dots.replaceChildren();
    for (let index = 0; index < CODE_MAX; index += 1) {
      const dot = document.createElement('span');
      dot.className = index < this.code.length ? 'codepad__dot is-filled' : 'codepad__dot';
      this.options.dots.append(dot);
    }
    // Nút gửi chỉ bấm được khi đã đủ độ dài tối thiểu — để không phải báo lỗi sau khi người dùng đã gõ
    // xong, và để một cú chạm lỡ tay không gửi đi một mã chắc chắn sai (mỗi lần sai là một lần đếm).
    this.options.submit.disabled = this.busy || this.code.length < CODE_MIN;
  }

  private reset(): void {
    this.code = '';
    this.options.title.textContent = 'Nhập mã quản trị';
    this.options.hint.textContent = 'Mã này là mật khẩu sudo của máy.';
    this.options.submit.textContent = 'Xác nhận';
    this.draw();
  }

  private press(key: string): void {
    if (this.busy || this.code.length >= CODE_MAX) return;
    this.code += key;
    this.draw();
  }

  private backspace(): void {
    if (this.busy) return;
    this.code = this.code.slice(0, -1);
    this.draw();
  }

  /** Dựng lưới 3×4: 1–9, một ô trống, 0, và phím xóa lùi. */
  private buildKeys(): void {
    const keys = this.options.keys;
    keys.replaceChildren();
    const add = (label: string, onPress: () => void): void => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'codepad__key';
      button.textContent = label;
      button.addEventListener('click', onPress);
      keys.append(button);
    };

    for (const digit of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) add(digit, () => this.press(digit));

    // Ô trống thứ 10: giữ chỗ để "0" và phím xóa nằm đúng hàng dưới cùng, như bàn phím số điện thoại.
    const blank = document.createElement('span');
    blank.className = 'codepad__key codepad__key--blank';
    keys.append(blank);

    add('0', () => this.press('0'));

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'codepad__key codepad__key--icon';
    back.setAttribute('aria-label', 'Xóa một chữ số');
    // Glyph Lucide `delete` vẽ thẳng trong JS thay vì qua `icons.ts`: tệp đó là bảng icon của thanh
    // trên, và trang này không link `base.css` (nên `.btn.icon svg` ở đó cũng không áp dụng).
    back.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<path d="M20 5H9l-7 7 7 7h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Z"></path>'
      + '<path d="m18 9-6 6M12 9l6 6"></path></svg>';
    back.addEventListener('click', () => this.backspace());
    keys.append(back);
  }

  /**
   * Gửi mã và quyết định đóng hay không.
   *
   * Chỉ đóng khi tiến trình chính đã nhận thành công. Đóng trước rồi mới biết hỏng là bắt người dùng
   * mở lại cả thẻ Nguồn mà không nói vì sao.
   */
  private async advance(): Promise<void> {
    if (this.busy || this.code.length < CODE_MIN) return;
    this.busy = true;
    this.draw();
    try {
      const result = await this.options.send(this.code);
      this.options.onResult(result);
      if (result.ok) {
        this.close();
        return;
      }
      // Sai mã: xoá ô đã gõ, giữ bàn phím mở. Giữ mở là cố ý — đóng đi thì lần thử sau phải bấm lại
      // từ đầu, và người dùng đang đứng ở panel không có lý do gì để bị bắt làm thế.
      this.code = '';
    } catch {
      this.options.onResult({ ok: false, message: 'Không kiểm được mã' });
      this.code = '';
    } finally {
      this.busy = false;
      this.draw();
    }
  }
}