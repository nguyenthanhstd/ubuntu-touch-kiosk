import {
  shell,
  WebContentsView,
  type BrowserWindow,
  type WebContents,
} from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSafeUrl, isRemoteUrl } from './security.js';
import { trace } from './trace.js';
import { SERVICES, EXTERNAL_PROCS, SERVICE_ORDER, WEB_APPS, ZOOM_FACTORS, ZOOM_ORDER, type ServiceId, type ZoomLevel } from '../shared/services.js';
import type { NavState } from '../shared/ipc.js';
import type { DockState } from '../shared/chrome.js';
import {
  BAND_RADIUS_CSS,
  KEYBOARD_DEFAULT_H,
  KEYBOARD_MAX_H,
  KEYBOARD_MIN_H,
} from '../shared/chrome.js';

/** Bề rộng popup bàn phím: tối đa tuyệt đối, và tối đa theo tỉ lệ bề ngang băng nội dung. */
const KEYBOARD_POPUP_MAX_W = 1100;
const KEYBOARD_POPUP_W_RATIO = 0.55;
import { layoutFor, type ChromeLayout, type Rect } from './layout.js';
import { AutoKeyboard } from './auto-keyboard.js';
import { typeKey, typeText } from './compositor.js';
import { activeExternalGroup, noteActiveExternal, scanExternalGroups } from './external-apps.js';
import { KeyboardOverlay } from './keyboard-overlay.js';

// dist/main/view-manager.js -> dist/renderer, independent of app.getAppPath().
const RENDERER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'renderer');

// Renderer-side edge-swipe recognizer for remote service views (see preload-gesture.cts). The
// local shell preloads import the same module; remote views cannot, so they load it as a preload.
const GESTURE_PRELOAD = join(dirname(fileURLToPath(import.meta.url)), 'preload-service.cjs');

// Scratch partition for media-measurement pages: keeps probe traffic out of the real service
// sessions so a test can never leave cookies behind on a customer-facing profile.
const PROBE_PARTITION = 'ntf-probe';

interface ViewHandlers {
  onLoadingChanged(): void;
  onTitleChanged(title: string): void;
  onAutoKeyboard(editable: boolean): void;
  /**
   * NTF-R01: nội dung nhúng vừa được gắn. Khác `onLoadingChanged` — khung băng phải có mặt ngay
   * khi có nội dung, không chờ vòng poll 2 s nhận ra app ngoài.
   */
  onContentShown(): void;
  /** Nội dung nhúng đã bị gỡ; khung chỉ còn cần thiết nếu vẫn có app ngoài đang chạy. */
  onContentHidden(): void;
}

/**
 * Owns four WebContentsView instances:
 *   top bar  — always-visible status strip (preload-chrome)
 *   dock     — always-visible launcher, added last so it floats over content (preload-dock)
 *   content  — Home / news reader / current service (preload-nav)
 *   keyboard — the shared on-screen keyboard, carved out of the bottom of content
 * The content view is destroyed when a service is left, so a stopped service cannot keep decoding
 * media in the background.
 */
export class ViewManager {
  private readonly window: BrowserWindow;
  private readonly topView: WebContentsView;
  private readonly dockView: WebContentsView;
  private readonly navView: WebContentsView;
  private keyboardView: WebContentsView | null = null;
  private readonly handlers: ViewHandlers;
  private serviceView: WebContentsView | null = null;
  private keyboardScale: number | null = null;

  /**
   * Top-left of the popup once the visitor has moved it, in window CSS px; `null` = the shipped
   * bottom-right anchor. Always re-clamped to the content band, so a stale pair from disk or from a
   * larger panel can never park the keyboard off-screen.
   */
  private keyboardOrigin: { x: number; y: number } | null = null;
  /**
   * Vị trí popup **lúc bắt đầu kéo** (NTF-R10). Mọi bước kéo trong một cử chỉ đều đặt vị trí tuyệt
   * đối từ đây, nên delta không cộng dồn và huỷ kéo chỉ cần trả về đúng số này. `null` = không có
   * cử chỉ kéo nào đang chạy.
   */
  private keyboardDragOrigin: { x: number; y: number } | null = null;
  /**
   * Thế hệ của lượt mở bàn phím hiện tại (NTF-R04). Tăng ở mỗi lượt mở **và** mỗi lượt đóng, để
   * callback tới muộn của một lượt cũ nhận ra mình đã lỗi thời mà không chạm vào view của lượt mới.
   * Chỉ so `keyboardView !== view` là chưa đủ: bật → tắt → bật lại tạo ra một view **khác**, nên nếu
   * một callback chạy trên đối tượng đã bị thay thì phép so sánh vẫn có thể đúng với lượt mới.
   */
  private keyboardGeneration = 0;
  /**
   * Đích của phím bàn phím: `'kiosk'` = view nội dung/nav của kiosk, `'external'` = app ngoài đang
   * focus (Firefox/FreeTube) qua virtual keyboard của Wayland (NTF-R08).
   */
  private keyboardTarget: 'kiosk' | 'external' = 'kiosk';
  /**
   * Nhóm app ngoài mà popup đang phục vụ (`ExternalGroup.id`), hoặc `null`.
   *
   * Cần vì "external" không nói được *app nào*: nếu Firefox và Chromium cùng mở, gõ phím mà không
   * biết đích sẽ có thể rót chữ vào Chromium trong khi khách đang nhìn Firefox. Id được ghi lại **lúc
   * mở đích** — cùng lúc dock quyết định app nào ra trước — nên không phụ thuộc focus về sau, đúng
   * lý do bộ phân biệt X11 cũng phải tĩnh.
   */
  private keyboardExternalId: string | null = null;
  /**
   * Lớp hiển thị cho đích external (NTF-R08). Popup là view con của cửa sổ kiosk, mà kiosk bị ghim
   * `ToggleAlwaysOnBottom`, nên app ngoài luôn che nó; chỉ một cửa sổ `alwaysOnTop` riêng mới nổi
   * lên trên được — đúng cơ chế chín mảnh khung đang dùng. `null` = chưa dựng lần nào.
   */
  private keyboardOverlay: KeyboardOverlay | null = null;
  private readonly autoKeyboard: AutoKeyboard;
  private currentId: ServiceId | null = null;
  private webAppId: string | null = null;
  private currentZoom: Record<string, ZoomLevel> = {
    ...(Object.fromEntries(
      SERVICE_ORDER.map((id) => [id, SERVICES[id].defaultZoom]),
    ) as Record<ServiceId, ZoomLevel>),
    ...Object.fromEntries(Object.values(WEB_APPS).map((app) => [app.id, app.defaultZoom])),
  };
  private layout: ChromeLayout;
  private failed: NavState['failed'] = null;
  private watchdog: NodeJS.Timeout | null = null;
  private watchdogHits = 0;
  /** URL đã xin mở gần nhất, để "Thử lại" còn đường lặp lại khi lần tải trước chết trước khi commit. */
  private lastUrl = '';
  /** Số lần đã tự nạp lại view nội dung sau khi tiến trình render của nó chết. */
  private crashReloads = 0;

