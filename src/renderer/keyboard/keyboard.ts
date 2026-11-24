/**
 * The one keyboard the kiosk has. Keys are injected into whichever view holds the focus
 * (ViewManager.sendKey), so this works identically over Home, the news reader and any remote site.
 *
 * Geometry: this page fills a floating popup card (~1100x260 on the 2560x1600 panel), not the old
 * full-width band; see popup.css and keyboard.css. Nothing here may assume a pixel layout width.
 *
 * Deliberately no <input>, no <form>, no focus()/select()/submit(): the keys are delivered as input
 * events to the *content* view, so this page must never move the focus of the visitor's field. And
 * nothing here logs — not the typed text, not a buffer, not a field value. A kiosk is shared.
 */
const chrome = window.ntfChrome;
if (!chrome) throw new Error('ntfChrome bridge missing');
/**
 * Moving the popup goes through its own required bridge (`ntfKeyboard`) rather than an optional
 * member of `ntfChrome`: that optionality is what let a missing preload bridge compile, and the grip
 * then moved nothing at all. Missing here is a hard failure at load, not a silent no-op.
 */
const keyboardApi = window.ntfKeyboard;
if (!keyboardApi) throw new Error('ntfKeyboard bridge missing');
function must<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`keyboard markup missing: #${id}`);
  return el as T;
}

const kbEl = must<HTMLElement>('kb');
const rowsEl = must<HTMLElement>('rows');
const hideBtn = must<HTMLButtonElement>('hide');
const gripEl = must<HTMLButtonElement>('grip');
const moveEl = must<HTMLButtonElement>('move');

interface KeyDef {
  /** Character or command sent on press. May be multi-character ('.com'). */
  value: string;
  label?: string;
  kind?: 'char' | 'shift' | 'backspace' | 'enter' | 'space' | 'layout';
  cls?: string;
  /** The plain letter this key types; its label follows the shift latch. */
  glyph?: string;
}

const LETTER_ROWS: readonly (readonly string[])[] = [
  [...'qwertyuiop'],
  [...'asdfghjkl'],
  [...'zxcvbnm'],
];

const SYMBOL_ROWS: readonly (readonly string[])[] = [
  [...'1234567890'],
  [...'@#$%&*()-+'],
  [...'"\'/:;!?.,'],
];

/**
 * Popup height limits for the grip. The floor is 250 px rather than the 200 px KEYBOARD_MIN_H
 * because four key rows plus padding and gaps only clear a 44 px touch target above ~250 px.
 */
const SCALE_MIN = 250;
const SCALE_MAX = 470;

/** One-shot shift: latched by a tap on the shift key, consumed by the next character sent. */
let shiftLatched = false;
let symbolPage = false;

const glyphOf = (value: string): string => (shiftLatched ? value.toUpperCase() : value);

/**
 * Send text to the content view, one chrome.key() call per code point.
 *
 * ipc-chrome.ts still rejects any payload longer than 8 characters (`data.length > 8`) and
 * ViewManager.sendKey splits the payload per code point anyway, so splitting here is identical in
 * effect and keeps multi-character keys ('.com', a suggestion chip) safe whatever that cap becomes.
 */
function emit(text: string): void {
  for (const ch of Array.from(text)) {
    if (ch === '\n' || ch === '\r') continue;
    chrome.key(ch);
  }
}

/**
 * Re-paint the shift state without rebuilding the rows. Rebuilding inside a pointer handler would
 * detach the button the finger is on and lose its click, so the latch is only ever reflected here.
 */
function refreshShift(): void {
  for (const el of rowsEl.querySelectorAll<HTMLElement>('[data-shift]')) {
    el.classList.toggle('shift-on', shiftLatched);
  }
  for (const el of rowsEl.querySelectorAll<HTMLElement>('[data-glyph]')) {
    el.textContent = glyphOf(el.dataset.glyph ?? '');
  }
}

/** Consume the one-shot shift latch, returning whether it was set. */
function consumeShift(): boolean {
  if (!shiftLatched) return false;
  shiftLatched = false;
  refreshShift();
  return true;
}

/** Emit a letter, upper-cased and with the latch consumed if shift was tapped. */
function typeChar(raw: string): void {
  emit(consumeShift() ? raw.toUpperCase() : raw);
}

/* ---------- Rows ---------- */

