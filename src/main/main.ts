import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron';
import { extname, join } from 'node:path';
import { copyFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { ViewManager } from './view-manager.js';
import { trace } from './trace.js';
import { NewsCache } from './news-cache.js';
import { SettingsStore } from './settings.js';
import { SystemMonitor } from './system-monitor.js';
import {
  clearAllServiceSessions,
  createHardenedSessions,
  DEFAULT_WALLPAPER,
  isSafeUrl,
  loadSettings,
  saveSettings,
} from './security.js';
import {
  NEWS_FEEDS,
  SERVICES,
  SERVICE_ORDER,
  WEB_APPS,
  isZoomLevel,
  type ServiceId,
  type ZoomLevel,
} from '../shared/services.js';
import { KEYBOARD_DEFAULT_H, type GestureKind } from '../shared/chrome.js';
import type { AppSettings, FrameSettings, PanelGeometry } from '../shared/ipc.js';
import { WALLPAPERS, IDLE_DEFAULT_MS } from '../shared/ipc.js';
import { framePartRects, framePartsFor, layoutFor } from './layout.js';
import { FrameWindows } from './frame-window.js';
import { frontExternalApp, scanExternalApps } from './external-apps.js';
import { createDockActionHandler, parseDockAction } from './dock-actions.js';
import { registerChromeIpc } from './ipc-chrome.js';
import { registerGestureIpc } from './gesture-ipc.js';
import { registerNavIpc } from './nav-ipc.js';
import { registerSwipeIpc } from './swipe-ipc.js';
import { Screensaver } from './screensaver.js';
import { PanelHost } from './panel-host.js';
import { applyGpuCommandLine } from './gpu-flags.js';

/**
 * Vòng đời kiosk: một cửa sổ, các view bên trong, khung băng nội dung, và những kênh IPC còn lại
 * (cử chỉ cạnh, nav, tin tức, hình nền). Tệp này cố tình không quyết định nghiệp vụ nào — chạm dock
 * ở `dock-actions.ts`, app ngoài ở `external-apps.ts`, bridge thanh trên ở `ipc-chrome.ts`, bàn phím
 * ảo ở `auto-keyboard.ts`, âm lượng ở `volume.ts`, khung và nút ✕ ở `frame-window.ts`.
 */

const argv = process.argv.slice(1);
const devMode = argv.includes('--ntf-dev');

applyGpuCommandLine(app, devMode);

app.setName('NT Fitness Touch');
app.setPath('userData', join(app.getPath('appData'), 'ntfitness-online'));

let window: BrowserWindow | null = null;
let views: ViewManager | null = null;
let store: SettingsStore | null = null;
let news: NewsCache | null = null;
let frame: FrameWindows | null = null;

/**
 * Màn hình chờ. `null` cho tới khi `bootstrap()` dựng xong cửa sổ — mọi thứ gọi nó trước đó
 * (nút Khóa ở dock, IPC của menu Nguồn) phải chịu được `null`, nên các hàm dưới dùng `screensaver?.`.
 *
 * Toàn bộ phần thân nằm trong `screensaver.ts`: tệp này chỉ nối dây, vì hình học panel, phép đo media
 * và việc đọc nút evdev đều là câu hỏi main process trả lời được mà không cần biết gì về dock.
 */
let screensaver: Screensaver | null = null;

/**
 * Ba thẻ nổi (Cài đặt, Âm lượng, Nguồn). Cũng là `null` trước `bootstrap()` — nhưng khác màn hình
 * chờ ở chỗ nó **tự dựng cửa sổ khi mở lần đầu**, nên chỗ gọi không phải kiểm `null` trước khi mở:
 * một cú chạm vào bánh răng lúc panel vừa lên vẫn phải mở được thẻ.
 */
let panelHost: PanelHost | null = null;

const monitor = new SystemMonitor();

/**
 * Drag feedback goes to the dock page, which draws a thin edge indicator. Sent as a fire-and-forget
 * message: a frame lost while the views are being rebuilt is invisible to the visitor.
 */
function sendGesture(kind: GestureKind | null, progress: number): void {
  try {
    views?.dockContents.send('ntf:gesture', { kind, progress });
  } catch {
    /* dock can be mid-navigation */
  }
}

/**
 * Cấu hình hiện tại, hoặc bộ mặc định đủ dùng trước khi `store` mở xong tệp cài đặt. Trả về bản sao
 * mặc định chứ không `null` để mọi chỗ gọi đọc thuộc tính trực tiếp được.
 */
function currentSettings(): AppSettings {
  return (
    store?.get() ?? {
      zoom: {} as AppSettings['zoom'],
      uiZoom: 'normal',
      keyboardScale: KEYBOARD_DEFAULT_H,
      keyboardOrigin: null,
      wallpaper: DEFAULT_WALLPAPER,
      wallpaperImage: '',
      idleTimeoutMs: IDLE_DEFAULT_MS,
      keepAwakeOnMedia: false,
    }
  );
}

/** Nhịp tối thiểu giữa hai lần hỏi compositor "app nào đang ở phía trước". */
const FRONT_LABEL_MS = 500;

/**
 * Nhãn app ngoài đang ở phía trước, `''` khi không có app nào. `frontExternalApp()` là async (hỏi
 * `wlrctl` từng nhóm, chờ tới 4×120 ms) nên không gọi được trong `pushState()` vốn đồng bộ; đây là
 * bản **đã đo xong** và `pushState()` chỉ đọc nó.
 */
let lastFrontLabel = '';
let frontLabelBusy = false;
let frontLabelAt = 0;

function refreshFrontLabel(): void {
  const now = Date.now();
  // Chặn cả theo nhịp lẫn theo lần gọi đang bay: mỗi lần đo mở một loạt `wlrctl`, mà vòng poll chỉ
  // cách nhau 2 s và mỗi lần đóng app lại kéo thêm một lần đo nữa.
  if (frontLabelBusy || now - frontLabelAt < FRONT_LABEL_MS) return;
  frontLabelAt = now;
  frontLabelBusy = true;
  void frontExternalApp()
    .catch(() => null)
    .then((group) => {
      frontLabelBusy = false;
      const label = group?.label ?? '';
      if (label === lastFrontLabel) return;
      lastFrontLabel = label;
      pushState();
    });
}

function pushState(): void {
  if (!views) return;
  const state = views.state();
  const frontLabel = lastFrontLabel;
  try {
    views.navContents.send('ntf:state', state);
  } catch {
    /* nav page can be mid-navigation */
  }
  try {
    views.dockContents.send('ntf:dock', views.dockState());
  } catch {
    /* dock page can be mid-navigation */
  }
  try {
    views.topContents.send('ntf:top-state', {
      // App ngoài phủ lên kiosk thì nhãn của nó thắng tiêu đề trang nhúng bên dưới, vì đó là thứ
      // người dùng đang nhìn; không có app nào ở trước thì rơi về đúng chuỗi cũ.
      title:
        frontLabel ||
        state.title ||
        (state.serviceId
          ? SERVICES[state.serviceId].label
          : state.webAppId ? (WEB_APPS[state.webAppId]?.label ?? '') : ''),
      loading: state.loading,
      failed: Boolean(state.failed),
      description: state.failed?.description ?? '',
      // F16: "Quay lại"/"Đóng ứng dụng" chỉ có nghĩa khi phía sau thanh trên có thứ để quay về hoặc
      // để đóng — băng nội dung nhúng, hoặc một app ngoài đang ở phía trước.
      inContent: frontLabel !== '' || views.hasVisibleContent(),
    });
  } catch {
    /* top bar can be mid-navigation */
  }
}

/**
 * Tells the top bar whether the ✕ should be visible, and shows or hides the whole frame with it.
 *
 * Khung và nút đi cùng một cờ vì với người dùng chúng là một vật thể: hiện khung mà không có nút thì
 * không đóng được app ngoài, còn hiện nút mà không có khung thì nút lơ lửng trên trang của kiosk.
 * Kept local so `handleDockAction` — which rebuilds the whole chrome — does not depend on the poll
 * loop's closure, and so the initial state is sent at the same moment as the rest of the chrome.
 */
let lastAppsLabels: string[] = [];

function pushApps(labels: string[]): void {
  lastAppsLabels = labels;
  const running = labels.length > 0;
  // Không còn app ngoài nào thì nhãn phía trước hết hiệu lực ngay trong tick này — chờ vòng đo async
  // sẽ để thanh trên hiện tên app đã đóng thêm một nhịp.
  if (!running && lastFrontLabel !== '') {
    lastFrontLabel = '';
    pushState();
  }
  // NTF-R01: khung đi theo app ngoài **hoặc** theo nội dung nhúng, không chỉ app ngoài. Bốn góc bo
  // của băng nội dung là việc của `onContentShown`/`onContentHidden`; ở đây chỉ cộng thêm điều kiện
  // "có app ngoài thì chắc chắn phải có nút ✕", và chỉ ẩn khi cả hai nguồn đều không cần khung.
  if (running) {
    frame?.setVisible(true);
    frame?.raise();
    // App ngoài vừa map nằm trên theo thứ tự map của labwc, kể cả trên cửa sổ always-on-top; popup
    // bàn phím đang phục vụ app ngoài phải được raise lại, nếu không nó biến mất sau mỗi lần mở app.
    views?.raiseKeyboardOverlay();
  } else if (!views?.hasVisibleContent()) {
    frame?.setVisible(false);
  }
  if (!views) return;
  try {
    views.topContents.send('ntf:apps', { running, labels });
  } catch {
    /* top bar can be mid-navigation */
  }
  // Vòng poll chỉ biết "nhóm nào còn chạy", không biết nhóm nào ở trước và không thấy cú minimize;
  // thanh trên cần cả hai nên mỗi tick phải đo lại nhãn phía trước.
  refreshFrontLabel();
}

/** Ước lượng an toàn của `layoutFor` khi cửa sổ chưa kịp đo: panel mặc định của dự án. */
const FALLBACK_PANEL = { width: 2560, height: 1600 };

/**
 * Hình học cần cho bốn ô mặt nạ góc, đo từ chính cửa sổ kiosk.
 *
 * Không dùng `screen.getPrimaryDisplay()` ở đây vì nó chỉ đúng lúc khởi động: khi panel đổi độ
 * phân giải, `fitPanel()` ghi lại kích thước cửa sổ trước rồi mới `relayout()`, nên kích thước cửa
 * sổ là nguồn duy nhất luôn khớp với vị trí bốn mảnh khung thật.
 */
function panelGeometry(): PanelGeometry {
  const [width = 0, height = 0] = window ? window.getContentSize() : [0, 0];
  const panel = width > 0 && height > 0 ? { width, height } : FALLBACK_PANEL;
  const parts = framePartsFor(layoutFor(panel.width, panel.height).content);
  const patch = (rect: { x: number; y: number; width: number }) => ({
    x: rect.x,
    y: rect.y,
    size: rect.width,
  });
  return {
    width: panel.width,
    height: panel.height,
    corners: {
      tl: patch(parts.cornerTL),
      tr: patch(parts.cornerTR),
      bl: patch(parts.cornerBL),
      br: patch(parts.cornerBR),
    },
  };
}

/**
 * Đẩy hình nền hiện tại + hình học panel xuống các cửa sổ khung.
 *
 * Bốn ô mặt nạ ở góc băng phải vẽ *đúng* bức hình nền đang hiện, nếu không chúng thành bốn ô lệch
 * màu — tệ hơn hẳn cái góc vuông mà chúng định che. Chỉ gửi id hình nền là không đủ: mặt nạ rộng
 * 26 px nên nó phải biết cắt mảnh nào ra khỏi hình nền cỡ panel, tức là cần cả toạ độ của chính nó.
 * Đổi hình nền từ dock là lúc duy nhất hình nền đổi, nên đẩy ở đó là đủ; `did-finish-load` của mỗi
 * mảnh khung cũng gọi lại, vì cửa sổ khung có thể nạp xong sau lần đổi đầu tiên.
 */
function pushSettings(): void {
  frame?.broadcast('ntf:settings', {
    settings: currentSettings(),
    geometry: panelGeometry(),
  } satisfies FrameSettings);
}

/**
 * Tỉ lệ cho giao diện đọc của chính ứng dụng (Home, thanh trên).
 *
 * Nhỏ hơn `ZOOM_FACTORS` ở mọi mức vì đây là chữ của *chúng ta* trên một tấm 2560×1600 đặt cách một
 * mét, không phải chữ của một trang web mà khách đã quen cỡ. Mức cuối cùng là 1.6 — không phải 2.0 —
 * vì ở 2.0 thanh trên cao 88 px và dock ăn mất gần một phần tư chiều cao panel ở chế độ đọc.
 */
function zoomFactorForUi(level: ZoomLevel): number {
  switch (level) {
    case 'large':
      return 1.15;
    case 'xlarge':
      return 1.3;
    case 'xxlarge':
      return 1.6;
    default:
      return 1;
  }
}

function relayout(): void {
  if (!window || !views) return;
  views.navContents.setZoomFactor(zoomFactorForUi(currentSettings().uiZoom));
  views.resize();
  const [width = 0, height = 0] = window.getContentSize();
  frame?.apply(framePartRects(framePartsFor(layoutFor(width, height).content)));
}

/**
 * Sizes the kiosk to the whole panel without using fullscreen.
 *
 * Under labwc a fullscreen window is raised to the top layer, which would put the kiosk's opaque
 * wallpaper above any external app the dock launches — the app would still be running, hidden, with
 * no taskbar to get it back. A plain borderless window at 0,0 of the panel's exact size occupies the
 * same pixels while staying on the normal layer, where gen-labwc-config.sh pins it to the bottom.
 */
function fitPanel(): void {
  if (!window) return;
  const { width, height } = screen.getPrimaryDisplay().size;
  window.setBounds({ x: 0, y: 0, width, height });
  relayout();
}

async function endSession(): Promise<boolean> {
  if (!window || !views) return false;
  const { response } = await dialog.showMessageBox(window, {
    type: 'question',
    buttons: ['Hủy', 'Kết thúc phiên'],
    defaultId: 0,
    cancelId: 0,
    title: 'Kết thúc phiên',
    message: 'Kết thúc phiên và xóa dữ liệu duyệt web?',
    detail:
      'Video sẽ dừng, phiên đăng nhập demo của các dịch vụ sẽ bị xóa khỏi máy này. ' +
      'Dùng khi khách đã rời máy, không dùng khi khách còn đang xem video.',
  });
  if (response !== 1) return false;
  // NTF-R13: `leaveToHome()` chờ `about:blank` nạp xong trước khi gỡ view. Đây là hành động quản
  // trị (xóa dữ liệu duyệt web), tách hẳn khỏi nút đóng app dành cho khách — xem `close-app`.
  await views.setKeyboardOpen(false);
  await views.leaveToHome();
  await clearAllServiceSessions();
  news?.clear();
  pushState();
  return true;
}

/** Mọi thứ xảy ra khi một mục trên dock được chạm (xem `dock-actions.ts`). */
const handleDockAction = createDockActionHandler({
  views: () => views,
  store: () => store,
  pushState,
  endSession,
  lock: async () => screensaver?.lock(),
  // NTF-R09: sau khi đóng app ngoài, hàng đợi tile phải cập nhật ngay thay vì chờ nhịp poll 2 s.
  pushApps: () => pushApps(lastAppsLabels),
});

/**
 * Copies the visitor's chosen picture into userData so the wallpaper survives the file being moved,
 * and so no page ever receives a path the visitor typed. Only raster image types are accepted: an
 * SVG or an HTML file rendered as a wallpaper would be a script in the shell's origin.
 */
async function pickWallpaperImage(): Promise<string | null> {
  if (!window) return null;
  const result = await dialog.showOpenDialog(window, {
    title: 'Chọn hình nền',
    properties: ['openFile'],
    filters: [{ name: 'Ảnh', extensions: ['jpg', 'jpeg', 'png', 'webp', 'avif'] }],
  });
  const source = result.filePaths[0];
  if (result.canceled || !source) return null;
  const ext = extname(source).toLowerCase().replace('.', '');
  if (!['jpg', 'jpeg', 'png', 'webp', 'avif'].includes(ext)) return null;
  try {
    const dir = join(app.getPath('userData'), 'wallpapers');
    mkdirSync(dir, { recursive: true });
    const target = join(dir, `wallpaper-${Date.now()}.${ext}`);
    copyFileSync(source, target);
    // Only one image is ever needed; drop the previous one so the folder cannot grow per crash.
    for (const name of readdirSync(dir)) {
      if (name.startsWith('wallpaper-') && join(dir, name) !== target) {
        try {
          unlinkSync(join(dir, name));
        } catch {
          /* a file locked by the compositor is not worth failing the whole pick */
        }
      }
    }
    return target;
  } catch (error) {
    console.error('[wallpaper] copy failed:', (error as Error).message);
    return null;
  }
}

function registerIpc(): void {
  const panels = new PanelHost({
    read: currentSettings,
    // Một lần ghi đĩa cho một cú chạm Lưu: `setPanelPolicy` cập nhật cả hai khoá trong bộ nhớ rồi trả
    // ảnh chụp mới, `saveSettings` ghi đúng ảnh chụp đó. Ghi riêng từng khoá sẽ là hai lần ghi tệp.
    write: (patch) => {
      if (!store) return currentSettings();
      const next = store.setPanelPolicy(patch);
      saveSettings(next);
      return next;
    },
    lock: () => screensaver?.lock(),
    // Bộ đếm nhàn rỗi chỉ cần dựng lại khi bật lại từ trạng thái tắt, nên `refresh()` đã xử lý phần
    // còn lại; gọi ở đây để tắt hẳn khi người dùng chọn "Không khóa".
    onPolicyChanged: () => screensaver?.refresh(),
    getZoom: () => views?.currentZoomLevel() ?? null,
    setZoom: (level) => {
      if (!views || !store) return null;
      const id = views.activeService;
      if (!id) return null;
      saveSettings(store.setZoom(id, level));
      views.setZoomMap(store.get().zoom);
      pushState();
      return views.currentZoomLevel();
    },
  });
  panelHost = panels;

  registerChromeIpc({
    views: () => views,
    store: () => store,
    monitor,
    currentSettings,
    frameSettings: (): FrameSettings => ({ settings: currentSettings(), geometry: panelGeometry() }),
    pushState,
    pushApps,
    parseAction: parseDockAction,
    handleDockAction,

    // Màn hình chờ: `lock()` không đi qua `ViewManager` (xem `screensaver.ts`), và `lockState()` phải
    // trả lời được cả khi panel chưa dựng xong cửa sổ — lúc đó chưa có gì bị khóa, nên `false` đúng.
    lock: () => screensaver?.lock(),
    lockState: () => ({ locked: screensaver?.locked ?? false }),
    requestUnlock: (at: number) => screensaver?.requestUnlock(at) ?? false,
    /*
     * Ba thẻ nổi. Toàn bộ phần thân nằm trong `panel-host.ts` — tệp này chỉ nối dây, vì nó đã vượt
     * trần 300 dòng và vì ba thẻ dùng chung đúng bốn việc (cửa sổ, chính sách, PIN, lệnh hệ thống).
     */
    openPanel: (id) => panels.open(id),
    closePanel: (id) => panels.close(id),
    panelPolicy: () => panels.policy(),
    writePanelPolicy: (patch) => panels.writePolicy(patch),
    // Cỡ chữ: uỷ quyền cho `PanelHost`, nơi đã giữ đúng hai closure dưới đây. Viết lại lần thứ hai ở
    // tệp này là hai bản sao của cùng một phép ghi, và bản sao thứ hai sẽ cũ đi sau lần sửa đầu tiên.
    currentZoom: () => panels.zoom(),
    setZoom: (level) => panels.setZoom(level),
    exitToConsole: (code) => panels.exitToConsole(code),
    powerAction: (kind, code) => panels.powerAction(kind, code),
  });

  /*
   * Cử chỉ cạnh và cú chạm: toàn bộ phần thân nằm trong `gesture-ipc.ts`, vì đó là mười lần đăng ký
   * kênh dùng chung đúng một luật tin cậy sender — và luật đó phải sửa được mà không chạm tệp này.
   */
  registerGestureIpc({ views: () => views, sendGesture, pushState });
  registerSwipeIpc({ views: () => views });

  ipcMain.handle('nav:state', () => views?.state() ?? null);
  ipcMain.handle('nav:settings', () => currentSettings());
  ipcMain.handle('nav:ui-zoom', (_event, level: ZoomLevel) => {
    if (!store || !isZoomLevel(level)) return currentSettings();
    const settings = store.setUiZoom(level);
    saveSettings(settings);
    relayout();
    return settings;
  });

  /*
   * Hình nền, điều hướng và tin tức: toàn bộ phần thân nằm trong `nav-ipc.ts`, cùng lý do với
   * `gesture-ipc.ts` — mười bốn kênh liền mạch mà tệp này đã vượt trần nợ 720 dòng.
   */
  registerNavIpc({
    views: () => views,
    store: () => store,
    news: () => news,
    currentSettings,
    pushState,
    pushSettings,
    pickWallpaperImage,
  });
}

async function bootstrap(): Promise<void> {
  createHardenedSessions();

  const settings = loadSettings();
  store = new SettingsStore(settings);
  news = new NewsCache(join(app.getPath('userData'), 'news-cache'));

  const display = screen.getPrimaryDisplay();
  const { width, height } = display.size;

  window = new BrowserWindow({
    x: 0,
    y: 0,
    width,
    height,
    // Must be visible from the start: with show:false and no loadURL, Electron never commits a
    // buffer, so the compositor draws only its black background plus the cursor.
    show: true,
    frame: false,
    fullscreen: false,
    autoHideMenuBar: true,
    backgroundColor: '#0A0A0A',
    title: 'NT Fitness Touch',
    webPreferences: {
      // The window itself renders nothing: all pixels come from WebContentsView children.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  window.setMenuBarVisibility(false);

  views = new ViewManager(window, {
    onLoadingChanged: pushState,
    onTitleChanged: pushState,
    // NTF-R01: khung bo góc đi theo *nội dung*, không đi theo app ngoài. Trước đây `setVisible` chỉ
    // được gọi từ `pushApps()`, nên băng nội dung nhúng của kiosk (Tin tức, Google, TikTok…) luôn là
    // một hình vuông nhọn và khung chỉ xuất hiện khi có Firefox/FreeTube — báo cáo QA đo độ trễ
    // 0.51–4.11 s. Hai callback này báo đúng lúc băng có/không có gì để vẽ.
    onContentShown: () => {
      frame?.setVisible(true);
      frame?.raise();
    },
    onContentHidden: () => {
      // Chỉ ẩn khi không còn app ngoài nào chạy: nút ✕ vẫn phải dùng được trên cửa sổ Firefox đang
      // phủ băng, kể cả khi băng nội dung của kiosk đã về Home.
      if (lastAppsLabels.length === 0) frame?.setVisible(false);
    },
    onAutoKeyboard: (editable) => {
      trace(`onAutoKeyboard editable=${String(editable)} kbVisible=${String(views?.keyboardVisible)}`);
      if (!views) return;
      // Đích external thì trang của kiosk không phải nơi nhận phím; bộ dò chỉ đọc được view nội bộ
      // nên mọi kết luận của nó ở trạng thái đó đều sai (nó sẽ đóng popup đang phục vụ Firefox).
      if (views.keyboardTargetValue === 'external') return;
      // Leaving the field closes the keyboard. Entering one opens it, but only through the tap path
      // (notePress), so a poll can never pop the keyboard up in the middle of a video.
      if (!editable) {
        void views.setKeyboardOpen(false);
        return;
      }
      if (views.keyboardVisible) return;
      void views.setKeyboardOpen(true).then(() => pushState());
    },
  });
  views.setZoomMap(settings.zoom as Record<ServiceId, ZoomLevel>);
  // Vị trí bàn phím đã lưu phải nạp ngay tại đây, cùng chỗ với zoom: `setKeyboardOrigin` là đường
  // duy nhất đẩy giá trị từ đĩa vào ViewManager, và nếu bỏ dòng này thì bàn phím luôn mở ở góc mặc
  // định dù người dùng đã kéo đi chỗ khác ở phiên trước.
  views.setKeyboardOrigin(settings.keyboardOrigin ?? null);
  // Same reason for the height: `keyboardScale` on disk drives both the popup's own height and the
  // vertical room a moved popup has to stay inside. Seeding only the origin left the first open
  // using the 260 px default while the saved height was 470 px, so the clamp ran against the wrong
  // box and the popup jumped by the difference on the next drag.
  views.setKeyboardScale(settings.keyboardScale);

  // Khung băng nội dung: chín cửa sổ trong suốt nằm trên app ngoài. Dựng sau cửa sổ kiosk để không
  // bao giờ trở thành cửa sổ đầu tiên — cửa sổ đầu tiên nhận hình học của output và không được
  // commit, và labwc không cho cửa sổ thứ hai trong cùng tiến trình lên trên nếu nó map trước.
  frame = new FrameWindows(window);
  // Hình học truyền ngay lúc tạo, không đặt sau: cửa sổ `resizable: false` phải khai báo kích
  // thước cố định ngay từ đầu để labwc xếp nó vào `type="dialog"` và bỏ qua rule đại trà.
  frame.create(framePartRects(framePartsFor(layoutFor(width, height).content)));
  // Hình nền phải có mặt trước khi cửa sổ khung kịp vẽ: bốn ô mặt nạ góc không có nó là bốn ô đen.
  // `broadcast` giữ bản cuối và phát lại ở `did-finish-load`, nên gọi ngay tại đây là đủ cho cả
  // chín cửa sổ dù chúng nạp xong muộn hơn.
  pushSettings();

  relayout();
  views.load();

  /**
   * Màn hình chờ dựng **sau** khung băng: nó gọi `overlay.create()` ngay trong `start()`, và
   * `overlay.create()` tạo một `BrowserWindow`. Labwc xếp cửa sổ theo thứ tự map, nên cửa sổ nào map
   * sau sẽ nằm trên — dựng nó trước khung là để khung phủ lên màn hình chờ.
   *
   * Toàn bộ phần thân ở `screensaver.ts`; tệp này chỉ truyền bốn câu trả lời chỉ main process biết.
   */
  screensaver = new Screensaver({
    panelSize: panelGeometry,
    timeoutMs: () => currentSettings().idleTimeoutMs,
    keepAwakeOnMedia: () => currentSettings().keepAwakeOnMedia,
    activeContents: () => views?.activeContents() ?? null,
    hidePanels: () => panelHost?.hideAll(),
  });
  screensaver.start();

  window.once('ready-to-show', () => {
    fitPanel();
    window?.focus();
    pushState();
  });
  // ready-to-show does not fire when the window webContents has no document, so make sure the
  // kiosk covers the panel and is visible regardless.
  window.show();
  fitPanel();
  window.focus();
  pushState();
  monitor.start((status) => {
    try {
      views?.topContents.send('ntf:clock', status);
    } catch {
      /* top bar can be mid-navigation during the first second */
    }
  });
  // External windows (FreeTube, Firefox, Chromium) live above the kiosk, so they can cover the
  // content but never the bar. Polling is the only way to learn about them: they are not our
  // BrowserViews and labwc does not report a client list we can subscribe to.
  let lastAppsKey = '';
  const pollApps = () => {
    const scan = scanExternalApps();
    const key = scan.labels.join(',');
    if (key !== lastAppsKey) {
      lastAppsKey = key;
      pushApps(scan.labels);
    }
    // Gọi ngoài nhánh "danh sách đổi": minimize FreeTube không làm danh sách tiến trình đổi, nên nếu
    // chỉ đo khi danh sách đổi thì thanh trên giữ mãi tên app đã bị thu nhỏ.
    refreshFrontLabel();
  };
  setInterval(pollApps, 2000).unref();
  pollApps();
  // The strip is a separate WebContents and can reload or be recreated without the main process
  // noticing, so the poll's "only on change" optimisation would leave it blank after a load. Re-send
  // the last known list once the document is ready.
  views.topContents.on('did-finish-load', () => {
    pushApps(lastAppsLabels);
    pushState();
  });
  if (argv.includes('--ntf-probe')) {
    void import('./probe.js').then((probe) => probe.runProbe(views!));
  }
  if (argv.includes('--ntf-probe-services')) {
    void import('./probe-services.js').then((probe) => probe.runServiceProbe(views!));
  }
  if (argv.includes('--ntf-probe-player')) {
    void import('./probe-player.js').then((probe) => probe.runPlayerProbe(views!));
  }
  if (argv.includes('--ntf-probe-embed')) {
    void import('./probe-embed.js').then((probe) => probe.runEmbedProbe(views!));
  }
  if (argv.includes('--ntf-probe-watchdog')) {
    void import('./probe-watchdog.js').then((probe) => probe.runWatchdogProbe(views!));
  }
  const shotIdx = argv.indexOf('--ntf-probe-shot');
  if (shotIdx !== -1) {
    const outPath = argv[shotIdx + 1] ?? '/tmp/ntf-shot';
    void import('./probe-shot.js').then((probe) => probe.runShotProbe(views!, outPath));
  }
  window.on('resize', () => {
    relayout();
    // Màn hình chờ phủ toàn panel, nên đổi cỡ là đổi cả nó. Không gọi khi đang ẩn: `show()` đặt lại
    // hình học mỗi lần, nên đường ẩn không cần biết panel đã to ra.
    screensaver?.resize();
  });
  window.on('closed', () => {
    // Thứ tự ngược với lúc dựng: màn hình chờ là cửa sổ map sau cùng nên phải đóng trước, nếu không
    // nó ở lại trên màn hình trong lúc các cửa sổ khác đang bị gỡ.
    screensaver?.dispose();
    screensaver = null;
    panelHost?.destroy();
    frame?.destroy();
    frame = null;
    views?.dispose();
    views = null;
    window = null;
  });

  // Only our local shell page may live in the window webContents; it never navigates away.
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  registerIpc();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    fitPanel();
    window?.focus();
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('before-input-event', (event, input) => {
      // Escape leaves a service instead of exposing a desktop or a debug console.
      if (input.type === 'keyDown' && input.key === 'Escape' && views) {
        event.preventDefault();
        // Cùng một đường dọn với vuốt Home / tile Home (NTF-R13): dừng media, chờ trang trống nạp
        // xong rồi mới gỡ view, thay vì `stopMedia()` không chờ + `goHome()` trong cùng một tick.
        void views.setKeyboardOpen(false);
        void views.leaveToHome().then(pushState).catch(() => pushState());
      }
    });
  });

  app.whenReady().then(bootstrap).catch((error: unknown) => {
    console.error('[main] bootstrap failed:', (error as Error).stack ?? error);
    app.exit(1);
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    monitor.stop();
  });

  process.on('uncaughtException', (error) => {
    console.error('[main] uncaught exception:', error.stack ?? error.message);
  });
}
