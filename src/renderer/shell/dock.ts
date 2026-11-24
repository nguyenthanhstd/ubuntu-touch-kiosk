/**
 * Dock — cơ chế chạm, không phải bảng dữ liệu.
 *
 * Mỗi ô là một hành động bấm; tiến trình chính kiểm lại nó với `DOCK_ORDER` trước khi làm gì, nên
 * tệp này không quyết định cú bấm đi đâu ngoài việc gọi tên nó. Bảng ô nằm ở `dock-items.ts` (tầng
 * ① dữ liệu); ở đây chỉ có dựng phần tử, gắn chạm và phản hồi bằng hiệu ứng.
 */
import type { DockAction } from '../../shared/chrome.js';
import { DOCK_ITEMS } from './dock-items.js';

const dockBridge = window.ntfDock;
if (!dockBridge) throw new Error('ntfDock bridge missing');

const root = document.getElementById('dock');
if (!root) throw new Error('missing #dock');

/*
 * A tap that opens the app on the first try.
 *
 * `click` needs pointerdown and pointerup to land on the same element. A finger on this panel always
 * drifts a few pixels between the two, and under Cage/Wayland that drift is enough for the browser to
 * retarget or drop the click — which is why visitors had to press a tile twice. So the launch is
 * driven from `pointerup` itself, guarded by how far and how long the finger moved: past TAP_SLOP or
 * TAP_HOLD_MS the press is a scroll or a resting finger, not a tap, and nothing opens.
 */
const TAP_SLOP_PX = 14;
const TAP_HOLD_MS = 700;

/*
 * Trạng thái chuyển động của một ô là hai lớp do JS bật/tắt, không phải `:hover` của CSS.
 *
 * `is-launching` không bao giờ được chỉ dựa vào `animationend`: ở chế độ giảm chuyển động,
 * dock.css/motion.css đặt `animation: none`, nên sự kiện ấy không bao giờ tới và ô kẹt vĩnh viễn ở
 * trạng thái "đang mở" (NTF-R08). Mỗi lần thêm lớp đều kèm một `setTimeout` gỡ lại.
 *
 * `is-hover` thay cho `:hover` trên ô. Đây là thiết bị lai chuột + cảm ứng: sau khi ngón tay nhấc
 * lên, trình duyệt vẫn giữ `:hover` ở ô vừa chạm, và ô đứng nhấc lên cho tới lần chạm sau.
 */
const HOVER_CLASS = 'is-hover';
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/**
 * Thời lượng bounce, đọc từ token `--dur-launch` của motion.css (320 ms) cộng một nhịp đệm. Đọc
 * token thay vì chép lại con số để CSS và TS không thể lệch nhau; không đọc được thì dùng 400 ms.
 */
let launchFallbackMs = 0;
function launchFallback(): number {
  if (launchFallbackMs !== 0) return launchFallbackMs;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--dur-launch').trim();
  const value = Number.parseFloat(raw);
  const ms = raw.endsWith('ms') ? value : value * 1000;
  launchFallbackMs = Number.isFinite(ms) && ms > 0 ? Math.round(ms) + 80 : 400;
  return launchFallbackMs;
}

/** Hàm dọn trạng thái tạm của từng ô, để giảm chuyển động bật lên giữa chừng là dọn được hết. */
const motionCleanups = new Set<() => void>();

// Người dùng bật giảm chuyển động trong lúc dock đang chạy: mọi trạng thái nhấc/bounce còn treo
// phải về vị trí nghỉ ngay, vì từ đây không còn animation nào gỡ chúng hộ nữa.
reduceMotion.addEventListener('change', (event) => {
  if (!event.matches) return;
  for (const cleanup of motionCleanups) cleanup();
});

interface PendingTap {
  pointerId: number;
  x: number;
  y: number;
  at: number;
}