function buildLetterRow(chars: readonly string[], index: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'row';
  if (index === 2) {
    row.appendChild(makeKey({ value: 'shift', label: '⇧', kind: 'shift', cls: 'fn wide-15' }));
  }
  for (const char of chars) {
    row.appendChild(makeKey({ value: char, label: glyphOf(char), glyph: char }));
  }
  if (index === 2) {
    row.appendChild(makeKey({ value: 'backspace', label: '⌫', kind: 'backspace', cls: 'fn wide-15' }));
  }
  if (index === 1) {
    row.appendChild(makeKey({ value: 'enter', label: '⏎', kind: 'enter', cls: 'fn wide-25' }));
  }
  return row;
}

/**
 * Một hàng của trang số/ký hiệu.
 *
 * `withBackspace` chỉ bật ở hàng cuối: trang chữ có ⌫ ở hàng `zxcvbnm` từ trước, còn trang số thì
 * trước đây không có ⌫ nào — gõ nhầm một chữ số là phải chuyển sang `ABC`, xoá, rồi quay lại `123`.
 */
function buildSymbolRow(chars: readonly string[], withBackspace: boolean): HTMLElement {
  const row = document.createElement('div');
  row.className = 'row';
  for (const char of chars) row.appendChild(makeKey({ value: char, label: char }));
  if (withBackspace) {
    row.appendChild(makeKey({ value: 'backspace', label: '⌫', kind: 'backspace', cls: 'fn wide-15' }));
  }
  return row;
}

function buildBottomRow(): HTMLElement {
  const row = document.createElement('div');
  row.className = 'row';
  row.appendChild(makeKey({ value: 'layout', label: symbolPage ? 'ABC' : '123', kind: 'layout', cls: 'fn wide-15' }));
  row.appendChild(makeKey({ value: '@', label: '@', cls: 'wide-15' }));
  row.appendChild(makeKey({ value: '.', label: '.', cls: 'wide-15' }));
  // Multi-character key: emit() sends '.', 'c', 'o', 'm' - all four, never a truncated string.
  row.appendChild(makeKey({ value: '.com', label: '.com', cls: 'fn wide-15' }));
  row.appendChild(makeKey({ value: 'space', label: 'space', kind: 'space', cls: 'space' }));
  row.appendChild(makeKey({ value: 'enter2', label: '⏎', kind: 'enter', cls: 'fn accent wide-2' }));
  return row;
}

function render(): void {
  rowsEl.replaceChildren();
  if (symbolPage) {
    SYMBOL_ROWS.forEach((chars, index) =>
      rowsEl.appendChild(buildSymbolRow(chars, index === SYMBOL_ROWS.length - 1)),
    );
  } else {
    LETTER_ROWS.forEach((chars, index) => rowsEl.appendChild(buildLetterRow(chars, index)));
  }
  rowsEl.appendChild(buildBottomRow());
}

function makeKey(def: KeyDef): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `key ${def.cls ?? ''}`.trim();
  button.textContent = def.label ?? def.value;
  if (def.kind === 'shift') {
    if (shiftLatched) button.classList.add('shift-on');
    button.dataset.shift = '1';
  }
  if (def.glyph !== undefined) button.dataset.glyph = def.glyph;

  const press = (event: Event): void => {
    event.preventDefault();
    button.classList.add('pressed');
  };
  const release = (): void => button.classList.remove('pressed');

  button.addEventListener('pointerdown', press);
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('pointerleave', release);

  button.addEventListener('click', (event) => {
    event.preventDefault();
    switch (def.kind) {
      case 'shift':
        shiftLatched = !shiftLatched;
        refreshShift();
        return;
      case 'layout':
        symbolPage = !symbolPage;
        render();
        return;
      case 'backspace':
        chrome.keyBackspace();
        return;
      case 'enter':
        chrome.keyEnter();
        return;
      case 'space':
        chrome.keySpace();
        return;
      default:
        break;
    }
    // Shift only upper-cases letters; punctuation and the multi-character keys pass through as-is
    // and leave the latch set for the next letter.
    if (def.glyph !== undefined) typeChar(def.glyph);
    else emit(def.value);
  });

  return button;
}

for (const chip of document.querySelectorAll<HTMLButtonElement>('.chip')) {
  chip.addEventListener('click', (event) => {
    event.preventDefault();
    const word = chip.dataset.word ?? '';
    if (word) emit(word);
  });
}

hideBtn.addEventListener('click', (event) => {
  event.preventDefault();
  void chrome.press({ type: 'keyboard' });
});

