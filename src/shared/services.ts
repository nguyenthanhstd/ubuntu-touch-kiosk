export type ServiceId = 'youtube' | 'tiktok' | 'instagram' | 'facebook' | 'news';

/**
 * A browser-hosted site the dock can open. These are *the same Chromium engine* as the WebContentsView
 * services above, just a different destination: the dock does not ship a second browser, because the
 * kiosk must always be able to come back to Home and no foreign app may paint over the panel.
 */
export interface WebAppDescriptor {
  id: string;
  label: string;
  startUrl: string;
  partition: string;
  defaultZoom: ZoomLevel;
  note: string;
}

export const WEB_APPS: Record<string, WebAppDescriptor> = {
  youtubeCom: {
    id: 'youtubeCom',
    label: 'YouTube.com',
    startUrl: 'https://m.youtube.com/',
    partition: 'persist:ntf-youtube',
    defaultZoom: 'large',
    note: 'Giao diện web YouTube dành cho cảm ứng. Dùng chung phiên với YouTube trong launcher.',
  },
  google: {
    id: 'google',
    label: 'Tìm kiếm',
    startUrl: 'https://www.google.com/',
    partition: 'persist:ntf-google',
    defaultZoom: 'large',
    note: 'Tìm kiếm web. Cần bàn phím ảo để gõ.',
  },
};

export type ZoomLevel = 'normal' | 'large' | 'xlarge' | 'xxlarge';

export const ZOOM_FACTORS: Record<ZoomLevel, number> = {
  normal: 1.0,
  large: 1.25,
  xlarge: 1.5,
  /**
   * Trần 200 % — đúng mức người dùng yêu cầu.
   *
   * Bốn mức chứ không phải một thanh trượt: `ViewManager.stepZoom()` kẹp bằng `ZOOM_ORDER.indexOf`,
   * nên trần là **độ dài mảng**, không phải một con số rải trong mã. Một thanh trượt liên tục sẽ phải
   * ghi đĩa ở mỗi bước kéo, và mỗi mức ở đây là một `setZoomFactor` ổn định mà trang không phải tự
   * làm tròn.
   */
  xxlarge: 2.0,
};

export const ZOOM_LABELS: Record<ZoomLevel, string> = {
  normal: 'Bình thường',
  large: 'Lớn',
  xlarge: 'Rất lớn',
  xxlarge: 'Cực lớn',
};

export const ZOOM_ORDER: readonly ZoomLevel[] = ['normal', 'large', 'xlarge', 'xxlarge'];

/**
 * Thu hẹp một giá trị bất kỳ về `ZoomLevel`.
 *
 * Một hàm thay cho sáu danh sách trắng chép tay ở `security.ts`, `main.ts` và `preload-chrome.cts`:
 * mỗi lần thêm một mức mà chỉ sửa năm trong sáu chỗ thì tệp cấu hình nhận một giá trị mà IPC từ chối,
 * hoặc ngược lại — và cả hai đều là lỗi im lặng.
 */
export function isZoomLevel(value: unknown): value is ZoomLevel {
  return typeof value === 'string' && (ZOOM_ORDER as readonly string[]).includes(value);
}

export interface ServiceDescriptor {
  id: ServiceId;
  label: string;
  startUrl: string;
  /** Electron session partition. Every service gets its own persistent session so a demo login never bleeds into another service. */
  partition: string;
  defaultZoom: ZoomLevel;
  /** Short note shown on the Home tile; states the known limitation honestly. */
  note: string;
}

export const SERVICES: Record<ServiceId, ServiceDescriptor> = {
  youtube: {
    id: 'youtube',
    label: 'YouTube',
    startUrl: 'https://www.youtube.com/',
    partition: 'persist:ntf-youtube',
    defaultZoom: 'large',
    note: 'Tìm kiếm và xem video. Shorts mở trong cùng trang YouTube.',
  },
  tiktok: {
    id: 'tiktok',
    label: 'TikTok',
    // `/foryou` là bảng cuộn `scroll-snap-type: y mandatory` — mỗi lần vuốt đổi đúng một video.
    // `/explore` chỉ là lưới ảnh thu nhỏ: cuộn dọc là cuộn trang, video không đổi. Đo trên panel:
    // cùng một cử chỉ, `/explore` nhảy 848 px mà `video.currentSrc` giữ nguyên, `/foryou` nhảy
    // đúng 1408 px (= chiều cao khung) và `currentSrc` đổi.
    startUrl: 'https://www.tiktok.com/foryou',
    partition: 'persist:ntf-tiktok',
    defaultZoom: 'normal',
    note: 'TikTok có thể yêu cầu đăng nhập. Prototype không vượt qua bước này.',
  },
  instagram: {
    id: 'instagram',
    label: 'Instagram',
    startUrl: 'https://www.instagram.com/reels/',
    partition: 'persist:ntf-instagram',
    defaultZoom: 'normal',
    note: 'Reels có thể yêu cầu đăng nhập. Không lưu tài khoản khách.',
  },
  facebook: {
    id: 'facebook',
    label: 'Facebook',
    startUrl: 'https://www.facebook.com/reel/',
    partition: 'persist:ntf-facebook',
    defaultZoom: 'normal',
    note: 'Facebook Reels. Có thể yêu cầu đăng nhập; không lưu tài khoản khách.',
  },
  news: {
    id: 'news',
    label: 'Tin tức',
    startUrl: 'https://news.google.com/?hl=vi&gl=VN&ceid=VN:vi',
    partition: 'persist:ntf-news',
    defaultZoom: 'large',
    note: 'Google News nhúng, đọc ngay trên máy.',
  },
};

