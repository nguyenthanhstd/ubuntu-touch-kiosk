/**
 * Thẻ Cỡ chữ — trang.
 *
 * Bốn mức, mỗi mức một nút, không có nút ±. Lý do: `ViewManager.stepZoom()` chỉ kẹp theo độ dài
 * `ZOOM_ORDER`, nên muốn tới được mức thứ tư (200 %) bằng nút + thì người dùng phải bấm ba lần và
 * không có cách nào nhảy thẳng. Bốn nút làm mọi mức tới được trong đúng một cú chạm.
 *
 * Trang này không tự quyết định mức nào hợp lệ: nó vẽ `ZOOM_ORDER` từ `shared/services.ts` và ghi
 * đúng thứ main trả về. Nếu ai đó thêm mức thứ năm, thẻ này tự có năm nút.
 */

import { ZOOM_FACTORS, ZOOM_LABELS, ZOOM_ORDER, type ZoomLevel } from '../../shared/services.js';
import { icon } from '../shell/icons.js';

const api = window.ntfZoom;

/** Cỡ chữ mẫu "Aa" cho từng mức, tính từ hệ số thật để nhìn là biết mức nào lớn hơn bao nhiêu. */
const SAMPLE_PX = 22;

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`thẻ Cỡ chữ thiếu phần tử #${id}`);
  return element as T;
}

const levelsBox = byId('levels');
const scopeEl = byId('scope');
const statusEl = byId('status');
const closeBtn = byId<HTMLButtonElement>('close');

byId('head-glyph').innerHTML = icon('zoomIn');

/** Mức đang áp dụng; `null` khi ở Home — không có trang nào để phóng. */
let current: ZoomLevel | null = null;

function setStatus(message: string, tone: 'alert' | 'ok' | 'idle' = 'idle'): void {
  statusEl.textContent = message;
  statusEl.classList.toggle('is-alert', tone === 'alert');
  statusEl.classList.toggle('is-ok', tone === 'ok');
}

/**
 * Vẽ lại theo mức hiện tại.
 *
 * `null` không phải "chưa đọc được" mà là "đang ở Home": bốn nút bị khoá hẳn chứ không chỉ mờ, vì một
 * nút bấm được mà không có tác dụng thì người dùng bấm lại nhiều lần.
 */
function render(level: ZoomLevel | null): void {
  current = level;
  const home = level === null;
  scopeEl.textContent = home ? 'Mở một trang để đổi cỡ chữ' : 'Đang áp dụng cho trang đang mở';
  for (const button of levelsBox.querySelectorAll<HTMLButtonElement>('.level')) {
    button.disabled = home;
    button.setAttribute('aria-checked', button.dataset.level === level ? 'true' : 'false');
  }
  setStatus(home ? '' : `Cỡ hiện tại: ${ZOOM_LABELS[level]}`);
}

function buildLevels(): void {
  levelsBox.replaceChildren();
  for (const level of ZOOM_ORDER) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'level';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', 'false');
    button.dataset.level = level;

    const sample = document.createElement('span');
    sample.className = 'level__sample';
    sample.textContent = 'Aa';
    // Nhân hệ số thật thay vì viết bốn cỡ tay: mẫu phải khớp với cái trang thật sự nhận.
    sample.style.fontSize = `${Math.round(SAMPLE_PX * ZOOM_FACTORS[level])}px`;

    const label = document.createElement('span');
    label.className = 'level__label';
    label.textContent = ZOOM_LABELS[level];

    const percent = document.createElement('span');
    percent.className = 'level__percent';
    percent.textContent = `${Math.round(ZOOM_FACTORS[level] * 100)}%`;

    button.append(sample, label, percent);
    button.addEventListener('click', () => void apply(level));
    levelsBox.append(button);
  }
}

/**
 * Ghi một mức và vẽ lại theo đúng thứ main trả.
 *
 * Main trả `null` khi không có trang nào đang hiện — kể cả khi nút vừa bấm trông như đã bấm được
 * (trang vừa bị đóng giữa hai lần vẽ). Tin vào giá trị trả về chứ không tin vào `level` vừa gửi là
 * cách duy nhất để màn hình không nói dối.
 */
async function apply(level: ZoomLevel): Promise<void> {
  if (level === current) return;
  setStatus('Đang đổi…');
  try {
    render(await api.setZoom(level));
    if (current !== null) setStatus(`Đã đổi sang ${ZOOM_LABELS[current]}`, 'ok');
  } catch {
    setStatus('Không đổi được cỡ chữ', 'alert');
  }
}

closeBtn.addEventListener('click', () => api.close());

/* Esc đóng thẻ — đường phím tắt cho bàn phím USB và cho `wtype` khi kiểm từ xa. */
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') api.close();
});

buildLevels();
void api
  .getZoom()
  .then(render)
  .catch(() => setStatus('Không đọc được cỡ chữ hiện tại', 'alert'));