/*
 * The grip is the whole resize affordance: drag up to grow the popup, drag down to shrink it, tap to
 * dismiss. Preview updates are throttled to ~30 ms so neither the IPC channel nor the main process's
 * re-layout is flooded at pointer-event rate; the final value is sent once on release.
 *
 * NTF-R15: đo chiều cao từ **mép đáy đang đứng yên**, không dùng `clientY − startY`. Popup mọc lên
 * trên nên mỗi bước main áp chiều cao mới thì `clientY` lại trôi xuống đúng bằng phần vừa áp — đo
 * trên panel: kéo 112 px chỉ được 56 px (`260→274→274→288→…→316`). Khoảng cách tới đáy
 * `innerHeight − clientY` bất biến dưới phép co giãn đó, nên sai số không cộng dồn.
 */
{
  const THROTTLE_MS = 30;
  let dragging = false;
  let moved = false;
  let startY = 0;
  let startHeight = 0;
  let applied = 0;
  let pending: number | null = null;
  let lastSent = 0;
  let trailing = 0;

  /**
   * Chiều cao khung đang thấy. `innerHeight` là số thật sau khi main áp, nhưng đọc 0 ở lần vẽ đầu
   * của một `WebContentsView` (NHAT-KY #145) nên phải lùi về chiều cao vừa gửi: lệch một hằng số
   * chỉ làm chiều cao lệch đúng hằng số đó, không bao giờ cộng dồn.
   */
  const frameHeight = (): number => {
    const live = Math.round(window.innerHeight);
    return live > 0 ? live : applied;
  };

  const sendNow = (): void => {
    if (trailing !== 0) {
      window.clearTimeout(trailing);
      trailing = 0;
    }
    if (pending === null) return;
    const value = pending;
    pending = null;
    lastSent = performance.now();
    void chrome.setKeyboardScale(value);
  };

  const queue = (value: number): void => {
    pending = value;
    if (performance.now() - lastSent >= THROTTLE_MS) sendNow();
    else if (trailing === 0) trailing = window.setTimeout(sendNow, THROTTLE_MS);
  };

  gripEl.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    dragging = true;
    moved = false;
    startY = event.clientY;
    startHeight = frameHeight();
    applied = startHeight;
    pending = null;
    // Capture keeps the drag alive when the finger slides off the 16 px grip. It is an
    // optimisation only, so a rejected capture must not abort the drag.
    try {
      gripEl.setPointerCapture(event.pointerId);
    } catch {
      /* no active pointer */
    }
  });

  gripEl.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    // Dragging up (negative dy) grows the popup, so its top edge follows the finger.
    if (Math.abs(event.clientY - startY) > 6) moved = true;
    if (!moved) return;
    const next = Math.round(frameHeight() - event.clientY + startY);
    const clamped = Math.min(SCALE_MAX, Math.max(SCALE_MIN, next));
    applied = clamped;
    queue(clamped);
  });

  const endGrip = (event: PointerEvent, cancelled: boolean): void => {
    if (!dragging) return;
    dragging = false;
    if (gripEl.hasPointerCapture(event.pointerId)) gripEl.releasePointerCapture(event.pointerId);
    if (cancelled) {
      // Huỷ không phải tap (NTF-T1): bỏ mọi thay đổi đang chờ, trả chiều cao về lúc bắt đầu kéo.
      if (trailing !== 0) {
        window.clearTimeout(trailing);
        trailing = 0;
      }
      pending = null;
      applied = startHeight;
      queue(startHeight);
      sendNow();
      return;
    }
    if (moved) {
      sendNow();
      return;
    }
    if (trailing !== 0) {
      window.clearTimeout(trailing);
      trailing = 0;
    }
    pending = null;
    void chrome.press({ type: 'keyboard' });
  };
  gripEl.addEventListener('pointerup', (event) => endGrip(event, false));
  gripEl.addEventListener('pointercancel', (event) => endGrip(event, true));
}

