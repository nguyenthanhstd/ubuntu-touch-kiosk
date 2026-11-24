/**
 * Thẻ Nguồn — bốn hành động, ba trong đó hỏi mã.
 *
 * Luồng có đúng **một** dạng: bấm một nút phá huỷ → bàn phím số mở → gõ mã → tiến trình chính kiểm
 * bằng `sudo -S -v` rồi mới hành động. Không có nhánh "chưa đặt mã" và không có bước trung gian "đã mở
 * khoá": mã là mật khẩu sudo của máy, nên nó luôn tồn tại và không có gì để đặt trước.
 *
 * Vì sao `pending` chỉ là một con trỏ hàm: `CodePad` không biết nó đang phục vụ khởi động lại hay tắt
 * máy — nó chỉ gom chữ số. Ngữ cảnh (gọi hàm nào của cầu nối) nằm ở đây, đúng một chỗ.
 */

import type { PowerResult } from '../../shared/panel.js';
import { icon } from '../shell/icons.js';
import { CodePad } from './code-pad.js';
import { byId, createStatusSlot, markBusy, settle } from './power-status.js';

const bridge = window.ntfPower;

const note = byId<HTMLParagraphElement>('note');
const setStatus = createStatusSlot(byId<HTMLElement>('status'));

const lockBtn = byId<HTMLButtonElement>('act-lock');
const restartBtn = byId<HTMLButtonElement>('act-restart');
const shutdownBtn = byId<HTMLButtonElement>('act-shutdown');
const exitBtn = byId<HTMLButtonElement>('act-exit');
const closeBtn = byId<HTMLButtonElement>('close');

/** Glyph Lucide: `power`, `lock`, `rotate-ccw`, `power-off`, `terminal`. */
const GLYPHS: ReadonlyArray<readonly [string, 'power' | 'lock' | 'rotateCcw' | 'powerOff' | 'terminal']> = [
  ['head-glyph', 'power'],
  ['glyph-lock', 'lock'],
  ['glyph-restart', 'rotateCcw'],
  ['glyph-shutdown', 'powerOff'],
  ['glyph-exit', 'terminal'],
];

for (const [id, name] of GLYPHS) byId<HTMLElement>(id).innerHTML = icon(name);

/** Câu chữ của ba hành động phá huỷ, cùng một hình dạng để một luồng xử lý dùng chung. */
const POWER_TEXT = {
  restart: {
    busy: 'Đang khởi động lại…',
    wait: 'Máy sẽ khởi động lại. Ứng dụng tự chạy lại khi máy lên.',
    idle: 'Khởi động lại máy',
  },
  shutdown: {
    busy: 'Đang tắt máy…',
    wait: 'Máy sẽ tắt hẳn. Bật lại bằng nút nguồn trên máy.',
    idle: 'Tắt nguồn hoàn toàn',
  },
  exit: {
    busy: 'Đang thoát…',
    wait: 'Kiosk sẽ tắt cho tới khi có người bật lại từ console.',
    idle: 'Cần mã quản trị',
  },
} as const;

type PowerKind = keyof typeof POWER_TEXT;

/** Hành động sẽ chạy với mã vừa gõ. `null` khi bàn phím đóng. */
let pending: ((code: string) => Promise<PowerResult>) | null = null;
/** Nút đang chờ, để trả lại trạng thái bấm được khi mã sai. */
let armed: { button: HTMLButtonElement; kind: PowerKind } | null = null;

const pad = new CodePad({
  root: byId('codepad'),
  dots: byId('code-dots'),
  keys: byId('code-keys'),
  title: byId('codepad-title'),
  hint: byId('codepad-hint'),
  cancel: byId<HTMLButtonElement>('code-cancel'),
  submit: byId<HTMLButtonElement>('code-submit'),
  // Mã đúng thì hành động chạy ngay trong lời gọi này, nên kết quả trả về đã là kết quả cuối. Mã sai
  // thì `PowerResult` mang câu "Sai mã" và bàn phím vẫn mở (xem `CodePad.advance()`).
  send: async (code) => {
    if (!pending) return { ok: false, message: 'Không rõ cần làm gì với mã này' };
    return pending(code);
  },
  onResult: (result) => {
    if (result.ok) {
      // Thành công thì máy đang tắt/thoát dần; cố tình không trả nút về trạng thái bấm được để không ai
      // bấm hai lần vào cùng một lệnh.
      setStatus('Đã xác thực — đang thực hiện…', 'ok');
      pending = null;
      return;
    }
    // Sai mã thì bàn phím vẫn mở và mời gõ lại (xem `CodePad.advance()`), nên `pending` **phải** còn
    // nguyên. Xoá nó ở đây là bịt đường thử lại: lần gõ sau rơi vào nhánh `!pending` và báo "Không rõ
    // cần làm gì", còn bộ đếm sai thì không bao giờ tới ngưỡng chặn.
    setStatus(result.message, 'alert');
    if (armed) settle(armed.button, POWER_TEXT[armed.kind].idle);
  },
});

/**
 * Mở bàn phím cho một hành động.
 *
 * Không có nhánh rẽ theo trạng thái "đã có mã chưa" như bản PIN trước đây: mã sudo luôn tồn tại với
 * một máy đã cài, nên mọi lần bấm đều là một lần hỏi.
 */
function ask(kind: PowerKind, button: HTMLButtonElement): void {
  if (pad.isOpen) return;
  setStatus('');
  armed = { button, kind };
  note.textContent = POWER_TEXT[kind].wait;
  markBusy(button, POWER_TEXT[kind].busy);
  pending = (code) => {
    if (kind === 'exit') return bridge.exitToConsole(code);
    return kind === 'restart' ? bridge.restart(code) : bridge.shutdown(code);
  };
  pad.open();
}

lockBtn.addEventListener('click', () => {
  // Không hỏi mã: màn hình chờ không phá gì và không rời ứng dụng. Cửa sổ này bị ẩn ngay khi nó bật,
  // nên cũng không `await`.
  bridge.lock();
});

restartBtn.addEventListener('click', () => ask('restart', restartBtn));
shutdownBtn.addEventListener('click', () => ask('shutdown', shutdownBtn));
exitBtn.addEventListener('click', () => ask('exit', exitBtn));

closeBtn.addEventListener('click', () => bridge.close());

/**
 * Esc đóng bàn phím nếu nó đang mở, hoặc đóng thẻ.
 *
 * Bàn phím vật lý có thể cắm vào máy này (bàn phím USB, hoặc `wtype` từ xa), nên đường phím tắt không
 * phải trang trí. Đóng bàn phím bằng Esc phải trả lại nút đang chờ về trạng thái bấm được — nếu không
 * thì lần sau bấm vào nút đó không có gì xảy ra.
 */
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (pad.isOpen) {
    pad.close();
    if (armed) settle(armed.button, POWER_TEXT[armed.kind].idle);
    armed = null;
    pending = null;
    return;
  }
  bridge.close();
});