  constructor(window: BrowserWindow, handlers: ViewHandlers) {
    this.window = window;
    this.handlers = handlers;
    const [width = 0, height = 0] = window.getContentSize();
    this.layout = layoutFor(width, height);
    // Bàn phím ảo tự hiện là một cơ chế riêng, không phải việc của bộ quản lý view; nó chỉ cần biết
    // *view nào đang giữ focus* tại thời điểm hỏi.
    this.autoKeyboard = new AutoKeyboard({
      target: () => this.serviceContents ?? this.navContents,
      onEditable: (editable) => this.handlers.onAutoKeyboard(editable),
      shouldPoll: () => this.keyboardVisible,
      isOpen: () => this.keyboardVisible,
    });
    // Overlay chỉ cần cho đích external (popup view con bị app ngoài che); dựng lười ở lần dùng đầu.
    this.keyboardOverlay = new KeyboardOverlay(window, () => this.keyboardOverlayRect());

    // The bar and the dock float over the wallpaper instead of covering it, so they must be see
    // through. Their pages paint only their own glass gradients, never an opaque page background.
    this.topView = this.createLocalView('preload-chrome.cjs', 'top', true);
    this.dockView = this.createLocalView('preload-dock.cjs', 'dock', true);
    this.navView = this.createLocalView('preload-nav.cjs', 'nav');

    // Paint order: content underneath, then top bar, then dock on top of everything.
    this.window.contentView.addChildView(this.navView);
    this.window.contentView.addChildView(this.topView);
    this.window.contentView.addChildView(this.dockView);
    // Chromium paints a child view only once its size has changed while attached: the very first
    // view added to a window inherits the window's own bounds and is never committed, so the nav
    // view stayed invisible until it was resized. Force one resize after attaching everything.
    this.applyLayout();
    const [fw = 0, fh = 0] = this.window.getContentSize();
    this.navView.setBounds({ x: 0, y: 0, width: Math.max(1, fw - 1), height: fh });
    this.applyLayout();
    this.navView.webContents.on('did-finish-load', () => this.applyZoom());
  }

