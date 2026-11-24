/**
 * Ba thao tác vẽ dùng chung cho thẻ Nguồn: tìm thẻ theo id, ghi một câu trạng thái, và đánh dấu một
 * nút là đang chờ.
 *
 * Tách khỏi `power.ts` vì chúng là tầng vẽ thuần: đầu vào là một chuỗi và một phần tử DOM, đầu ra là
 * pixel. Không biết gì về mã PIN, về IPC, hay về hành động nào đang chạy — nên kiểm được bằng cách
 * gọi thẳng, và `power.ts` còn lại đúng một việc là ghép các hành động.
 */

export function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`thiếu #${id}`);
  return node as T;
}

/** Ghi chữ vào dòng trạng thái và tự ẩn câu xác nhận sau 2,6 giây. */
export interface StatusSlot {
  (text: string, tone?: 'alert' | 'ok' | 'idle'): void;
}

/**
 * Tạo bộ ghi cho một `<span>` trạng thái.
 *
 * `alert` giữ câu lại vô hạn — lỗi phải đọc được, không được tự biến mất. `ok` tự ẩn vì nó chỉ xác
 * nhận một việc đã xong.
 */
export function createStatusSlot(node: HTMLElement): StatusSlot {
  let timer = 0;
  const slot: StatusSlot = (text, tone = 'idle') => {
    window.clearTimeout(timer);
    node.textContent = text;
    node.classList.toggle('is-alert', tone === 'alert');
    node.classList.toggle('is-ok', tone === 'ok');
    if (tone === 'ok' && text !== '') {
      timer = window.setTimeout(() => {
        node.textContent = '';
        node.classList.remove('is-ok');
      }, 2600);
    }
  };
  return slot;
}

/**
 * Đặt một nút ở trạng thái "đang chờ": khóa bấm, đổi dòng gợi ý, thêm dấu `is-busy`.
 *
 * Dòng gợi ý đổi thay vì thay cả nút bằng spinner: thay nút thì lưới 2×2 nhảy, và ngón tay đang đặt
 * trên nút sẽ rơi sang nút khác.
 */
export function markBusy(button: HTMLButtonElement, label: string): void {
  button.disabled = true;
  button.classList.add('is-busy');
  const hint = button.querySelector<HTMLElement>('.act__hint');
  if (hint) hint.textContent = label;
}

/** Trả nút về trạng thái bấm được và đặt lại dòng gợi ý. */
export function settle(button: HTMLButtonElement, hint: string): void {
  button.disabled = false;
  button.classList.remove('is-busy');
  const node = button.querySelector<HTMLElement>('.act__hint');
  if (node) node.textContent = hint;
}