export const SERVICE_ORDER: readonly ServiceId[] = ['youtube', 'tiktok', 'instagram', 'facebook', 'news'];

/** Ordered dock items. `web:` entries come from WEB_APPS; `browser` is the installed system browser. */
export const DOCK_ORDER: readonly string[] = [
  'home',
  'youtube',
  'tiktok',
  'instagram',
  'facebook',
  'news',
  'app:freetube',
  'browser',
  'web:google',
  'keyboard',
];

/**
 * Desktop applications the dock may launch. Each one is an opt-in install (scripts/install-apps.sh)
 * and is launched as a *separate* Wayland client, exactly like the system browser, so a crash or a
 * missing binary can never take the kiosk down with it. The absolute path is what the resolver
 * looks for; nothing here relies on PATH, because a systemd user unit has a minimal environment.
 */
export interface DesktopApp {
  id: string;
  label: string;
  binary: string;
  /** Extra argv, e.g. a kiosk-friendly window size. */
  args: readonly string[];
}

export const DESKTOP_APPS: readonly DesktopApp[] = [
  {
    id: 'freetube',
    label: 'FreeTube',
    binary: '/usr/bin/freetube',
    // No --maximize: labwc maximises to the whole output, which would put FreeTube on top of the
    // bar and dock. Its geometry comes from the catch-all window rule in gen-labwc-config.sh, which
    // sizes every normal window to the band between them.
    //
    // --ozone-platform=wayland is load-bearing, not a preference: run-kiosk.sh unsets DISPLAY so the
    // kiosk's own Electron picks the Wayland backend, and FreeTube's bundled Electron falls back to
    // X11 by default — without this flag it exits at once with "Missing X server or $DISPLAY".
    args: ['--ozone-platform=wayland'],
  },
];

/**
 * System browsers the dock may launch. Firefox is preferred because it is present through the
 * Ubuntu snap store; Chromium is the snap already installed on this machine. Whatever runs here is
 * a *separate* Wayland client that the compositor places inside the frame, between bar and dock, so
 * the visitor can always reach the bar to get back to the kiosk.
 */
export const SYSTEM_BROWSERS = [
  { command: 'firefox', label: 'Firefox' },
  { command: 'chromium', label: 'Chromium' },
] as const;

/**
 * Processes the kiosk is allowed to close on the visitor's behalf.
 *
 * Matching is by *absolute command-line prefix*, never by `comm`: the kiosk's own Electron reports
 * `comm=electron`, so a name match would kill the kiosk itself. `/usr/bin/freetube` is a symlink to
 * `/opt/FreeTube/freetube`, so the resolved path is what appears in cmdline. Chromium's `comm` is
 * `chrome`, which is why a `comm`-based rule silently fails to find it.
 */
export interface ExternalProcess {
  id: string;
  label: string;
  /** Resolved binary path; cmdline starts with it. */
  prefix: string;
  /**
   * Wayland `app_id` the compositor reports for this app, as candidates, most likely first.
   *
   * Cannot be derived from `prefix`: measured on the panel, FreeTube's Electron sets `app_id=freetube`
   * while the Firefox snap sets `app_id=firefox_firefox`. `wlrctl` matches on the exact string, so a
   * wrong value silently matches nothing (rc=1, no error). Ordered because a re-packaged build may
   * change it — `focusExternal()` stops at the first candidate that matches.
   */
  appIds: readonly string[];
}

export const EXTERNAL_PROCS: readonly ExternalProcess[] = [
  {
    id: 'freetube',
    label: 'FreeTube',
    prefix: '/opt/FreeTube/freetube',
    appIds: ['freetube', 'FreeTube', 'org.freetubeapp.FreeTube'],
  },
  {
    id: 'firefox',
    label: 'Firefox',
    prefix: '/snap/firefox/',
    appIds: ['firefox_firefox', 'firefox', 'Navigator'],
  },
  {
    id: 'chromium',
    label: 'Chromium',
    prefix: '/snap/chromium/',
    appIds: ['chromium_chromium', 'chromium', 'Chromium'],
  },
];

export interface NewsFeed {
  id: string;
  label: string;
  url: string;
}

const NEWS_BASE = 'https://news.google.com/rss';
const NEWS_QUERY = 'hl=vi&gl=VN&ceid=VN:vi';

export const NEWS_FEEDS: readonly NewsFeed[] = [
  { id: 'top', label: 'Nổi bật', url: `${NEWS_BASE}?${NEWS_QUERY}` },
  { id: 'nation', label: 'Việt Nam', url: `${NEWS_BASE}/headlines/section/topic/NATION?${NEWS_QUERY}` },
  { id: 'world', label: 'Thế giới', url: `${NEWS_BASE}/headlines/section/topic/WORLD?${NEWS_QUERY}` },
  { id: 'sports', label: 'Thể thao', url: `${NEWS_BASE}/headlines/section/topic/SPORTS?${NEWS_QUERY}` },
  { id: 'technology', label: 'Công nghệ', url: `${NEWS_BASE}/headlines/section/topic/TECHNOLOGY?${NEWS_QUERY}` },
  { id: 'health', label: 'Sức khỏe', url: `${NEWS_BASE}/headlines/section/topic/HEALTH?${NEWS_QUERY}` },
];
