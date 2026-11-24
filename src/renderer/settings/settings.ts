/**
 * Thẻ Cài đặt — trang.
 *
 * Hai nhóm, mỗi nhóm một câu hỏi: sau bao lâu thì vào màn hình chờ, và có giữ máy thức khi đang phát
 * media không. Trang này cố tình **không** tự quyết định gì: mọi giá trị hợp lệ đều do main process
 * trả về (`chrome:get-panel-policy` / `chrome:set-panel-policy`), và trang chỉ vẽ lại đúng thứ main
 * trả. Nhờ vậy một danh sách giờ chờ bị sửa trong `shared/settings.ts` sẽ tự động hiện ra đây mà
 * không phải sửa hai nơi — trang đọc `IDLE_CHOICES_MS` chứ không viết cứng sáu con số.
 *
 * Không còn nhóm mã PIN. Mã dùng cho menu Nguồn là **mật khẩu sudo của máy** (xem `main/sudo-check.ts`),
 * nên không có gì để đặt, đổi hay bỏ ở đây — và cũng không có giá trị nào trong tệp cấu hình ứng dụng
 * liên quan tới nó.
 */

import { IDLE_CHOICES_MS } from '../../shared/settings.js';
import type { PanelPolicy } from '../../shared/panel.js';
import { renderAdblock } from './adblock-panel.js';

const api = window.ntfSettings;

/** Nhãn cho sáu lựa chọn. `0` là tắt, không phải "0 phút" — nên nó phải có chữ riêng. */
function idleLabel(ms: number): string {
  if (ms <= 0) return 'Tắt';
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes} phút` : `${Math.round(minutes / 60)} giờ`;
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`thẻ Cài đặt thiếu phần tử #${id}`);
  return element as T;
}

const choicesBox = byId('idle-choices');
const keepAwakeBtn = byId<HTMLButtonElement>('keep-awake');
const keepAwakeLabel = byId('keep-awake-label');
const saveBtn = byId<HTMLButtonElement>('save');
const statusEl = byId('status');
const closeBtn = byId<HTMLButtonElement>('close');
const toastEl = byId('toast');

/** Trạng thái đã đọc từ main; dùng để định dạng lại sau khi lưu. */
let current: PanelPolicy | null = null;
/** Giá trị đang sửa, chưa ghi. */
let idleDraft = 0;
let keepDraft = false;

let toastTimer = 0;

function toast(message: string, isError = false): void {
  toastEl.textContent = message;
  toastEl.classList.toggle('is-error', isError);
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true;
  }, 2_400);
}

function setStatus(message: string, ok = false): void {
  statusEl.textContent = message;
  statusEl.classList.toggle('is-ok', ok);
}

/**
 * Vẽ lại toàn bộ từ một `PanelPolicy`. Gọi sau mỗi lần main trả lời — kể cả khi lưu thất bại, vì lúc
 * đó main trả trạng thái **cũ**, nên màn hình tự quay về đúng thực tế thay vì giữ giá trị người dùng
 * vừa chọn mà máy không nhận.
 */
function render(policy: PanelPolicy): void {
  current = policy;
  idleDraft = policy.idleTimeoutMs;
  keepDraft = policy.keepAwakeOnMedia;

  for (const button of choicesBox.querySelectorAll<HTMLButtonElement>('.choice')) {
    const value = Number(button.dataset.ms ?? '0');
    button.setAttribute('aria-checked', value === idleDraft ? 'true' : 'false');
  }

  keepAwakeBtn.setAttribute('aria-checked', keepDraft ? 'true' : 'false');
  keepAwakeLabel.textContent = keepDraft ? 'Bật' : 'Tắt';

  setStatus(idleDraft <= 0 ? 'Màn hình chờ đang tắt' : `Màn hình chờ sau ${idleLabel(idleDraft)}`);
}

/** Dựng sáu ô lựa chọn từ danh sách của `shared/settings.ts`, không viết cứng trong HTML. */
function buildChoices(): void {
  choicesBox.replaceChildren();
  for (const ms of IDLE_CHOICES_MS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'choice';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', 'false');
    button.dataset.ms = String(ms);
    button.textContent = idleLabel(ms);
    button.addEventListener('click', () => {
      idleDraft = ms;
      for (const other of choicesBox.querySelectorAll<HTMLButtonElement>('.choice')) {
        other.setAttribute('aria-checked', other === button ? 'true' : 'false');
      }
      setStatus('Có thay đổi chưa lưu');
    });
    choicesBox.append(button);
  }
}

keepAwakeBtn.addEventListener('click', () => {
  keepDraft = !keepDraft;
  keepAwakeBtn.setAttribute('aria-checked', keepDraft ? 'true' : 'false');
  keepAwakeLabel.textContent = keepDraft ? 'Bật' : 'Tắt';
  setStatus('Có thay đổi chưa lưu');
});

saveBtn.addEventListener('click', () => {
  if (!current) return;
  saveBtn.disabled = true;
  setStatus('Đang lưu…');
  void api
    .savePolicy({ idleTimeoutMs: idleDraft, keepAwakeOnMedia: keepDraft })
    .then((policy) => {
      render(policy);
      setStatus('Đã lưu', true);
      toast('Đã lưu cài đặt');
    })
    .catch(() => {
      setStatus('Không lưu được');
      toast('Không lưu được cài đặt', true);
    })
    .finally(() => {
      saveBtn.disabled = false;
    });
});

closeBtn.addEventListener('click', () => api.close());

/* Esc đóng thẻ. Không còn bàn phím số nào để "hủy nhập" trước, nên chỉ còn một nhánh. */
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') api.close();
});

function refresh(): Promise<void> {
  return api
    .getPolicy()
    .then(render)
    .catch(() => setStatus('Không đọc được cài đặt hiện tại'));
}

buildChoices();
void refresh();
// Số liệu chặn quảng cáo không chặn được thẻ: nếu timer chưa cài thì khối này hiện "—" và phần còn
// lại của thẻ vẫn dùng được bình thường.
void api.getAdblock().then(renderAdblock).catch(() => undefined);