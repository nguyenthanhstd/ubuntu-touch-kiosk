/**
 * Đồng hồ chữ số quay — phần DOM, dùng chung cho thanh trên và màn hình chờ.
 *
 * Tệp này chỉ dựng và cập nhật ô chữ số; hình thức nằm ở `clock-digits.css`. Tách đôi như vậy để
 * `lock.ts` nạp được đúng một module nhỏ (trang khóa phải sống kể cả khi phần còn lại hỏng) mà vẫn
 * dùng chung một cách hiển thị với thanh trên.
 *
 * Vì sao không phải một dải 0–9 trượt theo giá trị: 9 → 0 sẽ giật ngược cả dải. Ở đây mỗi ô chỉ có
 * hai mặt — mặt đang hiện và mặt kế tiếp — nên mọi bước đều quay cùng một chiều, kể cả bước 9 → 0.
 */

/** Bề rộng tối thiểu để một ô không co lại khi chuyển từ "1" sang "1" ở font không có `tnum`. */
export interface DigitClock {
  /** Vẽ sáu chữ số theo thứ tự giờ-chục, giờ-đơn-vị, phút-chục, phút-đơn-vị, giây-chục, giây-đơn-vị. */
  update(digits: readonly string[]): void;
}

const CELLS = 6;
const SEPARATOR_AFTER = new Set([1, 3]);
const SECONDS_FROM = 4;

interface Cell {
  host: HTMLElement;
  now: HTMLElement;
  next: HTMLElement;
  timer: number | null;
}

const prefersReducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Dựng đồng hồ vào `host` và trả về hàm cập nhật.
 *
 * `durationMs` phải khớp `--dg-ms` trong CSS; nó chỉ dùng để biết lúc nào đặt lại ô, không điều khiển
 * animation.
 */
export function mountDigitClock(host: HTMLElement, durationMs = 420): DigitClock {
  host.textContent = '';
  const cells: Cell[] = [];

  for (let index = 0; index < CELLS; index += 1) {
    const cellHost = document.createElement('span');
    // Giây đỏ: giữ trên chính ô chứ không trên lớp cha, để hai ô giây đổi màu cùng lúc với lúc quay.
    cellHost.className = index >= SECONDS_FROM ? 'dg is-seconds' : 'dg';
    cellHost.setAttribute('aria-hidden', 'true');

    const now = document.createElement('span');
    now.className = 'dg__now';
    now.textContent = '0';
    const next = document.createElement('span');
    next.className = 'dg__next';

    cellHost.append(now, next);
    host.append(cellHost);
    cells.push({ host: cellHost, now, next, timer: null });

    if (SEPARATOR_AFTER.has(index)) {
      const sep = document.createElement('span');
      sep.className = 'dg-sep';
      sep.textContent = ':';
      sep.setAttribute('aria-hidden', 'true');
      host.append(sep);
    }
  }

  let first = true;

  const commit = (cell: Cell, value: string): void => {
    if (cell.timer !== null) {
      window.clearTimeout(cell.timer);
      cell.timer = null;
    }
    // Cắt transition trước khi đặt lại, nếu không ô vừa quay trượt ngược về chỗ cũ và mắt thấy số
    // nhảy hai lần cho một giây.
    cell.host.classList.add('dg--jump');
    cell.host.classList.remove('dg--rolling');
    cell.now.textContent = value;
    cell.next.textContent = '';
    // Đọc lại một thuộc tính để trình duyệt áp `transition: none` ngay, rồi mới bật lại transition.
    void cell.host.offsetHeight;
    cell.host.classList.remove('dg--jump');
  };

  return {
    update(digits: readonly string[]): void {
      const animate = !first && !prefersReducedMotion();
      first = false;
      for (let index = 0; index < CELLS; index += 1) {
        const cell = cells[index];
        const value = digits[index];
        if (!cell || value === undefined) continue;
        if (cell.now.textContent === value) continue;
        if (!animate) {
          commit(cell, value);
          continue;
        }
        cell.next.textContent = value;
        cell.host.classList.add('dg--rolling');
        cell.timer = window.setTimeout(() => commit(cell, value), durationMs);
      }
    },
  };
}
