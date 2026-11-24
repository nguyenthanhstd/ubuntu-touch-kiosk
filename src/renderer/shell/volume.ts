/**
 * Nút loa trên thanh trên.
 *
 * Bảng trượt đã rời khỏi đây và trở thành cửa sổ `NTF volume` (`renderer/volume-panel/`). Lý do là
 * hình học, không phải thẩm mỹ: dải trên là một `WebContentsView` cao đúng 44 px (`TOP_BAR_CSS`), và
 * mọi thứ vẽ ra ngoài dải bị **view** cắt chứ không phải CSS cắt — bảng cũ phải mở ngang sang trái để
 * còn nằm trong 44 px đó. Yêu cầu "ra giữa màn hình phía trên, dưới đồng hồ, to ra" không thể thoả
 * trong lòng dải, chỉ một cửa sổ riêng mới làm được.
 *
 * Tệp này còn lại đúng hai việc: vẽ glyph loa cho biết trạng thái tắt tiếng, và mở thẻ.
 */
import type { VolumeState } from '../../shared/ipc.js';
import { icon } from './icons.js';

const trigger = document.getElementById('btn-volume') as HTMLButtonElement | null;
const bridge = window.ntfTop;

/**
 * Glyph loa mang luôn trạng thái tắt tiếng.
 *
 * Trên dải 44 px không có chỗ cho một glyph thứ hai, nên "đang tắt tiếng" phải hiện ra bằng chính
 * glyph loa và bằng màu cảnh báo — đây là thứ khách phải thấy được từ khoảng cách đứng trước màn hình.
 */
function paint(state: VolumeState): void {
  if (!trigger) return;
  const slot = trigger.querySelector('.ico');
  const percent = Math.round(state.level * 100);
  const silent = state.muted || percent === 0;
  const name = silent ? 'volumeX' : 'volume2';
  if (slot && slot.getAttribute('data-glyph') !== name) {
    slot.setAttribute('data-glyph', name);
    slot.innerHTML = icon(name);
  }
  trigger.classList.toggle('is-muted', silent);
  trigger.title = state.muted ? 'Âm lượng — đang tắt tiếng' : `Âm lượng — ${percent}%`;
  trigger.setAttribute('aria-label', trigger.title);
}

if (trigger) {
  trigger.addEventListener('click', () => {
    bridge?.openPanel('volume');
  });

  // Đọc một lần lúc khởi động để glyph đã đúng trước khi ai chạm vào. Không đọc lại sau đó: thẻ
  // Âm lượng là nơi duy nhất đổi mức, và nó vẽ glyph của chính nó.
  void bridge
    ?.getVolume()
    .then(paint)
    .catch((error: unknown) => {
      console.warn('[volume] không đọc được âm lượng:', error);
    });
}

export {};