/*
 * The move pad drags the popup around the frame; a tap (no movement) sends it back to the shipped
 * corner. NTF-R10: mỗi bước gửi **offset tuyệt đối so với lúc pointerdown**, không gửi delta — view
 * đang bị dời chính là view đang đọc `clientX`, nên delta cộng dồn tự khử nửa quãng đường (đo được:
 * kéo (−240, −112) chỉ đi (−120, −56)). `pointercancel` không đi chung đường với `pointerup`: huỷ
 * phải trả popup về chỗ cũ và tuyệt đối không được coi là tap.
 */
{
  const THROTTLE_MS = 30;
  const TAP_SLOP = 6;
  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let queued = { dx: 0, dy: 0 };
  let lastSent = 0;
  let trailing = 0;
  let commitQueued = false;
  /**
   * Serial queue for every geometry call on this gesture.
   *
   * NTF-R14: `begin` is asynchronous and a fast finger emits `pointermove` before the reply lands.
   * Main ignores `dragKeyboardTo` until it owns an origin, so those frames used to be dropped and the
   * popup only started moving after the round-trip. Chaining also keeps `begin` → moves → commit or
   * cancel in call order: an unchained `cancelKeyboardDrag` could otherwise resolve *before* a move
   * already in flight and leave the popup wherever that move landed.
   */  let chain: Promise<unknown> = Promise.resolve();

  const run = (op: () => Promise<unknown>): void => {
    chain = chain.then(op).catch(() => undefined);
  };

  const send = (dx: number, dy: number, commit: boolean): void => {
    lastSent = performance.now();
    // Not awaited on purpose: blocking the pointermove handler on IPC would drop frames.
    run(() => keyboardApi.moveKeyboard(dx, dy, commit));
  };

  const flush = (commit: boolean): void => {
    if (trailing !== 0) {
      window.clearTimeout(trailing);
      trailing = 0;
    }
    const doCommit = commit || commitQueued;
    const { dx, dy } = queued;
    commitQueued = false;
    if (dx === 0 && dy === 0 && !doCommit) return;
    send(dx, dy, doCommit);
  };

  const queue = (dx: number, dy: number): void => {
    queued = { dx, dy };
    if (performance.now() - lastSent >= THROTTLE_MS) flush(false);
    else if (trailing === 0) trailing = window.setTimeout(() => flush(false), THROTTLE_MS);
  };

  const stopTrailing = (): void => {
    if (trailing !== 0) {
      window.clearTimeout(trailing);
      trailing = 0;
    }
  };

  moveEl.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    dragging = true;
    moved = false;
    startX = event.clientX;
    startY = event.clientY;
    queued = { dx: 0, dy: 0 };
    commitQueued = false;
    // Chốt origin ở main trước bất kỳ bước kéo nào; mọi lần gửi sau đó xếp hàng sau promise này.
    run(() => keyboardApi.beginKeyboardDrag());
    // Capture keeps the drag alive when the finger slides off the pad (optimisation only).
    try {
      moveEl.setPointerCapture(event.pointerId);
    } catch {
      /* no active pointer */
    }
  });

  moveEl.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    if (!moved && Math.abs(event.clientX - startX) + Math.abs(event.clientY - startY) > TAP_SLOP) {
      moved = true;
    }
    if (!moved) return;
    const next = { dx: event.clientX - startX, dy: event.clientY - startY };
    queue(next.dx, next.dy);
  });

  moveEl.addEventListener('pointerup', (event) => {
    if (!dragging) return;
    dragging = false;
    if (moveEl.hasPointerCapture(event.pointerId)) moveEl.releasePointerCapture(event.pointerId);
    if (!moved) {
      // Tap, not drag: back to the shipped corner. Queued behind `begin` so it cannot land first.
      stopTrailing();
      queued = { dx: 0, dy: 0 };
      run(() => keyboardApi.resetKeyboard());
      return;
    }
    // Áp bước cuối rồi ghi vị trí đã thả.
    queued = { dx: event.clientX - startX, dy: event.clientY - startY };
    commitQueued = true;
    flush(true);
  });

  moveEl.addEventListener('pointercancel', (event) => {
    if (!dragging) return;
    dragging = false;
    if (moveEl.hasPointerCapture(event.pointerId)) moveEl.releasePointerCapture(event.pointerId);
    stopTrailing();
    queued = { dx: 0, dy: 0 };
    commitQueued = false;
    // Huỷ = về đúng chỗ lúc bắt đầu kéo. Không ẩn popup, không reset về góc mặc định, không ghi đĩa.
    run(() => keyboardApi.cancelKeyboardDrag());
  });
}

/*
 * NTF-R11: the volume popover lives in the top bar and stays open when the visitor taps a view that
 * is not the top bar. Nav, the dock and the service pages all report a tap through `gesture:tap`;
 * this page does not, because installing the gesture recognizer here would make a grip drag look like
 * a navigation swipe. So the keyboard reports its own taps directly — one capture-phase listener,
 * fires for keys and the grip alike.
 */
document.addEventListener(
  'pointerdown',
  () => {
    if (typeof chrome.dismissPopovers === 'function') chrome.dismissPopovers();
  },
  true,
);

render();