  private createLocalView(preload: string, tag: string, seeThrough = false): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        preload: join(dirname(fileURLToPath(import.meta.url)), preload),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    view.setBackgroundColor(seeThrough ? '#00000000' : '#0A0A0A');
    this.harden(view.webContents, 'local');
    view.webContents.on('console-message', (event) => {
      if (event.level === 'error' || event.level === 'warning') {
        console.error(`[${tag}:console] ${event.message} (${event.sourceId}:${event.lineNumber})`);
      }
    });
    view.webContents.on('preload-error', (_e, path, error) =>
      console.error(`[${tag}] preload-error ${path}: ${error.message}`),
    );
    return view;
  }

  /** Recomputes every rectangle for the current window size. */
  resize(): void {
    this.applyLayout();
  }

  private applyLayout(): void {
    const [width = 0, height = 0] = this.window.getContentSize();
    this.layout = layoutFor(width, height);
    this.topView.setBounds(this.layout.top);
    this.dockView.setBounds(this.layout.dock);
    // The nav page owns the wallpaper, so it spans the whole window: behind the see-through bar and
    // dock it reads the same image with no seam at their edges.
    this.navView.setBounds({ x: 0, y: 0, width, height });
    this.layoutContent();
    // A resize (panel change, ui zoom) moves the content band, so an open popup has to be re-clamped;
    // it would otherwise keep pixel coordinates that are no longer inside the frame.
    if (this.keyboardView) this.applyKeyboardBounds(this.keyboardView);
  }

  private contentHeight(): number {
    // NTF-R05: bàn phím là popup nổi, không còn là một dải chiếm chỗ, nên băng nội dung giữ nguyên
    // chiều cao dù bàn phím mở hay tắt. Đây chính là điều giữ trang nền không đổi kích thước.
    return Math.max(120, this.layout.content.height);
  }

  /**
   * The requested band height, clamped to what the screen can give. Never taller than the space
   * between top bar and dock, so the dock stays reachable while the keyboard is up.
   */
  private keyboardHeightPx(): number {
    const [, height] = this.window.getContentSize();
    const chromeRoom = this.layout.dock.y - (this.layout.top.y + this.layout.top.height) - 80;
    const wanted = this.keyboardScale ?? KEYBOARD_DEFAULT_H;
    return Math.min(wanted, Math.max(KEYBOARD_MIN_H, chromeRoom), Math.max(120, height ?? 0));
  }

  /** Applied live while the grip is dragged, so the band follows the finger. */
  setKeyboardScale(px: number): void {
    const next = Math.round(
      Math.min(KEYBOARD_MAX_H, Math.max(KEYBOARD_MIN_H, Number.isFinite(px) ? px : KEYBOARD_DEFAULT_H)),
    );
    if (next === this.keyboardScale) return;
    this.keyboardScale = next;
    const view = this.keyboardView;
    if (!view) return;
    const [fw = 0, fh = 0] = this.window.getContentSize();
    this.navView.setBounds({ x: 0, y: 0, width: fw, height: fh });
    this.applyKeyboardBounds(view);
    // Đích external: cỡ đổi thì `y` cũng phải tính lại (popup mọc lên trên, đáy đứng yên), nên phải
    // cả đổi cỡ lẫn dời chỗ. `apply()` lo cỡ, `remap()` lo chỗ.
    if (this.keyboardTarget === 'external') this.remapKeyboardOverlay();
    // Re-assert paint order: setBounds does not change z-order, but any later add would.
    this.window.contentView.addChildView(this.topView);
    this.window.contentView.addChildView(this.dockView);
  }

  /**
   * Moves the popup to an absolute top-left, or back to the default corner with `null`.
   *
   * The renderer only ever sends a *delta*: inside a WebContentsView `window.screenX`/`screenY` read
   * 0 (measured on the panel), so the popup page cannot know where it sits and must not compute an
   * absolute position. Keeping the origin here also means the value survives a close/open cycle
   * without the page having to remember anything.
   */
  setKeyboardOrigin(origin: { x: number; y: number } | null): void {
    // Store the *clamped* position, never the raw request: the renderer keeps sending deltas past
    // the edge, so an unclamped store would accumulate a large negative origin and then drag the
    // popup back through dead pixels the moment the stored value were ever applied directly.
    this.keyboardOrigin = origin ? this.clampKeyboardOrigin(origin) : null;
    const view = this.keyboardView;
    if (view) {
      this.applyKeyboardBounds(view);
      // Đích external vẽ ở cửa sổ overlay, không ở view con: phải dời cả hai hay người dùng thấy
      // một popup đứng yên trong khi cái còn lại chạy theo ngón tay.
      if (this.keyboardTarget === 'external') this.remapKeyboardOverlay();
    }
  }

  /**
   * Dời cửa sổ overlay thật sự.
   *
   * Tồn tại vì `setBounds` của Electron **không** dời được một `xdg_toplevel`: đo trên panel, kéo
   * chuột (−240, −112) px thì IPC trả đúng hình học mới nhưng `BEFORE`/`AFTER` chụp màn hình vẫn y
   * nguyên một hình chữ nhật. Chỗ do compositor quyết qua `windowRule` `MoveTo`, và nó chỉ đọc rule
   * lúc cửa sổ được map — nên đây là một chuyến đi thật, không phải một lời gọi setter.
   */
  remapKeyboardOverlay(): void {
    if (this.keyboardTarget !== 'external') return;
    this.keyboardOverlay?.remap(this.keyboardGeometry());
  }

  get keyboardOriginValue(): { x: number; y: number } | null {
    return this.keyboardOrigin ? { ...this.keyboardOrigin } : null;
  }

  /**
   * Starts a drag and returns where the popup actually sits, so the page can send *absolute* offsets
   * from this captured origin instead of per-move deltas.
   *
   * NTF-R10: bản cũ cộng dồn `dx` vào `view.getBounds()` **ở mỗi lần pointermove**. Nhưng chính view
   * đó đang bị dời, nên `clientX` trong trang cũng trôi theo: đo được trên panel là kéo chuột
   * (−240, −112) px mà popup chỉ dịch (−120, −56) — đúng một nửa, vì mỗi bước vừa cộng delta vừa
   * mất đúng delta đó ở hệ quy chiếu của chính nó. Cách sửa: chốt origin **một lần** lúc
   * `pointerdown`, rồi mỗi bước đặt vị trí tuyệt đối `origin + offset`; khi đó sai số không cộng
   * dồn, và một cử chỉ bị `pointercancel` chỉ cần bỏ offset là về đúng chỗ cũ.
   */
  beginKeyboardDrag(): { x: number; y: number } | null {
    const view = this.keyboardView;
    if (!view) return null;
    const bounds = view.getBounds();
    this.keyboardDragOrigin = { x: bounds.x, y: bounds.y };
    return { ...this.keyboardDragOrigin };
  }

  /**
   * Places the popup at `origin + offset`, clamped, and returns where it actually landed.
   *
   * `commit` chỉ được ghi khi thả tay: preview không được ghi đĩa mỗi frame (một drag 120 bước sẽ là
   * 120 lần `settings.json`).
   */
  dragKeyboardTo(dx: number, dy: number): { x: number; y: number } | null {
    const view = this.keyboardView;
    const origin = this.keyboardDragOrigin;
    if (!view || !origin) return null;
    this.setKeyboardOrigin({
      x: origin.x + (Number.isFinite(dx) ? dx : 0),
      y: origin.y + (Number.isFinite(dy) ? dy : 0),
    });
    const after = view.getBounds();
    return { x: after.x, y: after.y };
  }

  /** Thả tay: giữ vị trí đang thấy và kết thúc cử chỉ. */
  commitKeyboardDrag(): { x: number; y: number } | null {
    const view = this.keyboardView;
    this.keyboardDragOrigin = null;
    return view ? { x: view.getBounds().x, y: view.getBounds().y } : null;
  }

  /**
   * Cử chỉ bị huỷ (ngón trượt khỏi mép panel, app ngoài cướp focus): trả popup về đúng chỗ lúc bắt
   * đầu kéo. Không dùng để "reset về góc mặc định" — huỷ không phải là tap, nên không được ẩn popup
   * hay đổi vị trí đã lưu.
   */
  cancelKeyboardDrag(): { x: number; y: number } | null {
    const origin = this.keyboardDragOrigin;
    this.keyboardDragOrigin = null;
    const view = this.keyboardView;
    if (!view || !origin) return null;
    this.setKeyboardOrigin({ ...origin });
    return { x: view.getBounds().x, y: view.getBounds().y };
  }

  get keyboardHeight(): number {
    return this.keyboardHeightPx();
  }

  get topContents(): WebContents {
    return this.topView.webContents;
  }

  /** The composed window surface. `browserWindow` also lets the probe capture without a view. */
  get browserWindow(): BrowserWindow {
    return this.window;
  }

  get dockContents(): WebContents {
    return this.dockView.webContents;
  }

  get keyboardContents(): WebContents | null {
    return this.keyboardView?.webContents ?? null;
  }

  get keyboardVisible(): boolean {
    return this.keyboardView !== null;
  }

  /**
   * Raise lại cửa sổ overlay bàn phím. Gọi mỗi khi có app ngoài vừa map: trật tự chồng trên labwc
   * đặt cửa sổ mới lên trên theo thứ tự map, nên popup đang mở sẽ bị app vừa mở che mất nếu không
   * raise. Cùng lý do với `FrameWindows.raise()`.
   */
  raiseKeyboardOverlay(): void {
    if (this.keyboardTarget !== 'external' || !this.keyboardView) return;
    this.keyboardOverlay?.raise();
  }

  /**
   * Dọn tài nguyên sống ngoài cây view của cửa sổ kiosk.
   *
   * Overlay là một `BrowserWindow` riêng, không phải view con, nên nó **không** tự chết theo cửa sổ
   * kiosk nếu không đóng ở đây — và một cửa sổ always-on-top mồ côi sẽ phủ lên màn hình Home và ăn
   * mọi cú chạm.
   */
  dispose(): void {
    this.keyboardOverlay?.destroy();
    this.keyboardOverlay = null;
    this.keyboardView = null;
  }

  /**
   * Đích nhập liệu hiện tại của bàn phím (NTF-R08). `'external'` = app ngoài đang focus, phím đi qua
   * virtual keyboard của Wayland thay vì `sendInputEvent`.
   */
  get keyboardTargetValue(): 'kiosk' | 'external' {
    return this.keyboardTarget;
  }

  /**
   * Id app ngoài mà popup đang nhắm tới, hoặc `null` khi đích là kiosk.
   *
   * Cần đọc được từ ngoài để nút bàn phím thủ công biết đích `external` hiện tại còn app đó hay
   * không, thay vì hỏi lại compositor và có thể xoá mất đích người dùng vừa đặt bằng tile app.
   */
  get keyboardTargetExternalId(): string | null {
    return this.keyboardExternalId;
  }

  /**
   * Đặt đích nhập liệu và mở/đóng popup cho khớp — một lời gọi cho cả hai việc để không thể rơi vào
   * trạng thái "bàn phím mở nhưng gõ vào chỗ khác".
   *
   * Vì sao đích phải tách khỏi việc mở: khi Firefox/FreeTube ra trước, popup vẫn là view con của
   * cửa sổ kiosk nên **bị che**; muốn gõ được thì phải (a) đưa popup lên trên bằng cửa sổ
   * always-on-top riêng — xem `keyboard-overlay.ts` — và (b) đổi đích phím sang app ngoài. Hai việc
   * đó đi cùng nhau, nên chúng nằm cùng một lời gọi.
   */
  async setKeyboardTarget(target: 'kiosk' | 'external', externalId?: string | null): Promise<boolean> {
    const nextId = target === 'external' ? (externalId ?? null) : null;
    if (this.keyboardTarget === target && this.keyboardExternalId === nextId) return this.keyboardVisible;
    this.keyboardTarget = target;
    this.keyboardExternalId = nextId;
    // Đổi đích = đổi chỗ nhận phím; caret của đích cũ không còn ý nghĩa.
    this.autoKeyboard.cancelPress();
    // App ngoài không có ô nhập nào để hỏi DOM, nên khi đích là external thì bộ dò tự đóng phải
    // tắt hẳn: nó chỉ đọc được view nội dung của kiosk và sẽ đóng popup ngay sau lần poll đầu.
    if (target === 'external') this.autoKeyboard.disarm();
    else this.syncAutoKeyboard();
    return this.keyboardVisible;
  }

  /** Current popup rectangle, for callers that need to report where it landed. */
  get keyboardRect(): Electron.Rectangle | null {
    return this.keyboardView ? this.keyboardView.getBounds() : null;
  }

  /**
   * Pid của **đúng** app ngoài mà popup đang phục vụ.
   *
   * Quét lại `/proc` mỗi lần bấm phím thay vì lưu pid lúc mở: app có thể đã bị đóng rồi mở lại giữa
   * hai lần gõ, và pid cũ sẽ khiến lệnh gõ nhắm vào một tiến trình không còn tồn tại. Quét lại là
   * đọc `/proc` vài chục lần mỗi giây trong lúc gõ — rẻ hơn nhiều so với một lần gõ sai đích.
   *
   * Không biết id (mở đích trước khi có app nào chạy) thì trả rỗng: lúc đó nhánh Wayland được chọn,
   * đúng cho Firefox/FreeTube, và Chromium sẽ được nhận ra ngay khi dock mở nó.
   */
  private externalTargetPids(): number[] {
    if (this.keyboardExternalId === null) return [];
    const group = scanExternalGroups().find((item) => item.id === this.keyboardExternalId);
    return group ? group.pids : [];
  }

  /**
   * `app_id` ứng viên của app ngoài mà popup đang phục vụ — đường focus cho OSK-01.
   *
   * `ExternalGroup` chỉ có `pids` (đọc từ `/proc`), không có `app_id`: Wayland `app_id` do compositor
   * gán và không suy ra được từ đường dẫn nhị phân (FreeTube là `freetube`, Firefox snap là
   * `firefox_firefox`). Nên tra bảng `EXTERNAL_PROCS` theo id nhóm — cùng nguồn sự thật mà dock dùng
   * để mở app, nên danh sách ứng viên luôn khớp.
   */
  private externalTargetAppIds(): readonly string[] {
    if (this.keyboardExternalId === null) return [];
    return EXTERNAL_PROCS.find((proc) => proc.id === this.keyboardExternalId)?.appIds ?? [];
  }

  /** The view that owns Back/Reload: a service page or a curated player host, never the strips. */
  activeContents(): WebContents | null {
    return this.serviceView?.webContents ?? null;
  }

  /**
   * Có băng nội dung nào đang thực sự được vẽ hay không — hỏi thẳng view chứ không suy từ
   * `serviceView !== null`, vì NTF-R03 ẩn view khi lỗi mà vẫn giữ tham chiếu để nạp lại.
   *
   * `main.ts` dùng câu trả lời này để quyết định có ẩn khung bo góc hay không: ẩn khung trong khi
   * băng còn vẽ là mất luôn nút ✕, còn giữ khung khi không còn gì để bo là chín cửa sổ trong suốt
   * nằm chắn trên Home.
   */
  hasVisibleContent(): boolean {
    const view = this.serviceView;
    if (!view || view.webContents.isDestroyed()) return false;
    try {
      return view.getVisible();
    } catch {
      return true;
    }
  }

  /**
   * Đóng mọi popover của thanh trên (hiện có popover âm lượng).
   *
   * NTF-R11: popover nằm trong view thanh trên nên chỉ thấy `pointerdown` phát sinh bên trong chính
   * nó; chạm vào băng nội dung hay dock là chạm vào view khác và popover ở lại mãi. Main process là
   * nơi duy nhất thấy mọi cú chạm (qua `gesture:tap` của ba view kia), nên nó phát tín hiệu này.
   */
  dismissPopovers(): void {
    const contents = this.topContents;
    if (contents.isDestroyed()) return;
    try {
      contents.send('ntf:dismiss-popovers');
    } catch {
      /* thanh trên có thể đang nạp lại */
    }
  }

  /**
   * Ghi trạng thái lỗi và quyết định view nội dung còn được vẽ hay không.
   *
   * Đây là nửa còn lại của NTF-R03. Trước đây `failed` chỉ đi tới thanh trên và trang Home, còn
   * view lỗi vẫn nằm nguyên trên cùng với nền `#0A0A0A` — nên thẻ lỗi có tồn tại nhưng không ai
   * thấy, và người dùng chỉ thấy một dải đen. Ẩn view khi lỗi là cách duy nhất để lớp nhìn thấy
   * (Home: hình nền + thẻ lỗi + hai nút) thực sự ở trên và nhận được chạm; nạp lại thì view hiện
   * lại ngay từ `did-start-loading`.
   */
  private setFailed(next: NavState['failed']): void {
    this.failed = next;
    const view = this.serviceView;
    if (view && !view.webContents.isDestroyed()) {
      view.setVisible(next === null);
      // Trang lỗi của Chromium vẽ nền trắng đục; ẩn view là chưa đủ nếu nó đã vẽ khung hình trước
      // đó, nên trả nền về trong suốt để lớp Home lộ ra trọn vẹn khi view hiện lại.
      if (next !== null) view.setBackgroundColor('#00000000');
    }
    this.handlers.onLoadingChanged();
  }

  /**
   * Chạm cuối cùng lên một view nội dung trước khi nó được gắn.
   *
   * NTF-R01: `View.setBorderRadius` bo *chính surface* của trang nhúng, nên bốn góc của Tin tức,
   * Google, TikTok, Instagram, Facebook trùng đúng cung r=24 mà khung băng vẽ cho app ngoài — không
   * phải thêm một ô mặt nạ nào, và góc tròn có từ khung hình đầu tiên vì nó là thuộc tính của
   * surface chứ không phải một lớp phủ hiện sau. Electron ghi rõ: phần bị khoét vẫn nhận chạm, nên
   * vùng bấm cạnh nút ✕ và hai rãnh viền không đổi hành vi.
   */
  private decorateServiceView(view: WebContentsView): void {
    view.setBackgroundColor('#0A0A0A');
    try {
      view.setBorderRadius(BAND_RADIUS_CSS);
    } catch (error) {
      console.error('[view] không bo được góc:', (error as Error).message);
    }
  }

  private harden(contents: WebContents, kind: 'local' | 'remote'): void {
    contents.setWindowOpenHandler(({ url }) => {
      if (kind === 'remote' && isSafeUrl(url)) {
        void contents.loadURL(url);
      } else if (isRemoteUrl(url) && url.startsWith('https:')) {
        void shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    // A remote view may only move to http(s); a local page (Home, curated player host) is allowed
    // to stay on file:// but may never navigate into a privileged or opaque scheme.
    const allowed = kind === 'remote' ? isRemoteUrl : isSafeUrl;
    contents.on('will-navigate', (event, url) => {
      if (!allowed(url)) {
        event.preventDefault();
        this.setFailed({ code: -3, description: `Bị chặn giao thức không an toàn: ${url.slice(0, 80)}` });
      }
    });
    contents.on('will-redirect', (event, url) => {
      if (!allowed(url)) {
        event.preventDefault();
        this.setFailed({ code: -3, description: 'Bị chặn chuyển hướng không an toàn.' });
      }
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());

    contents.on('did-start-loading', () => {
      if (this.failed !== null) this.setFailed(null);
      else this.handlers.onLoadingChanged();
    });
    contents.on('did-stop-loading', () => this.handlers.onLoadingChanged());
    contents.on('did-finish-load', () => {
      // Một trang đã vẽ xong là mốc duy nhất đáng tin để đặt lại bộ đếm tự phục hồi: nếu để nó
      // tích luỹ qua các trang thì một lần GPU crash thứ hai trong ngày sẽ không còn được cứu.
      this.crashReloads = 0;
      this.handlers.onLoadingChanged();
    });
    contents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      if (url.startsWith('devtools://')) return;
      this.setFailed({ code, description });
    });
    contents.on('render-process-gone', (_e, details) => {
      // NTF-R02: một tiến trình render chết (kể cả khi GPU crash kéo theo, mã 139) để lại một view
      // không bao giờ vẽ tiếp. Cứu một lần bằng chính URL đang có, để khách không phải tự bấm;
      // lần thứ hai thì dừng và để thẻ lỗi nói thật là máy đang hỏng.
      this.setFailed({ code: -1, description: `Tiến trình trang đã dừng (${details.reason}).` });
      if (this.crashReloads >= 1) return;
      this.crashReloads += 1;
      const view = this.serviceView;
      if (!view || view.webContents.isDestroyed() || !this.lastUrl) return;
      setTimeout(() => {
        if (this.serviceView !== view || view.webContents.isDestroyed()) return;
        console.error(`[view] tự nạp lại sau khi tiến trình trang dừng: ${this.lastUrl}`);
        void view.webContents.loadURL(this.lastUrl).catch(() => undefined);
      }, 800);
    });
    contents.on('page-title-updated', (_e, title) => this.handlers.onTitleChanged(title));
  }

  load(): void {
    const root = RENDERER_DIR;
    void this.topView.webContents.loadFile(join(root, 'shell', 'top.html'));
    void this.dockView.webContents.loadFile(join(root, 'shell', 'dock.html'));
    void this.navView.webContents.loadFile(join(root, 'nav', 'index.html'));
  }

  get navContents(): WebContents {
    return this.navView.webContents;
  }

  get serviceContents(): WebContents | null {
    return this.serviceView?.webContents ?? null;
  }

  get activeService(): ServiceId | null {
    return this.currentId;
  }

  get activeWebApp(): string | null {
    return this.webAppId;
  }

  setZoomMap(map: Record<ServiceId, ZoomLevel>): void {
    this.currentZoom = { ...this.currentZoom, ...map };
    const key = this.currentId ?? this.webAppId;
    if (key) this.serviceContents?.setZoomFactor(ZOOM_FACTORS[this.currentZoom[key] ?? 'normal']);
    // NTF-R10: đổi cỡ chữ mà không đẩy `ntf:zoom-changed` thì nhãn trên thanh trên và trên Home vẫn
    // ghi cỡ cũ, nên khách bấm +/− thấy không có tác dụng.
    this.applyZoom();
    this.handlers.onLoadingChanged();
  }

  stepZoom(direction: 1 | -1): ZoomLevel | null {
    const key = this.currentId ?? this.webAppId;
    if (!key) return null;
    const index = ZOOM_ORDER.indexOf(this.currentZoom[key] ?? 'normal');
    const level = ZOOM_ORDER[Math.min(ZOOM_ORDER.length - 1, Math.max(0, index + direction))]!;
    this.currentZoom[key] = level;
    this.serviceContents?.setZoomFactor(ZOOM_FACTORS[level]);
    this.applyZoom();
    this.handlers.onLoadingChanged();
    return level;
  }

  resetZoom(): ZoomLevel | null {
    const key = this.currentId ?? this.webAppId;
    if (!key) return null;
    const level = (this.currentId ? SERVICES[this.currentId].defaultZoom : WEB_APPS[key]?.defaultZoom) ?? 'normal';
    this.currentZoom[key] = level;
    this.serviceContents?.setZoomFactor(ZOOM_FACTORS[level]);
    this.applyZoom();
    this.handlers.onLoadingChanged();
    return level;
  }

  currentZoomLevel(): ZoomLevel | null {
    const key = this.currentId ?? this.webAppId;
    return key ? (this.currentZoom[key] ?? 'normal') : null;
  }

  /**
   * Toggles the shared on-screen keyboard.
   *
   * NTF-R05: bàn phím KHÔNG còn cắt bớt chiều cao trang nền nữa. Trước đây nó là một dải rộng bằng
   * dock nằm trong luồng layout, nên mở bàn phím là trang nhảy lên và nội dung bị đẩy khỏi tầm mắt.
   * Nay nó là một popup nổi canh phải-dưới, nên `contentHeight()` không trừ chiều cao bàn phím và
   * `layoutContent()` giữ nguyên hình học ⇒ không còn cú nhảy trang.
   *
   * NTF-R12: vòng chờ `did-finish-load` cũ dùng `setTimeout` gọi `removeListener` sau khi `once` đã
   * tự gỡ ⇒ `TypeError` và view rò rỉ khi khách bật/tắt nhanh. Nay là `Promise.race` thuần, không
   * có thao tác nào trên emitter trong timeout, và mọi thay đổi sau `await` đều kiểm
   * `this.keyboardView === view` trước khi chạm.
   */
  async setKeyboardOpen(open: boolean): Promise<boolean> {
    trace(`setKeyboardOpen open=${String(open)} visible=${String(this.keyboardVisible)}`);
    if (open === this.keyboardVisible) return this.keyboardVisible;
    // Mỗi lượt mở tăng một thế hệ; mọi callback tới muộn so sánh với số này thay vì chỉ so view.
    // Nhờ vậy bật → tắt → bật nhanh không thể để một callback của lượt cũ ghi đè lượt mới.
    const generation = ++this.keyboardGeneration;
    if (open) {
      // The keyboard needs the chrome bridge (key/keyBackspace/keyEnter/keySpace/press), not the nav one.
      const view = this.createLocalView('preload-chrome.cjs', 'keyboard');
      // Transparent, for the same reason as the overlay window: the page's card has a 24 px radius, so
      // an opaque view background paints `#12100C` into the four arcs. The page itself is transparent
      // (keyboard.css), so the arc must show whatever is behind the popup.
      view.setBackgroundColor('#00000000');
      this.keyboardView = view;
      // Attach FIRST: a child view only commits its first painted frame once it is attached to the
      // window. Loading before attaching is what skipped the keyboard's first frame — the same
      // first-frame skip that hid the nav view.
      this.window.contentView.addChildView(view);
      // NTF-R04: đặt hình học **trước** khi nạp trang. Bản cũ để view ở 0x0 tới khi
      // `did-finish-load` xong rồi `await` một `Promise.race` 2500 ms; đo trên panel, popup ở 0x0
      // suốt 0.28 / 0.81 / 1.46 s và chỉ có kích thước thật ở 2.56 s — cú chạm đầu không thấy gì.
      // Vòng "dance" full-window cũng không còn cần: nó chỉ tồn tại để Chromium commit frame đầu
      // cho một view 0x0, còn ở đây chính cú đặt bounds này là cú đổi bounds đó.
      this.applyKeyboardBounds(view);
      // NTF-R08/NTF-R17: đích external thì popup vẽ ở cửa sổ overlay `alwaysOnTop`, và **chỉ** ở đó.
      // View con luôn nằm dưới app ngoài (kiosk bị ghim `ToggleAlwaysOnBottom`), nhưng nạp trang vào
      // nó vẫn tạo CDP target thứ hai cùng `keyboard/index.html`, trong khi vòng kiểm chỉ nhận 1.
      const page = join(RENDERER_DIR, 'keyboard', 'index.html');
      let loaded: Promise<void> | null = null;
      if (this.keyboardTarget === 'external') {
        // Hỏi compositor **trước** khi overlay map: cửa sổ overlay là toplevel always-on-top nên ngay
        // khi nó hiện, không app ngoài nào còn báo `state:active` nữa. Đo trên panel: Firefox đang
        // trước, popup mở, rồi ✕ — cả hai app đều trả `no`, `startedAt` được dùng và đóng nhầm
        // FreeTube. Ghi nhớ ở đây giữ lại câu trả lời đúng cho lúc bấm ✕.
        const front = await activeExternalGroup();
        if (front) noteActiveExternal(front.id);
        if (this.keyboardOverlay?.show() ?? false) loaded = Promise.resolve();
        else console.error('[keyboard] không dựng được overlay — rơi về popup view con');
      }
      if (loaded === null) {
        loaded = view.webContents.loadFile(page).catch((error: unknown) => {
          // NTF-R16: đóng popup khi trang còn đang nạp làm `loadFile` bị huỷ và trả
          // `ERR_FAILED (-2)`. Báo cáo QA đọc đây là lỗi bàn phím nhưng không có gì hỏng — lượt
          // mở đã bị người dùng huỷ. Chỉ nuốt đúng mã đó khi lượt này đã lỗi thời; lỗi khác vẫn log.
          const message = (error as Error).message;
          const stale = this.keyboardGeneration !== generation || this.keyboardView !== view;
          if (!(stale && message.includes('ERR_FAILED (-2)'))) {
            console.error('[keyboard] load failed:', message);
          }
        });
      }
      this.afterKeyboardLoad(view, generation, loaded);
      // The dock now floats over the keyboard popup, so it goes last to stay on top.
      this.window.contentView.addChildView(this.dockView);
      this.navContents.send('ntf:keyboard', { open: true, height: this.keyboardHeightPx() });
      const bounds = view.getBounds();
      // `overlay=` ghi **quyết định** dùng overlay, không phải `isVisible`: `show()` trả `true` ngay
      // khi đã xếp hàng còn `drain()` mới map, nên `isVisible` ở đây luôn `false` cho lượt mở đầu.
      console.log(
        `[keyboard] popup x=${bounds.x} y=${bounds.y} h=${bounds.height} w=${bounds.width} target=${this.keyboardTarget} overlay=${String(loaded !== null)}`,
      );
    } else if (this.keyboardView) {
      this.closeKeyboardView();
    }
    this.applyLayout();
    this.syncAutoKeyboard();
    return this.keyboardVisible;
  }

  /**
   * Hậu xử lý trang bàn phím sau khi nạp xong — **không** chặn đường mở popup.
   *
   * Việc duy nhất cần đợi trang là đảm bảo khung hình đầu đã commit trên một số bản Electron (view
   * gắn xong mới vẽ). `invalidate()` + đặt lại bounds một lần là đủ; bản cũ chờ tới 2500 ms, đúng
   * khoảng thời gian người dùng nhìn thấy một khoảng trống ở đáy màn hình. Mọi nhánh đều kiểm
   * `keyboardGeneration`: nếu khách đã tắt (hoặc tắt rồi bật lại) trong lúc trang đang nạp thì lượt
   * này tự bỏ, không chạm vào view của lượt mới.
   */
  private afterKeyboardLoad(view: WebContentsView, generation: number, loaded: Promise<void>): void {
    void loaded.then(() => {
      if (this.keyboardGeneration !== generation || this.keyboardView !== view) return;
      if (view.webContents.isDestroyed()) return;
      // Repaint with the real bounds now that the document exists. Cheap and idempotent.
      this.applyKeyboardBounds(view);
      view.webContents.invalidate();
    });
  }

  /** Gỡ popup bàn phím và trả thứ tự vẽ về như cũ. Dùng chung cho mọi đường đóng. */
  private closeKeyboardView(): void {
    const view = this.keyboardView;
    this.keyboardView = null;
    this.keyboardGeneration += 1;
    this.keyboardDragOrigin = null;
    this.keyboardOverlay?.hide();
    this.navContents.send('ntf:keyboard', { open: false, height: 0 });
    if (!view) return;
    this.window.contentView.removeChildView(view);
    // Restore the strips' order: dock last, on top of the service page.
    this.window.contentView.addChildView(this.topView);
    this.window.contentView.addChildView(this.dockView);
    // The page that asked to close is still finishing its click event; destroying its webContents
    // in the same tick rejects the pending blink.mojom.WidgetHost message and logs a Mojo error.
    // Let the current message drain first, then close.
    setTimeout(() => {
      try {
        if (!view.webContents.isDestroyed()) view.webContents.close();
      } catch (error) {
        console.error('[keyboard] dispose failed:', (error as Error).message);
      }
    }, 0);
  }

  /**
   * Bật/tắt bộ dò ô nhập theo việc **có trang đang mở** hay không, không theo việc bàn phím đang mở
   * hay đóng.
   *
   * NTF-R04: bản trước chỉ `arm()` khi `keyboardVisible` đã true, mà `notePress()` lại thoát ngay khi
   * chưa `arm()`. Kết quả là cú chạm vào ô nhập — đường *duy nhất* được phép mở bàn phím — không bao
   * giờ chạy tới nơi, nên bàn phím chỉ còn mở được bằng nút thủ công ở dock. Điều kiện đúng là còn
   * trang để hỏi `document.activeElement`.
   */
  private syncAutoKeyboard(): void {
    trace(`syncAutoKeyboard svc=${String(this.serviceContents !== null)} target=${this.keyboardTarget}`);
    // Trang vừa đổi thì cửa sổ thử của cú chạm trước không còn ý nghĩa: nó đang đợi đọc lại
    // `document.activeElement` của một tài liệu đã bị thay.
    this.autoKeyboard.cancelPress();
    // Đích external không có DOM nào của ta để hỏi, nên bộ dò tự đóng phải tắt — nếu không nó đọc
    // view nội dung của kiosk và đóng popup đang phục vụ app ngoài.
    if (this.keyboardTarget === 'external' || this.serviceContents === null) this.autoKeyboard.disarm();
    else this.autoKeyboard.arm();
  }

  /**
   * Hình học popup bàn phím, tính một chỗ cho cả hai lớp hiển thị.
   *
   * Rộng tối đa `KEYBOARD_POPUP_MAX_W` (1100) và không quá 55% bề ngang panel — ở 2560 px là 1100,
   * đúng "giới hạn chiều rộng" mà yêu cầu nêu. Canh phải để mép trái của ô đang gõ (thường ở nửa
   * trái trang) không bị che; đáy chừa đúng một inset để popup không dính sát dock. Tách khỏi việc
   * áp vào view: overlay là một `BrowserWindow` riêng ở toạ độ màn hình, view con ở toạ độ cửa sổ.
   * Panel không scale nên hai hệ trùng nhau trên máy này, nhưng hình học vẫn chỉ tính ở đây.
   */
  private keyboardGeometry(): Rect {
    const [, height = 0] = this.window.getContentSize();
    const width = Math.max(
      320,
      Math.min(KEYBOARD_POPUP_MAX_W, Math.round(this.layout.content.width * KEYBOARD_POPUP_W_RATIO)),
    );
    const kbH = Math.min(this.keyboardHeightPx(), Math.max(160, height - this.layout.content.y - 24));
    const fallback = {
      x: this.layout.content.x + this.layout.content.width - width,
      y: this.layout.dock.y - kbH - 12,
    };
    const { x, y } = this.clampKeyboardOrigin(this.keyboardOrigin ?? fallback);
    return { x, y, width, height: kbH };
  }

  private applyKeyboardBounds(view: WebContentsView): void {
    view.setBounds(this.keyboardGeometry());
  }

  /** Hình học cho overlay, hoặc `null` khi chưa có gì để vẽ (dùng trong callback của overlay). */
  private keyboardOverlayRect(): Rect | null {
    const [, height = 0] = this.window.getContentSize();
    if (height < 200) return null;
    return this.keyboardGeometry();
  }

  /**
   * Clamps a top-left corner into the content band for the popup's current size.
   *
   * Clamped against `layout.content`, not the whole window: the popup must never slide under the
   * top bar or the dock, where the visitor could not reach its handle to drag it back. The size is
   * derived here (not stored) because it changes with the window and the persisted height.
   */
  private clampKeyboardOrigin(point: { x: number; y: number }): { x: number; y: number } {
    const [, height = 0] = this.window.getContentSize();
    const width = Math.max(
      320,
      Math.min(KEYBOARD_POPUP_MAX_W, Math.round(this.layout.content.width * KEYBOARD_POPUP_W_RATIO)),
    );
    const kbH = Math.min(this.keyboardHeightPx(), Math.max(160, height - this.layout.content.y - 24));
    const band = this.layout.content;
    return {
      x: Math.min(Math.max(Math.round(point.x), band.x), Math.max(band.x, band.x + band.width - width)),
      y: Math.min(Math.max(Math.round(point.y), band.y), Math.max(band.y, band.y + band.height - kbH)),
    };
  }

  /** Gọi từ `before-input-event` của cửa sổ chính ở mỗi lần nhấn: xem `auto-keyboard.ts`. */
  notePress(): void {
    this.autoKeyboard.notePress();
  }

  /**
   * Sends one keystroke to whichever view has focus. Remote sites keep their own virtual keyboard
   * behaviour; this injects at the Chromium input layer, exactly as if a hardware key arrived.
   *
   * NTF-R06: bản cũ gửi cả chuỗi như một `keyCode` duy nhất — `sendInputEvent` coi mỗi `keyCode` là
   * *một* phím nên "xin chào" biến thành một phím vô nghĩa và vào trang như rỗng; dấu cách đi qua
   * nhánh `space` riêng cũng cùng lý do. Nay mỗi ký tự được phát thành một cặp `char` + `keyDown` /
   * `keyUp`, đúng cách một bàn phím thật gõ từng phím, nên dấu cách, chữ hoa sau Shift và chuỗi
   * nhiều ký tự đều tới trang theo từng ký tự. Chuỗi rỗng hoặc toàn ký tự điều khiển thì bỏ qua.
   */
  sendKey(input: { kind: 'text'; data: string } | { kind: 'backspace' } | { kind: 'enter' } | { kind: 'space' }): void {
    // NTF-R08: khi khách đang gõ vào Firefox/FreeTube thì đích không phải view nào của kiosk.
    // `sendInputEvent` không với tới tiến trình ngoài, nên phím đi qua virtual keyboard của Wayland
    // (`wlrctl keyboard type` / `wtype -k`), gõ vào client đang focus — chính là ô nhập của app ngoài.
    // NTF-R17: kèm pid của **đúng app** mà popup đang phục vụ để `compositor` chọn đường gõ theo
    // *loại client* (XWayland → xdotool) thay vì theo focus — focus X nằm ở PointerRoot trong suốt
    // lúc popup mở. Chỉ lấy pid của app đã ghi lúc mở đích: khi Firefox và Chromium cùng chạy, gửi
    // pid của cả hai sẽ cho phép chọn nhầm cửa sổ X11 của app khách không nhìn thấy.
    if (this.keyboardTarget === 'external') {
      const pids = this.externalTargetPids();
      const appIds = this.externalTargetAppIds();
      if (input.kind === 'text') void typeText(input.data, pids, appIds);
      else void typeKey(input.kind, pids, appIds);
      return;
    }
    const target = this.serviceContents;
    const contents = target && !target.isDestroyed() ? target : this.navContents;
    if (contents.isDestroyed()) return;
    if (input.kind === 'text') {
      // Array.from để cắt theo codepoint: emoji và chữ Việt dựng sẵn (ế, ộ) là một ký tự, không
      // phải hai nửa surrogate bị gửi rời.
      for (const ch of Array.from(input.data)) {
        if (ch === '') continue;
        contents.sendInputEvent({ type: 'char', keyCode: ch });
        contents.sendInputEvent({ type: 'keyDown', keyCode: ch });
        contents.sendInputEvent({ type: 'keyUp', keyCode: ch });
      }
      return;
    }
    const keyCode = input.kind === 'backspace' ? 'Backspace' : input.kind === 'enter' ? 'Enter' : 'Space';
    if (input.kind === 'space') {
      // Dấu cách phải đi qua đường `char` thì trình duyệt mới chèn khoảng trắng vào ô đang gõ;
      // chỉ keyDown/keyUp 'Space' thì nhiều trang cuộn thay vì chèn.
      contents.sendInputEvent({ type: 'char', keyCode: ' ' });
    }
    contents.sendInputEvent({ type: 'keyDown', keyCode });
    contents.sendInputEvent({ type: 'keyUp', keyCode });
  }

  async stopMedia(): Promise<void> {
    const contents = this.serviceContents;
    if (!contents || contents.isDestroyed()) return;
    try {
      // Loaded cross-origin: only the media element API is reachable, never the site's JS objects.
      await contents.executeJavaScript(
        `(() => {
           for (const el of document.querySelectorAll('video,audio')) {
             try { el.pause(); el.removeAttribute('autoplay'); el.src = ''; } catch (e) {}
           }
           return true;
         })()`,
        true,
      );
    } catch {
      /* page may be mid-navigation; teardown below still releases the renderer process */
    }
    try {
      await contents.loadURL('about:blank');
    } catch {
      /* ignore */
    }
  }

  /**
   * Gỡ view nội dung. Trạng thái logic được đặt lại **ngay** (để `state()`/`pushState()` cùng tick
   * vẫn đúng), nhưng `webContents.close()` phải hoãn.
   *
   * NTF-R13: đóng webContents trong cùng tick với cú chạm đã sinh ra lệnh này làm Chromium từ chối
   * `blink.mojom.WidgetHost` và cả tiến trình chết với SIGTRAP 133. `removeChildView` thì an toàn —
   * nó chỉ bỏ view khỏi cây — nên tách một view ra khỏi màn hình là tức thời, còn huỷ tiến trình
   * render thì để macrotask sau.
   */
  private destroyServiceView(): void {
    this.stopMediaWatchdog();
    this.autoKeyboard.disarm();
    this.webAppId = null;
    this.currentId = null;
    const view = this.serviceView;
    this.serviceView = null;
    if (!view) return;
    const contents = view.webContents;
    try {
      this.window.contentView.removeChildView(view);
    } catch (error) {
      console.error('[view] cannot detach service view:', (error as Error).message);
    }
    setTimeout(() => {
      try {
        if (contents.isDestroyed()) return;
        contents.stop();
        contents.close();
      } catch (error) {
        console.error('[view] cannot dispose service view:', (error as Error).message);
      }
    }, 0);
  }

  /**
   * Rời nội dung hiện tại về Home — đường duy nhất cho cả ba lối vào (vuốt Home, tile Home ở dock,
   * nút Home trên thanh trên), nhờ vậy không lối nào còn tự phá view theo cách riêng.
   *
   * `stopMedia()` chờ `about:blank` nạp xong trước, nên khi `destroyServiceView()` chạy thì trang
   * đã ngừng phát và tiến trình render đang ở trạng thái rảnh — đúng điều kiện để đóng an toàn
   * (NTF-R13).
   */
  async leaveToHome(): Promise<void> {
    await this.stopMedia();
    this.goHome();
  }

  async open(id: ServiceId): Promise<void> {
    if (id === this.currentId) {
      this.reload();
      return;
    }
    await this.stopMedia();
    this.destroyServiceView();
    this.failed = null;

    const descriptor = SERVICES[id];
    const view = new WebContentsView({
      webPreferences: {
        preload: GESTURE_PRELOAD,
        partition: descriptor.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        safeDialogs: true,
        spellcheck: false,
        backgroundThrottling: true,
      },
    });
    this.decorateServiceView(view);
    this.serviceView = view;
    this.syncAutoKeyboard();
    this.currentId = id;
    this.webAppId = null;
    this.lastUrl = descriptor.startUrl;
    this.harden(view.webContents, 'remote');
    view.webContents.setZoomFactor(ZOOM_FACTORS[this.currentZoom[id] ?? descriptor.defaultZoom]);
    this.window.contentView.addChildView(view);
    this.window.contentView.removeChildView(this.topView);
    this.window.contentView.removeChildView(this.dockView);
    this.window.contentView.addChildView(this.topView);
    this.window.contentView.addChildView(this.dockView);
    this.layoutContent();
    // Có nội dung mới thì khung phải có mặt ngay, không chờ vòng poll 2 s nhận ra app ngoài.
    this.handlers.onContentShown();
    try {
      await view.webContents.loadURL(descriptor.startUrl);
    } catch {
      /* did-fail-load already produced the error state */
    }
    this.handlers.onLoadingChanged();
  }

  /**
   * Opens a curated single video. A bare top-level navigation to the embed URL is the only path
   * that removes YouTube's "Error 153", and on this network it still never requests media:
   * `*.googlevideo.com/videoplayback` answers 403 to this egress IP. So the embed is treated as an
   * unproven path — the media watchdog reports the failure on screen instead of leaving a black
   * rectangle that looks like a hang.
   */
  async openCurated(videoId: string): Promise<void> {
    const safeId = videoId.replace(/[^A-Za-z0-9_-]/g, '');
    if (safeId === '') return;
    await this.stopMedia();
    this.destroyServiceView();
    this.failed = null;

    const descriptor = SERVICES.youtube;
    const view = new WebContentsView({
      webPreferences: {
        preload: GESTURE_PRELOAD,
        partition: descriptor.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        safeDialogs: true,
        spellcheck: false,
      },
    });
    view.setBackgroundColor('#0A0A0A');
    this.decorateServiceView(view);
    this.serviceView = view;
    this.syncAutoKeyboard();
    this.currentId = 'youtube';
    this.lastUrl = `https://www.youtube.com/embed/${safeId}?autoplay=1&mute=1&rel=0&playsinline=1`;
    this.harden(view.webContents, 'remote');
    view.webContents.setZoomFactor(ZOOM_FACTORS[this.currentZoom.youtube ?? 'normal'] ?? 1);
    this.window.contentView.addChildView(view);
    this.window.contentView.removeChildView(this.topView);
    this.window.contentView.removeChildView(this.dockView);
    this.window.contentView.addChildView(this.topView);
    this.window.contentView.addChildView(this.dockView);
    this.layoutContent();
    this.handlers.onContentShown();
    this.startMediaWatchdog();
    try {
      await view.webContents.loadURL(this.lastUrl);
    } catch {
      /* did-fail-load already produced the error state */
    }
    this.handlers.onLoadingChanged();
  }

  /**
   * A curated embed whose media never arrives shows a control bar over a black rectangle, which
   * reads as "the machine froze". This watches the media element for 30 s and, if no frame ever
   * arrives, raises the ordinary error screen so the visitor gets a Retry button and the operator
   * gets a log line naming the real cause.
   */
  private startMediaWatchdog(): void {
    this.stopMediaWatchdog();
    this.watchdogHits = 0;
    this.watchdog = setInterval(() => {
      const contents = this.serviceContents;
      if (!contents || contents.isDestroyed()) {
        this.stopMediaWatchdog();
        return;
      }
      this.watchdogHits += 1;
      void contents
        .executeJavaScript(
          `(() => { const v = document.querySelector('video');
             if (!v) return 'no-video';
             return v.readyState >= 2 || v.currentTime > 0 ? 'ok' : 'stalled'; })()`,
          true,
        )
        .then((state: string) => {
          if (state !== 'no-video' && state !== 'stalled') {
            this.stopMediaWatchdog();
            return;
          }
          if (this.watchdogHits < 6) return;
          this.stopMediaWatchdog();
          console.error(
            `[media] video không phát sau 30s (${state}); googlevideo.com trả 403 cho IP này — xem NT_FITNESS_PHASE2_YOUTUBE_MEDIA_DIAGNOSIS.md`,
          );
          this.setFailed({
            code: -4,
            description:
              'Video không phát được trên đường mạng hiện tại. Máy chủ media của YouTube từ chối kết nối từ IP này.',
          });
        })
        .catch(() => this.stopMediaWatchdog());
    }, 5000);
  }

  private stopMediaWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  goHome(): void {
    this.destroyServiceView();
    this.failed = null;
    this.lastUrl = '';
    this.crashReloads = 0;
    this.handlers.onContentHidden();
    this.handlers.onLoadingChanged();
  }

  /**
   * Opens a dock web app (Google search, m.youtube.com). Same hardened remote view as a service,
   * so it inherits Chrome-sandbox, blocked downloads and denied permissions without extra work.
   */
  async openWebApp(id: string): Promise<void> {
    const app = WEB_APPS[id];
    if (!app) return;
    if (this.webAppId === id) {
      this.reload();
      return;
    }
    await this.stopMedia();
    this.destroyServiceView();
    this.failed = null;

    const view = new WebContentsView({
      webPreferences: {
        preload: GESTURE_PRELOAD,
        partition: app.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        safeDialogs: true,
        spellcheck: false,
        backgroundThrottling: true,
      },
    });
    view.setBackgroundColor('#0A0A0A');
    this.decorateServiceView(view);
    this.serviceView = view;
    this.syncAutoKeyboard();
    this.webAppId = id;
    this.currentId = null;
    this.lastUrl = app.startUrl;
    this.harden(view.webContents, 'remote');
    view.webContents.setZoomFactor(ZOOM_FACTORS[this.currentZoom[id] ?? app.defaultZoom]);
    this.window.contentView.addChildView(view);
    this.window.contentView.removeChildView(this.topView);
    this.window.contentView.removeChildView(this.dockView);
    this.window.contentView.addChildView(this.topView);
    this.window.contentView.addChildView(this.dockView);
    this.layoutContent();
    this.handlers.onContentShown();
    try {
      await view.webContents.loadURL(app.startUrl);
    } catch {
      /* did-fail-load already produced the error state */
    }
    this.handlers.onLoadingChanged();
  }

  /**
   * Test-only: shows an arbitrary local page or server file in the service slot. Used by the
   * playback probe to measure decode on this GPU without a platform login, so it never ships in
   * the dock flow — no dock entry or nav button calls it.
   */
  async mountProbeUrl(url: string): Promise<void> {
    await this.stopMedia();
    this.destroyServiceView();
    this.failed = null;
    const view = new WebContentsView({
      webPreferences: {
        preload: GESTURE_PRELOAD,
        partition: PROBE_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: false,
      },
    });
    const opened = new Promise<void>((resolve) => {
      view.webContents.once('did-finish-load', () => resolve());
      view.webContents.once('did-fail-load', () => resolve());
    });
    view.setBackgroundColor('#0A0A0A');
    this.decorateServiceView(view);
    this.serviceView = view;
    this.syncAutoKeyboard();
    this.currentId = 'youtube';
    this.lastUrl = url;
    // Probe pages are either the app's own HTML or a bare remote embed; neither may navigate to
    // file:// or run javascript:, so they get the same hardening as a real service view.
    this.harden(view.webContents, url.startsWith('file:') ? 'local' : 'remote');
    this.window.contentView.addChildView(view);
    this.window.contentView.removeChildView(this.topView);
    this.window.contentView.removeChildView(this.dockView);
    this.window.contentView.addChildView(this.topView);
    this.window.contentView.addChildView(this.dockView);
    this.layoutContent();
    this.handlers.onContentShown();
    await view.webContents.loadURL(url).catch(() => undefined);
    await opened;
    this.handlers.onLoadingChanged();
  }

  back(): void {
    const contents = this.serviceContents;
    if (contents) {
      if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
      // NTF-R13: hết lịch sử thì "Back" chính là "về Home", nên phải đi đúng đường dọn duy nhất —
      // dừng media rồi mới gỡ view — chứ không gọi thẳng `goHome()`. Gọi thẳng ở đây để lại một
      // trang còn đang phát bị gỡ khỏi cây trong cùng tick với cú chạm.
      else void this.leaveToHome();
      return;
    }
    this.navContents.send('ntf:navigate', { action: 'back' });
  }

  forward(): void {
    const contents = this.serviceContents;
    if (contents && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    else this.navContents.send('ntf:navigate', { action: 'forward' });
  }

  reload(): void {
    const contents = this.serviceContents;
    if (contents) {
      // Hiện lại view trước khi nạp: nếu đang ở trạng thái lỗi thì view đã bị ẩn (NTF-R03), và
      // "Thử lại" chỉ có nghĩa nếu lớp nội dung quay lại ngay từ lúc bắt đầu nạp.
      if (this.failed !== null) this.setFailed(null);
      contents.reload();
      return;
    }
    this.navContents.send('ntf:navigate', { action: 'reload' });
  }

  stop(): void {
    this.serviceContents?.stop();
    this.navContents.send('ntf:navigate', { action: 'stop' });
  }

  private layoutContent(): void {
    if (!this.serviceView) return;
    this.serviceView.setBounds({
      x: this.layout.content.x,
      y: this.layout.content.y,
      width: this.layout.content.width,
      height: this.contentHeight(),
    });
  }

  private applyZoom(): void {
    const payload = { serviceId: this.currentId, webAppId: this.webAppId, level: this.currentZoomLevel() };
    this.navContents.send('ntf:zoom-changed', payload);
    this.topContents.send('ntf:zoom-changed', payload);
  }

  state(): NavState {
    const contents = this.serviceContents;
    const url = contents && !contents.isDestroyed() ? contents.getURL() : '';
    let host = '';
    try {
      host = url && url !== 'about:blank' ? new URL(url).host : '';
    } catch {
      host = '';
    }
    return {
      serviceId: this.currentId,
      webAppId: this.webAppId,
      canGoBack: Boolean(contents?.navigationHistory.canGoBack()),
      canGoForward: Boolean(contents?.navigationHistory.canGoForward()),
      loading: Boolean(contents?.isLoading()),
      title: contents && !contents.isDestroyed() ? contents.getTitle() : '',
      currentHost: host,
      failed: this.failed,
      zoom: this.currentZoomLevel(),
    };
  }

  dockState(): DockState {
    return {
      active: this.currentId,
      webAppId: this.webAppId,
      keyboardOpen: this.keyboardVisible,
      inContent: Boolean(this.serviceView),
    };
  }
}
