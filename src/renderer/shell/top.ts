/**
 * Top bar. It may read status and post the clock, but it cannot navigate or open anything.
 *
 * Two things shape this file. First, every glyph comes from `icons.ts` (Lucide, ISC): the markup
 * carries empty `[data-icon]` slots and this module fills them, so no path string is written twice.
 * Second, nothing here may move the layout — a control that disappears must keep its slot
 * (`.is-hidden` keeps the box and drops the paint), because a strip that reflows under a finger is
 * how a zoom tap ends up on the destructive control (nhật ký #123).
 */
import { ICONS, icon, type IconName } from './icons.js';

// The speaker is its own unit: it paints its own muted state and opens the "NTF volume" window.
// Pulled in as a side effect so this file stays about the bar; the module self-disables when
// `#btn-volume` is absent.
import './volume.js';


/** Top bar. It may read status and post the clock, but it cannot navigate or open anything. */
const chrome = window.ntfChrome;
if (!chrome) throw new Error('ntfChrome bridge missing');

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const isIconName = (name: string): name is IconName => Object.prototype.hasOwnProperty.call(ICONS, name);

// Fill every slot once, before anything can toggle visibility: a slot left empty would reserve its
// box and paint nothing, which reads as a blank button rather than a missing icon.
for (const slot of document.querySelectorAll<HTMLElement>('[data-icon]')) {
  const name = slot.dataset.icon ?? '';
  if (!isIconName(name)) {
    console.warn(`top: unknown icon "${name}"`);
    continue;
  }
  slot.innerHTML = icon(name);
}

const titleEl = $('title');
const spinner = $('spinner');
const statusEl = $('status');
const warnEl = $('warn-text');
const retryBtn = $<HTMLButtonElement>('btn-retry');
const netEl = $('stat-net');
const netName = $('net-name');
const tempEl = $('stat-temp');
const tempVal = $('temp-val');
const timeEl = $('clock-time');
const secEl = $('clock-sec');
const dateEl = $('clock-date');
const backBtn = $<HTMLButtonElement>('btn-back');
const reloadBtn = $<HTMLButtonElement>('btn-reload');
const homeBtn = $<HTMLButtonElement>('btn-home');
const minBtn = $<HTMLButtonElement>('btn-min');
const closeBtn = $<HTMLButtonElement>('btn-close');
const goHomeBtn = $<HTMLButtonElement>('btn-go-home');
const exitBtn = $<HTMLButtonElement>('btn-exit-app');


/**
 * Vẽ đồng hồ thanh trên. Giờ, phút và giây cùng đến từ một lần đọc (`status`), nên ba mặt đồng hồ trên
 * máy không thể lệch nhau. Trước đây chỉ có `time` (HH:MM) và không có giây ở đâu cả.
 */
const paintClock = (status: { time: string; seconds: string; date: string }): void => {
  timeEl.textContent = status.time;
  secEl.textContent = status.seconds;
  dateEl.textContent = status.date;
};

chrome.onClock((status) => {
  paintClock(status);
  const online = status.network !== '';
  netEl.classList.toggle('off', !online);
  netName.textContent = online ? (status.wired ? status.network : `${status.network} ${status.signal}%`) : 'Ngoại tuyến';
  // A missing sensor is not a failure: the slot keeps its width and drops to `visibility:hidden`, so
  // the volume and zoom clusters to its right never shift by the width of a temperature.
  const hasTemp = status.cpuTemp >= 0;
  tempEl.classList.toggle('is-empty', !hasTemp);
  tempEl.setAttribute('aria-hidden', hasTemp ? 'false' : 'true');
  tempVal.textContent = hasTemp ? `${status.cpuTemp}°C` : '';
});

void chrome.getClock().then(paintClock);

// The top bar intentionally does not subscribe to ntf:dock — the dock owns the active state and
// the top bar only needs the page title, which arrives on ntf:top-state from the main process.
interface TopState {
  title: string;
  loading: boolean;
  failed: boolean;
  description: string;
  /** F16: có băng nội dung hoặc app ngoài phía sau thanh trên hay không. */
  inContent?: boolean;
}

const ipcTop = window.ntfTop;

/**
 * Shows or hides a bar element without moving anything. `[hidden]` is useless here: the author
 * rules (`.status{display:flex}`, `.btn{display:inline-flex}`) outrank the UA `[hidden]` rule, so
 * the attribute silently did nothing and every "hidden" element stayed on screen anyway.
 */
const setShown = (el: HTMLElement, shown: boolean): void => {
  el.classList.toggle('is-hidden', !shown);
  el.setAttribute('aria-hidden', shown ? 'false' : 'true');
};

