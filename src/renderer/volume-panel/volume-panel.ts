import type { VolumeState } from '../../shared/ipc.js';
import { icon, type IconName } from '../shell/icons.js';
import { createVolumeWriter } from '../shell/volume-writer.js';

/**
 * Trang thẻ Âm lượng.
 *
 * Toàn bộ phần chống đua nằm trong `volume-writer.ts` — tệp này chỉ vẽ và bắt tay.
 *
 * Vì sao không phải một popup trong thanh trên nữa: dải trên là một `WebContentsView` cao 44 px nên
 * mọi thứ nó vẽ ra ngoài khung đó bị chính *view* cắt, không phải bởi CSS. Bảng cũ vì thế phải mở
 * sang bên trái. Yêu cầu "ra giữa màn hình phía trên, dưới đồng hồ, to ra" chỉ thoả được bằng một
 * cửa sổ riêng.
 */

/** Bước của hai nút +/−, tính theo phần trăm. */
const STEP_PERCENT = 5;

/**
 * Chặn trên của `level` khi backend trả về số lạ.
 *
 * `wpctl` trả 0..1, nhưng `PA_VOLUME` cho phép vượt 1 (âm thanh khuếch đại), và một lần ghi 1.4 mà
 * vẫn vẽ ở 140% thì thanh kéo tràn khỏi rãnh. Nhãn giữ 100% là mức "to nhất bình thường"; phần vượt
 * vẫn được tôn trọng ở backend nhưng không hiển thị.
 */
const MAX_PERCENT = 100;

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`volume-panel: thiếu #${id}`);
  return element as T;
}

const card = byId('card');
const range = byId<HTMLInputElement>('range');
const levelValue = byId('level-value');
const sinkName = byId('sink-name');
const stepDown = byId<HTMLButtonElement>('step-down');
const stepUp = byId<HTMLButtonElement>('step-up');
const mute = byId<HTMLButtonElement>('mute');
const muteLabel = byId('mute-label');
const status = byId('status');
const closeBtn = byId<HTMLButtonElement>('close');

const glyphs: ReadonlyArray<readonly [string, IconName]> = [
  ['head-glyph', 'volume2'],
  ['glyph-minus', 'minus'],
  ['glyph-plus', 'plus'],
  ['glyph-mute', 'volumeX'],
];
for (const [slot, name] of glyphs) {
  const host = document.getElementById(slot);
  if (host) host.innerHTML = icon(name);
}

/** Ngón đang đặt trên thanh kéo. `volume-writer` hỏi cờ này trước khi áp một lần đọc. */
let dragging = false;

/**
 * Giá trị đang hiển thị, tách khỏi `range.value`.
 *
 * Hai nguồn: ngón tay ghi vào `range`, backend ghi vào đây qua `render`. Khi cả hai cùng chạy trong
 * một khung hình thì ngón tay thắng — nếu không, trả lời của lần ghi trước sẽ kéo cần gạt ngược lại
 * dưới ngón đang kéo.
 */
let livePercent = 0;

function paint(percent: number, muted: boolean): void {
  const clamped = Math.max(0, Math.min(MAX_PERCENT, Math.round(percent)));
  livePercent = clamped;
  levelValue.textContent = String(clamped);
  range.value = String(clamped);
  range.style.setProperty('--volume-fill', `${clamped}%`);
  range.setAttribute('aria-valuetext', `${clamped} phần trăm`);
  card.classList.toggle('is-muted', muted);
  stepDown.disabled = clamped <= 0;
  stepUp.disabled = clamped >= MAX_PERCENT;
}

function render(state: VolumeState): void {
  // `level` là 0..1. `muted` hiển thị riêng: một sink đang tắt tiếng vẫn giữ mức cũ, nên nếu vẽ mức
  // thành 0 thì nhấc tắt tiếng sẽ mất mức đã đặt.
  const percent = Number.isFinite(state.level) ? state.level * 100 : 0;
  paint(percent, state.muted);
  sinkName.textContent = state.sink;
  sinkName.title = state.sink;
  mute.setAttribute('aria-pressed', state.muted ? 'true' : 'false');
  muteLabel.textContent = state.muted ? 'Bật tiếng' : 'Tắt tiếng';
  setStatus('');
}

function setStatus(text: string, alert = false): void {
  status.textContent = text;
  status.classList.toggle('is-alert', alert && text !== '');
}

const bridge = window.ntfVolume;
const writer = createVolumeWriter({
  bridge,
  render,
  isDragging: () => dragging,
  onUnavailable: () => setStatus('Không đọc được âm lượng', true),
  onError: (error: unknown) => {
    setStatus('Không ghi được âm lượng', true);
    // Nội dung lỗi chỉ vào log: thông điệp của `wpctl` có thể chứa tên thiết bị của khách.
    console.error('[volume] lỗi', error);
  },
});

/**
 * Ghi mức mới từ một cú chạm trực tiếp (nút +/−), không phải từ cần gạt.
 *
 * Cần gạt đã tự ghi qua `writePercent`; hai nút này phải tự tính mức kế tiếp rồi cũng đẩy qua cùng
 * đường đó, để mọi lần ghi vẫn đi qua một bộ tuần tự hoá duy nhất.
 */
function step(delta: number): () => void {
  return () => {
    const next = Math.max(0, Math.min(MAX_PERCENT, livePercent + delta));
    if (next === livePercent) return;
    paint(next, card.classList.contains('is-muted') && next === 0);
    writer.writePercent(next);
    writer.settle();
  };
}

stepDown.addEventListener('click', step(-STEP_PERCENT));
stepUp.addEventListener('click', step(STEP_PERCENT));

// `input` là sự kiện có thật trên thiết bị chạm: nó bắn trong lúc ngón còn trên rãnh. `change` chỉ
// bắn lúc nhấc ngón, nên dùng `change` để biết cú kéo đã xong.
range.addEventListener('input', () => {
  dragging = true;
  const percent = Number(range.value);
  paint(percent, card.classList.contains('is-muted') && percent === 0);
  writer.writePercent(percent);
});

/**
 * Nhấc ngón.
 *
 * Nghe trên `window` chứ không trên `range`: ngón có thể trượt ra ngoài rãnh rồi mới nhấc, và khi đó
 * `change` của phần tử không bắn — cần gạt sẽ kẹt ở `dragging = true` và mọi lần đọc sau bị bỏ qua.
 */
function endDrag(): void {
  if (!dragging) return;
  dragging = false;
  writer.settle();
}

range.addEventListener('change', endDrag);
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);
window.addEventListener('blur', endDrag);

mute.addEventListener('click', () => {
  writer.toggleMute();
  // Nhãn và glyph đổi ngay trong khung hình của ngón tay; `render` sau đó xác nhận lại.
  const next = mute.getAttribute('aria-pressed') !== 'true';
  card.classList.toggle('is-muted', next);
  mute.setAttribute('aria-pressed', next ? 'true' : 'false');
  muteLabel.textContent = next ? 'Bật tiếng' : 'Tắt tiếng';
});

function close(): void {
  void bridge.close();
}

closeBtn.addEventListener('click', close);

window.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
    return;
  }
  // Không có ô nhập chữ nào trên thẻ này, nên phím mũi tên trái/phải là để chỉnh âm lượng — thói
  // quen của bàn phím rời khi ai đó cắm vào panel để bảo trì.
  if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
    event.preventDefault();
    step(-STEP_PERCENT)();
  } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
    event.preventDefault();
    step(STEP_PERCENT)();
  }
});

paint(0, false);
setStatus('Đang đọc…');
writer.read();