function bindTap(button: HTMLButtonElement, action: DockAction): void {
  let pending: PendingTap | null = null;
  let launchedAt = Number.NEGATIVE_INFINITY;
  /** Handle of the fallback removal for `is-launching`; 0 khi không có bounce nào đang chạy. */
  let launchTimer = 0;

  /** Gỡ bounce và huỷ luôn bộ hẹn giờ dự phòng của nó. Gọi nhiều lần vẫn an toàn. */
  const clearLaunch = (): void => {
    if (launchTimer !== 0) {
      window.clearTimeout(launchTimer);
      launchTimer = 0;
    }
    button.classList.remove('is-launching');
  };

  /** Gỡ trạng thái nhấc của chuột. Con trỏ cảm ứng không bao giờ đặt nó, nên đây là no-op ở đó. */
  const clearHover = (): void => {
    button.classList.remove(HOVER_CLASS);
  };

  const launch = (at: number) => {
    launchedAt = at;
    dockBridge.press(action);
    // Giảm chuyển động thì không có gì để diễn: CSS đã đặt `animation: none`, nên thêm lớp chỉ tạo
    // ra một trạng thái không ai gỡ. Bỏ hẳn bounce thay vì thêm rồi gỡ trong cùng một tick.
    if (reduceMotion.matches) {
      clearLaunch();
      return;
    }
    // Restart the bounce even on a second tap: the class has to leave the element for one style
    // pass, or the running animation simply continues instead of replaying.
    clearLaunch();
    void button.offsetWidth;
    button.classList.add('is-launching');
    // `animationend` là đường dọn chính, nhưng không phải đường duy nhất: một animation bị gỡ giữa
    // chừng (view ẩn đi, media query đổi, `animation: none`) sẽ không bắn sự kiện nào. Bộ hẹn giờ
    // này bảo đảm ô luôn trở lại vị trí nghỉ.
    launchTimer = window.setTimeout(clearLaunch, launchFallback());
  };

  button.addEventListener('pointerdown', (event) => {
    // A second finger landing mid-press must not start a competing tap, and neither should a mouse
    // button other than the primary one.
    if (!event.isPrimary || event.button !== 0) return;
    pending = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp };
  });

  /*
   * Trạng thái nhấc chỉ dành cho chuột/bút. Ngón tay không có "đang ở trên ô", và trên thiết bị lai
   * thì `:hover` của CSS dính lại ở ô vừa chạm — nên lớp này do JS quản và luôn bị gỡ ở pointerleave,
   * pointerup và pointercancel.
   */
  button.addEventListener('pointerenter', (event) => {
    if (event.pointerType === 'touch') return;
    button.classList.add(HOVER_CLASS);
  });

  button.addEventListener('pointerup', (event) => {
    clearHover();
    const tap = pending;
    // A different pointer lifting (a second finger) must not consume the tap the first finger is
    // still holding, so the pending record is only cleared by its own pointer.
    if (!tap || tap.pointerId !== event.pointerId) return;
    pending = null;
    const travel = Math.hypot(event.clientX - tap.x, event.clientY - tap.y);
    const held = event.timeStamp - tap.at;
    if (travel > TAP_SLOP_PX || held > TAP_HOLD_MS) {
      clearLaunch();
      return;
    }
    launch(event.timeStamp);
  });

  // A cancelled pointer (the compositor took the gesture, the touch was rejected) is never a tap —
  // and it must not leave the tile raised or mid-bounce either.
  button.addEventListener('pointercancel', () => {
    pending = null;
    clearHover();
    clearLaunch();
  });

  /*
   * Leaving the tile cancels the press, but only once the finger is really off it. Touch implicitly
   * captures the pointer to the tile it started on, so `pointerleave` also fires after a few pixels
   * of drift near an edge — cancelling on that would re-create the very double-press this event
   * handling exists to remove. Distance decides, not the boundary event.
   *
   * The hover class is dropped unconditionally: it belongs to the pointer, not to the tap, and on a
   * hybrid device it is the one thing that used to stay stuck on the last-touched tile.
   */
  button.addEventListener('pointerleave', (event) => {
    clearHover();
    const tap = pending;
    if (!tap || tap.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > TAP_SLOP_PX) pending = null;
  });

  /*
   * The browser still sends a `click` after our pointerup. `detail` is 0 only for a click the
   * browser synthesized for a keyboard activation (Enter/Space on the focused tile); every
   * pointer-driven click arrives with detail >= 1 and has already been handled in pointerup. The
   * timestamp guard covers a browser that reports 0 for a touch click anyway, so a single tap can
   * never launch twice.
   */
  button.addEventListener('click', (event) => {
    if (event.detail !== 0) return;
    if (event.timeStamp - launchedAt < 400) return;
    launch(event.timeStamp);
  });

  // The bounce is decoration, so it must not survive a re-arm: removing the class on animationend
  // lets the next press replay it, and also covers a tile whose animation never ran.
  button.addEventListener('animationend', (event) => {
    if (event.animationName === 'dock-launch') clearLaunch();
  });

  // Bật giảm chuyển động giữa chừng: ô này cũng phải về vị trí nghỉ ngay, kể cả khi nó không phải
  // ô vừa được chạm.
  const onMotionChange = (): void => {
    clearLaunch();
    clearHover();
    pending = null;
  };
  motionCleanups.add(onMotionChange);
  window.addEventListener('pagehide', () => motionCleanups.delete(onMotionChange));
}

/** Builds every item once; the running dot and keyboard ring are toggled by state, never rebuilt. */
const buttons = new Map<string, HTMLButtonElement>();
for (const spec of DOCK_ITEMS) {
  if (spec.kind === 'sep') {
    const sep = document.createElement('div');
    sep.className = 'dock-sep';
    root.appendChild(sep);
    continue;
  }
  const button = document.createElement('button');
  button.className = 'dock-item';
  button.type = 'button';
  button.dataset.key = spec.key;
  button.title = spec.label;
  button.setAttribute('aria-label', spec.label);
  button.innerHTML =
    `<span class="dock-label">${spec.label}</span>` +
    `<span class="dock-icon ${spec.tint}">${spec.icon}</span>` +
    '<span class="dock-dot"></span>';
  bindTap(button, spec.action);
  buttons.set(spec.key, button);
  root.appendChild(button);
}

dockBridge.onDock((state) => {
  for (const [key, button] of buttons) {
    const active =
      (state.active !== null && key === state.active) || (state.webAppId !== null && key === `web:${state.webAppId}`);
    button.classList.toggle('running', active);
  }
  const keyboardBtn = buttons.get('keyboard');
  keyboardBtn?.classList.toggle('keyboard-on', state.keyboardOpen);
});

/*
 * Edge-swipe feedback. The gesture is detected in the main process, but the visitor needs to see
 * the finger doing something before the page changes, or an edge swipe feels like a dead zone.
 * Two thin strips grow along the screen edge they belong to and vanish on release.
 */
const backHint = document.createElement('div');
backHint.className = 'gesture-hint gesture-hint--back';
const homeHint = document.createElement('div');
homeHint.className = 'gesture-hint gesture-hint--home';
document.body.append(backHint, homeHint);

dockBridge.onGesture(({ kind, progress }) => {
  backHint.style.transform = `scaleX(${kind === 'back' ? progress : 0})`;
  homeHint.style.transform = `scaleY(${kind === 'home' ? progress : 0})`;
  document.body.classList.toggle('gesturing', kind !== null);
});