ipcTop?.onState?.((state) => {
  const typed = state as TopState;
  titleEl.textContent = typed.title || 'Trang chủ';
  setShown(spinner, typed.loading);
  setShown(statusEl, typed.failed);
  setShown(retryBtn, typed.failed);
  warnEl.textContent = typed.failed ? typed.description : '';
  // F16: trên Home thuần thì không có gì để quay về lẫn để đóng, nên hai nút này ẩn đi. Chúng ẩn
  // bằng `visibility`/`pointer-events` (`.is-hidden`) chứ không phải `display:none`, nên cụm đồng hồ
  // không dịch một pixel nào khi chúng xuất hiện lại.
  setShown(goHomeBtn, Boolean(typed.inContent));
  setShown(exitBtn, Boolean(typed.inContent));
  backBtn.disabled = false;
  // NTF-R10: không còn `#zoom-label` nào trên dải để mà tranh chấp. Cỡ chữ giờ do thẻ "NTF zoom" đọc
  // thẳng bằng `chrome:get-zoom`, nên chỉ có đúng một người viết vào một chỗ.
});

/**
 * Surfaces a rejected action in the bar's status slot. The slot is shared with page failures, so the
 * message is distinguished by `.is-alert` rather than by a second row that would change the height.
 */
const reportFailure = (message: string): void => {
  warnEl.textContent = message;
  statusEl.classList.add('is-alert');
  setShown(statusEl, true);
  setShown(retryBtn, true);
};

/**
 * "Thử lại" phải nạp lại **đúng trang vừa lỗi** (NTF-R03). Trước đây nút này bấm `{type:'home'}`
 * nên mạng có trở lại thì người dùng vẫn bị đẩy về Home và mất trang đang xem. `chrome.reload()` chỉ
 * là phương án dự phòng cho cầu nối cũ không có kênh tải lại.
 */
retryBtn.addEventListener('click', () => {
  statusEl.classList.remove('is-alert');
  if (typeof chrome.reload === 'function') chrome.reload();
  else chrome.press({ type: 'home' });
});

// Back and Reload are the two controls a visitor reaches for mid-video, so they stay on the strip
// as their own channels rather than being routed through the dock.
backBtn.addEventListener('click', () => chrome.back());
reloadBtn.addEventListener('click', () => chrome.reload());

// The logo doubles as Home: the bar carries no launcher row of its own, so the brand is the
// shortcut every visitor already tries.
homeBtn.addEventListener('click', () => chrome.press({ type: 'home' }));

// "Quay lại" is the visitor-facing Home: the same channel the brand uses, spelled out as a word so
// someone who has never seen the strip can find it. `goHome()` exists for this on TopApi; falling
// back to the dock's press channel keeps the button alive on a bridge that predates it.
goHomeBtn.addEventListener('click', () => {
  if (typeof ipcTop?.goHome === 'function') ipcTop.goHome();
  else chrome.press({ type: 'home' });
});

// "Đóng ứng dụng" đóng đúng app đang ở phía trước trong một lần chạm (NTF-R09): trang nhúng thì
// dừng media và gỡ view, app ngoài thì chỉ đóng cửa sổ/tiến trình của app đó và giữ app còn lại.
// Tuyệt đối không hỏi phiên và không xóa dữ liệu duyệt web — đó là hành động quản trị riêng, chỉ
// còn một chỗ duy nhất là tile "Kết thúc phiên" ở dock.
exitBtn.addEventListener('click', () => {
  if (exitBtn.disabled) return;
  if (typeof ipcTop?.closeFrontApp !== 'function') {
    reportFailure('Không đóng được: thiếu kênh đóng app');
    return;
  }
  exitBtn.disabled = true;
  void ipcTop
    .closeFrontApp()
    .catch(() => reportFailure('Không đóng được ứng dụng'))
    .finally(() => {
      exitBtn.disabled = false;
    });
});

// Kiosk window controls. Cage has no window manager, so `minimize()` does nothing and there is
// nothing to close to — `—` drops the current app back to Home (it stays in the dock) and `✕` is the
// same "close the app in front" as the frame's ✕ and the labelled button above, so every ✕ on screen
// means one thing.
minBtn.addEventListener('click', () => chrome.press({ type: 'home' }));
// The ✕ on the strip and the ✕ on the frame both mean "close the app in front", so both run the
// same one-tap path and both are guarded: a second tap while the first is still closing used to
// queue a second `chrome:close-app`, and the second one found nothing to close and fell through to
// the embedded-content teardown — i.e. a double tap also dropped the kiosk behind the app.
let closing = false;
closeBtn.addEventListener('click', () => {
  if (closing) return;
  if (typeof ipcTop?.closeFrontApp !== 'function') {
    chrome.press({ type: 'home' });
    return;
  }
  closing = true;
  void ipcTop
    .closeFrontApp()
    .catch(() => undefined)
    .finally(() => {
      closing = false;
    });
});

// The three windows of the bar — settings, text size and power — all go through `openPanel` rather
// than `chrome.press`: `press` replays a dock destination and would leave the bar showing the wrong
// active state.
const settingsBtn = $<HTMLButtonElement>('btn-settings');
const zoomBtn = $<HTMLButtonElement>('btn-zoom');
const powerBtn = $<HTMLButtonElement>('btn-power');

settingsBtn.addEventListener('click', () => ipcTop?.openPanel('settings'));
zoomBtn.addEventListener('click', () => ipcTop?.openPanel('zoom'));
powerBtn.addEventListener('click', () => ipcTop?.openPanel('power'));
