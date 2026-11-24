import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Lớp nói chuyện với compositor cho đúng một việc: đưa băng nội dung của kiosk ra trước mặt.
 *
 * Vì sao cần một lớp riêng và vì sao nó **không** thử raise cửa sổ kiosk: `gen-labwc-config.sh` ghim
 * cửa sổ kiosk xuống `ToggleAlwaysOnBottom`, và labwc không tạo `zwlr_foreign_toplevel` handle cho
 * những cửa sổ khớp rule `title=`/`fixedPosition`. Đo trên máy thật: `wlrctl toplevel find` trả rc=1
 * cho `app_id:electron`, `app_id:ntfitness-online`, `title:NT Fitness Touch` và `title:NTF frame`.
 * Không có handle thì không có cách nào nhờ compositor raise nó lên. Đòn bẩy duy nhất còn lại là
 * **hạ app ngoài xuống**: cửa sổ kiosk đang ở đáy, nên chỉ cần app ngoài rời khỏi layer `normal` là
 * băng nội dung lộ ra. Đo lại bằng pixel: sau khi hạ, vùng băng đổi từ nội dung FreeTube/Firefox sang
 * nội dung kiosk, còn pixel thanh trên và dock không đổi.
 * `wlrctl` là **tuỳ chọn**: vắng nó thì mọi hàm ở đây trả `false` và nơi gọi vẫn chạy tiếp — app vẫn
 * mở được, chỉ là nó nằm đè lên kiosk như trước. Cài: `sudo apt-get install -y wlrctl` (bản đo trên
 * máy: 0.2.2-2build1). Gỡ: `sudo apt-get remove -y wlrctl`.
 *
 * Một điều bắt buộc phải biết khi gọi tay: `wlrctl` cần `XDG_RUNTIME_DIR` và `WAYLAND_DISPLAY`. Thiếu
 * hai biến đó nó **không khớp gì cả và vẫn im lặng** (rc=1, không lỗi) — nên chúng được đặt lại ở đây
 * thay vì tin vào môi trường của unit systemd.
 */

const WLRCTL = '/usr/bin/wlrctl';
const WTYPE_BIN = '/usr/bin/wtype';
const XDOTOOL_BIN = '/usr/bin/xdotool';

/** `null` = chưa dò; dò một lần vì kết quả không đổi trong vòng đời tiến trình. */
let available: boolean | null = null;

/** Chỉ cảnh báo "thiếu wlrctl" một lần, để log không bị lấp bởi mỗi cú chạm dock. */
let warnedMissing = false;

function hasWlrctl(): boolean {
  if (available === null) available = existsSync(WLRCTL);
  if (!available && !warnedMissing) {
    warnedMissing = true;
    console.warn(`[compositor] không có ${WLRCTL} — app ngoài sẽ nằm đè lên kiosk (cài: apt-get install wlrctl)`);
  }
  return available;
}

function wlrEnv(): NodeJS.ProcessEnv {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  return {
    ...process.env,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || 'wayland-0',
  };
}

/**
 * Chạy một lệnh `wlrctl` và trả về thành công/thất bại.
 *
 * `execFile` chứ không `exec`: tham số truyền thẳng, không qua shell, nên một `app_id` đọc từ `/proc`
 * cũng không thể thành lệnh thứ hai. Timeout 1500 ms vì đây là đường đi của một cú chạm — treo ở đây
 * là treo phản hồi của dock.
 */
function run(args: readonly string[]): Promise<boolean> {
  if (!hasWlrctl()) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(WLRCTL, [...args], { env: wlrEnv(), timeout: 1500 }, (error) => {
      if (error) {
        console.log(`[compositor] wlrctl ${args.join(' ')} lỗi: ${error.message}`);
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}

/** Chạy `wlrctl` và trả `stdout`; `null` khi lỗi, thiếu binary hoặc timeout. */
function capture(args: readonly string[]): Promise<string | null> {
  if (!hasWlrctl()) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(WLRCTL, [...args], { env: wlrEnv(), timeout: 1500 }, (error, stdout) => {
      resolve(error ? null : String(stdout));
    });
  });
}

export interface ToplevelInfo {
  /** `app_id` **thật** do compositor báo. */
  readonly appId: string;
  readonly title: string;
}

/**
 * Danh sách toplevel đang mở, lấy `app_id` **thật** thay vì đoán theo bảng `EXTERNAL_PROCS`.
 *
 * Vì sao phải hỏi: `app_id` của client XWayland **không** phải chuỗi cố định. Đo trên panel với
 * Chromium (`--ozone-platform=x11`) thì `wlrctl toplevel list` trả `chromium (/tmp/ntf-cr-x1):
 * about:blank - Chromium` — tức `app_id` = phần tử đầu của `WM_CLASS`, mà Chromium nối thêm đường dẫn
 * profile vào đó. Vì vậy `find app_id:chromium state:active` trả rc=1 dù cửa sổ **đang** active, và
 * mọi lệnh `focus` / `minimize` / `find` đoán theo literal đều trượt. `wlrctl` cũng **không** hỗ trợ
 * glob (`app_id:chromium*` → rc=1), nên cách duy nhất là đọc danh sách rồi ghép chính xác.
 *
 * Định dạng một dòng là `<app_id>: <title>`. Cắt ở lần xuất hiện **đầu tiên** của `": "` để giữ
 * nguyên `app_id` có khoảng trắng. Nếu `app_id` tình cờ chứa `": "` thì phần bị cắt sẽ không khớp
 * app nào và lệnh sau trả rc=1 — hỏng theo hướng an toàn, không bao giờ trả lời sai app.
 */
export async function listToplevels(): Promise<readonly ToplevelInfo[]> {
  const out = await capture(['toplevel', 'list']);
  if (out === null) return [];
  const rows: ToplevelInfo[] = [];
  for (const line of out.split('\n')) {
    const at = line.indexOf(': ');
    if (at <= 0) continue;
    rows.push({ appId: line.slice(0, at), title: line.slice(at + 2) });
  }
  return rows;
}

/**
 * `app_id` thật có khớp một `app_id` đã biết không.
 *
 * Khớp đúng, hoặc khớp phần đầu **kèm dấu cách** — dạng `chromium (/profile)` của XWayland. Bắt buộc
 * có dấu cách để `firefox` không nuốt `firefox_firefox`.
 */
export function appIdMatches(actual: string, known: string): boolean {
  return actual === known || actual.startsWith(`${known} `);
}

/**
 * Đổi danh sách `app_id` đã biết thành danh sách **thật** đang mở, xếp trước.
 *
 * Dùng cho mọi lệnh tác động lên app ngoài (`focus`, `minimize`, `find state:active`): bản trước chỉ
 * thử các literal trong `EXTERNAL_PROCS`, nên app XWayland không bao giờ được chạm tới — tile
 * Chromium trên dock không raise được app, không hạ được, và ✕ không nhận ra nó. Vẫn giữ literal ở
 * cuối danh sách để app Wayland thuần (và trường hợp đọc danh sách thất bại) chạy như cũ.
 */
export async function resolveAppIds(known: readonly string[]): Promise<readonly string[]> {
  const listed = await listToplevels();
  const actual = listed
    .map((row) => row.appId)
    .filter((appId) => known.some((candidate) => appIdMatches(appId, candidate)));
  const extra = actual.filter((appId) => !known.includes(appId));
  return [...extra, ...known];
}

/**
 * Hạ một app ngoài xuống, để băng nội dung của kiosk lộ ra.
 *
 * Cố tình hạ **theo từng `app_id`** chứ không dùng `wlrctl toplevel minimize state:unminimized`:
 * lệnh không kèm matchspec hạ *mọi* toplevel, và ta không biết chín cửa sổ khung của kiosk có handle
 * hay không — nếu có thì chúng cũng bị hạ và không có gì bảo đảm raise lại được. Chỉ định đúng
 * `app_id` thì ngoài app ngoài ra không gì bị chạm.
 *
 * Cửa sổ bị hạ **không** bị đóng: tiến trình còn nguyên, `scanExternalApps()` vẫn thấy nó, và khung
 * + nút ✕ vẫn hiện. Khách lấy lại app bằng cách chạm lại đúng tile của nó trên dock
 * (`focusExternal`), vì kiosk không có taskbar lẫn window switcher.
 */
export async function minimizeExternal(appIds: readonly string[]): Promise<boolean> {
  const resolved = await resolveAppIds(appIds);
  for (const appId of resolved) {
    if (await run(['toplevel', 'minimize', `app_id:${appId}`])) return true;
  }
  return false;
}

/**
 * Đưa một app ngoài đã có lên trước — đồng thời bỏ trạng thái minimized.
 *
 * Đo trên máy thật: `wlrctl toplevel focus app_id:freetube` trên một cửa sổ đang minimized trả rc=0
 * và cửa sổ hết minimized (hỏi lại `find state:minimized` trả rc=1). Đó là toàn bộ cơ chế "chạm lại
 * tile để lấy lại app" sau khi kiosk đã lấy lại màn hình.
 *
 * `appIds` là danh sách ứng viên vì mỗi bản đóng gói đặt `app_id` một kiểu — đo trên máy thật,
 * FreeTube là `freetube` còn Firefox snap là `firefox_firefox`. (Bản trước ghi thêm rằng
 * "`state:active` **không** ghép được với `app_id:` nên không có cách hỏi compositor xem app nào đang
 * trước" — đo lại thì điều đó sai, xem `activeExternalId()`.)
 */
export async function focusExternal(appIds: readonly string[]): Promise<boolean> {
  const resolved = await resolveAppIds(appIds);
  for (const appId of resolved) {
    if (await run(['toplevel', 'focus', `app_id:${appId}`])) return true;
  }
  return false;
}

/**
 * Hỏi compositor **app nào thật sự đang ở phía trước** — câu trả lời đúng cho nút ✕ (NTF-R09).
 *
 * Vì sao trước đây suy từ `/proc`: bản trước ghi rằng "`state:active` **không** ghép được với
 * `app_id:` nên không có cách hỏi compositor xem app nào đang trước". Đo lại trên panel (labwc
 * 0.9.3, wlrctl 0.2.2) thì điều đó **sai**: `wlrctl toplevel find app_id:<id> state:active` trả
 * rc=0 đúng một app. Trình tự đo: mở Firefox rồi FreeTube (active=`freetube`), focus Firefox
 * (active=`firefox_firefox`), focus FreeTube (active=`freetube`), **focus Firefox lần hai**
 * (active=`firefox_firefox`) — chính là ca mà `startedAt` trả lời sai. Minimize Firefox thì active
 * chuyển sang `freetube`, focus lại thì về `firefox_firefox`.
 *
 * Giới hạn phải biết: kiosk và chín cửa sổ khung **không** có handle foreign-toplevel (đo được:
 * `find app_id:electron` và `find title:NTF frame*` trả rc=1 **kể cả khi** app ngoài đang mở), nên
 * hàm này trả lời được "app ngoài nào đang active", **không** trả lời được "kiosk có đang active".
 * Vì vậy `null` nghĩa là "không app ngoài nào đang active", chứ không phải "kiosk đang active".
 *
 * **Sửa lại một kết luận sai trước đó.** Bản trước ghi rằng "một cửa sổ XWayland làm mù
 * `state:active` của mọi toplevel Wayland". Đo lại thì **sai**: XWayland **không** làm mù gì cả.
 * Nguyên nhân thật là `app_id` của client XWayland không phải literal trong bảng — nó là
 * `"chromium (/tmp/ntf-cr-x1)"`, tức `WM_CLASS` thứ nhất kèm đường dẫn profile — nên lệnh `find`
 * đoán theo `app_id:chromium` trượt và trả rc=1 trong khi cửa sổ **đang** active. Đo trên panel:
 * focus Chromium XWayland → `find 'app_id:chromium (/tmp/ntf-cr-x1)' state:active` rc=0 và
 * `firefox_firefox` rc=1; focus Firefox → ngược lại; lặp lại được theo cả hai chiều. Vì vậy hàm này
 * đọc danh sách thật trước (`listToplevels`) rồi mới hỏi.
 */export async function activeExternalId(appIdsByGroup: readonly (readonly string[])[]): Promise<number | null> {
  const listed = (await listToplevels()).map((row) => row.appId);
  for (let index = 0; index < appIdsByGroup.length; index += 1) {
    const known = appIdsByGroup[index] ?? [];
    const actual = listed.filter((appId) => known.some((candidate) => appIdMatches(appId, candidate)));
    for (const appId of [...actual, ...known]) {
      if (await run(['toplevel', 'find', `app_id:${appId}`, 'state:active'])) return index;
    }
  }
  return null;
}

/** Phím đặc biệt mà popup gửi được khi đích là app ngoài. */
export type InjectedKey = 'backspace' | 'enter' | 'space' | 'tab';

/**
 * Gõ vào **client đang focus** — app ngoài chứ không phải view nào của kiosk (NTF-R08).
 *
 * Vì sao không dùng `sendInputEvent`: nó chỉ gửi được vào `WebContents` của chính Electron. Firefox
 * và FreeTube là tiến trình riêng, không có `WebContents` nào để gửi vào, và bàn phím của kiosk lại
 * là một `WebContentsView` con của cửa sổ bị ghim `ToggleAlwaysOnBottom` — nên ngoài việc bị che,
 * nó cũng không thể chạm tới app ngoài bằng đường DOM.
 *
 * **Hai đường gõ, chọn theo *loại client* của app ngoài.** Đo trên panel (labwc 0.9.3) thì virtual
 * keyboard của Wayland chỉ đúng với client Wayland gốc. Chromium trên máy này bị đẩy sang XWayland
 * (`--ozone-platform=x11`, xem `dock-actions.ts`), và ở đó `wtype` / `wlrctl keyboard type` gõ **sai
 * ký tự**: đo được `wlrctl keyboard type "abc123"` → ô nhập nhận `` `\ `` , `wtype "abc123"` → `12`,
 * trong khi `xdotool type "abc123"` → đúng từng ký tự. Nguyên nhân là keymap: đường virtual-keyboard
 * dựng bảng mã riêng rồi bơm scancode, còn client X11 nhận qua keymap của Xwayland nên lệch. Vì vậy:
 *
 * - app ngoài là client **X11/XWayland** → `xdotool` (XTEST, đi qua keymap X11 nên khớp);
 * - app ngoài là client **Wayland gốc** → `wlrctl keyboard type` / `wtype -k` như trước.
 *
 * **Không hỏi "ai đang focus".** Bản trước dùng `xdotool getactivewindow` làm bộ phân biệt và nó
 * **luôn sai đúng lúc cần nhất**: popup bàn phím là một cửa sổ Wayland `alwaysOnTop` nhận focus, nên
 * khi popup đang mở thì focus X trôi về `PointerRoot` (đo được: `getactivewindow` →
 * "XGetWindowProperty[_NET_ACTIVE_WINDOW] failed", `getwindowfocus` → "getInputFocus returned the
 * focused window of 1"), và nhánh X11 không bao giờ được chọn. Tệ hơn, XTEST khi focus là PointerRoot
 * gửi phím tới **cửa sổ dưới con trỏ** — đo được lúc đầu "chạy đúng" chỉ vì con trỏ tình cờ nằm trên
 * Chromium. Bộ phân biệt đúng phải **tĩnh**, không phụ thuộc focus: hỏi thẳng tiến trình app ngoài có
 * sở hữu cửa sổ X11 nào không (`xdotool search --pid`), rồi trả focus về đó trước khi gõ.
 */
export async function typeText(text: string, externalPids: readonly number[], appIds: readonly string[] = []): Promise<boolean> {
  const trimmed = text.length > 64 ? text.slice(0, 64) : text;
  if (trimmed.length === 0) return true;
  return inject(() => typeTextNow(trimmed, externalPids, appIds));
}

/**
 * Xếp mọi lần bơm phím vào **một chuỗi tuần tự**.
 *
 * Đo trên panel: bấm `h e l l o` trên popup thì ô nhập nhận `l`, `ll`, `llh`, `llho` — chữ đầu tiên
 * tới **sau** chữ thứ ba. Nguyên nhân: `sendKey()` tách mỗi code point thành một lời gọi, mỗi lời gọi
 * spawn một tiến trình `xdotool` riêng, và ba tiến trình chạy song song thì thứ tự tới X server do
 * lịch của hệ điều hành quyết định chứ không do thứ tự bấm. Một bàn phím thật không bao giờ làm vậy:
 * nó gửi phím theo đúng thứ tự người dùng bấm. Chuỗi này là thứ tự đó.
 *
 * Chuỗi không bao giờ giữ lỗi: một lần gõ hỏng chỉ trả `false` cho lời gọi của nó và **không** chặn
 * các phím sau. Nếu giữ lỗi thì một cú trượt duy nhất làm mọi phím còn lại của phiên im lặng mãi.
 */
let injectChain: Promise<unknown> = Promise.resolve();
function inject<T>(task: () => Promise<T>): Promise<T> {
  const queued = injectChain.then(task, task);
  injectChain = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}

async function typeTextNow(trimmed: string, externalPids: readonly number[], appIds: readonly string[]): Promise<boolean> {
  const win = await x11TargetWindow(externalPids);
  noteBranch(win !== null);
  if (win !== null) {
    await focusX11Window(win);
    return xdotool(['type', '--clearmodifiers', '--delay', '12', '--', trimmed], 6000);
  }
  await restoreWaylandFocus(appIds);
  return run(['keyboard', 'type', trimmed]);
}

/**
 * OSK-01: trả focus cho app đích trước khi gõ qua virtual keyboard của Wayland.
 *
 * `wlrctl keyboard type` gõ vào **surface đang có focus bàn phím**, mà chạm lên dock làm app ngoài
 * mất `state:active` — đo trên panel: mở FreeTube rồi chạm tile bàn phím thì `find app_id:freetube
 * state:active` trả rc=1, nên phím ảo rơi vào khoảng không dù cửa sổ vẫn hiện. Popup khai
 * `focusable: false` nên nó không giành focus; focus bị cửa sổ kiosk lấy khi dock nhận chạm. Nhánh
 * X11 đã làm đúng việc này bằng `focusX11Window`; đây là bản tương ứng cho Wayland.
 *
 * TTL 400 ms vì `focusExternal` tốn hai tiến trình (`toplevel list` + `focus`): gõ một cụm 6 phím
 * liền nhau thì trả focus một lần là đủ, và `injectChain` đã bảo đảm thứ tự.
 */
let waylandFocusAt = 0;
const WAYLAND_FOCUS_TTL_MS = 400;
async function restoreWaylandFocus(appIds: readonly string[]): Promise<void> {
  if (appIds.length === 0) return;
  const now = Date.now();
  if (now - waylandFocusAt < WAYLAND_FOCUS_TTL_MS) return;
  waylandFocusAt = now;
  await focusExternal(appIds);
}

/** Ghi lại nhánh gõ **mỗi khi nhánh đổi**, không phải mỗi ký tự — một dòng mỗi lần đổi là đủ để thấy
 * app ngoài đang đi đường nào mà không ngập log của 35 lần bấm phím. */
let lastBranch: string | null = null;
function noteBranch(x11: boolean): void {
  const want = x11 ? 'x11' : 'wayland';
  if (lastBranch === want) return;
  lastBranch = want;
  console.log(`[compositor] đường gõ = ${want}`);
}

/** Keysym dùng chung cho cả hai đường: `wtype -k` và `xdotool key` nhận cùng tên phím X11. */
const KEYSYMS: Record<InjectedKey, string> = {
  backspace: 'BackSpace',
  enter: 'Return',
  space: 'space',
  tab: 'Tab',
};

/**
 * Gửi một phím điều khiển tới client đang focus.
 *
 * `wlrctl` chỉ có `keyboard type <string>`, mà Backspace/Enter là *keysym*, không phải chuỗi — nên
 * phím điều khiển đi qua `wtype` (Wayland) hoặc `xdotool key` (X11). Vắng binary thì trả `false` và
 * nơi gọi coi như không gõ được.
 */
export async function typeKey(
  key: InjectedKey,
  externalPids: readonly number[],
  appIds: readonly string[] = [],
): Promise<boolean> {
  return inject(() => typeKeyNow(key, externalPids, appIds));
}

async function typeKeyNow(key: InjectedKey, externalPids: readonly number[], appIds: readonly string[]): Promise<boolean> {
  const win = await x11TargetWindow(externalPids);
  noteBranch(win !== null);
  if (win !== null) {
    await focusX11Window(win);
    return xdotool(['key', '--clearmodifiers', KEYSYMS[key]], 1500);
  }
  await restoreWaylandFocus(appIds);
  const keysym = KEYSYMS[key];
  if (!existsSync(WTYPE_BIN)) return false;
  return new Promise((resolve) => {
    execFile(WTYPE_BIN, ['-k', keysym], { env: wlrEnv(), timeout: 1500 }, (error) => {
      if (error) {
        console.log(`[compositor] wtype -k ${keysym} lỗi: ${error.message}`);
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}

/**
 * Môi trường cho `xdotool`: nó cần `DISPLAY`, mà `run-kiosk.sh` unset biến đó để Electron chọn
 * Wayland. Socket của labwc là `:0` — chỉ đưa vào khi socket thật sự tồn tại, để máy không có
 * XWayland thì `x11TargetWindow()` trả `null` thay vì gọi một lệnh chắc chắn lỗi.
 */
function x11Env(): NodeJS.ProcessEnv | null {
  if (!existsSync('/tmp/.X11-unix/X0')) return null;
  return { ...process.env, DISPLAY: ':0' };
}

/** Cache ngắn: một cú chạm bàn phím là một tiến trình, đừng dò lại cho từng ký tự. */
let x11WindowCache: { at: number; key: string; value: number | null } | null = null;
const X11_WINDOW_TTL_MS = 400;

/**
 * Cửa sổ X11 **thuộc về** tiến trình app ngoài, hay `null` nếu app đó là client Wayland gốc.
 *
 * Đây là bộ phân biệt cho hai đường gõ. Nó **tĩnh**: chỉ hỏi tiến trình có sở hữu cửa sổ X11 nào
 * không, không hỏi cửa sổ nào đang focus.
 *
 * Bản trước hỏi `xdotool getactivewindow` và hỏng đúng lúc cần nhất — popup bàn phím là cửa sổ
 * Wayland `alwaysOnTop` nhận focus, nên trong suốt thời gian popup mở, focus X trôi về `PointerRoot`
 * (`getwindowfocus` → "getInputFocus returned the focused window of 1", lặp lại 5/5 lần), và nhánh
 * X11 không bao giờ được chọn.
 *
 * `xdotool search --pid` không phụ thuộc focus nên không có vấn đề đó. Với Chromium (pid 247603) đo
 * được `4194307 6291457 6291458`; với Firefox và FreeTube thì không cửa sổ nào — đúng như thiết kế
 * (Chromium bị đẩy sang XWayland, hai app kia là Wayland gốc). Duyệt **mọi** pid của nhóm vì snap
 * có thể tái bố cục tiến trình; `search` trả nhiều id nên lấy id đầu tiên.
 */
async function x11TargetWindow(pids: readonly number[]): Promise<number | null> {
  const env = x11Env();
  if (!env || pids.length === 0) return null;
  const key = pids.join(',');
  const now = Date.now();
  if (x11WindowCache && x11WindowCache.key === key && now - x11WindowCache.at < X11_WINDOW_TTL_MS) {
    return x11WindowCache.value;
  }
  let found: number | null = null;
  for (const pid of pids) {
    const ids = await new Promise<string>((resolve) => {
      execFile(XDOTOOL_BIN, ['search', '--pid', String(pid)], { env, timeout: 800 }, (error, stdout) =>
        resolve(error ? '' : String(stdout)),
      );
    });
    const first = ids.split(/\s+/).find((token) => /^\d+$/.test(token));
    if (first) {
      found = Number(first);
      break;
    }
  }
  x11WindowCache = { at: now, key, value: found };
  // Không log khi thành công: đây là đường chạy mỗi ký tự. Log khi chuyển nhánh để còn truy được.
  return found;
}

/** Chạy một lệnh `xdotool`; `execFile` để chuỗi gõ vào không bao giờ đi qua shell. */
function xdotool(args: readonly string[], timeout: number): Promise<boolean> {
  const env = x11Env();
  if (!env) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(XDOTOOL_BIN, [...args], { env, timeout }, (error) => {
      if (error) {
        console.log(`[compositor] xdotool ${args.join(' ')} lỗi: ${error.message}`);
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}

/**
 * Đưa focus X11 về cửa sổ app ngoài trước khi gõ.
 *
 * `windowfocus --sync` chỉ chờ X server xử lý *yêu cầu*, không chờ app xử lý `FocusIn`. Đo trên
 * panel trước đây: khi popup bàn phím đang mở, focus X là `PointerRoot`, nên gõ ngay sau
 * `windowfocus` cho ra `ello` thay vì `hello`. Vòng dò `getwindowfocus` không dùng được vì labwc
 * giữ focus XWayland: nó trả `1` ở 0/20/60/200 ms. A/B trên panel (5 phiên popup × 5 phím): độ trễ
 * 120 ms cho 25/25, độ trễ 0 ms cho 50/50 — nên độ trễ không phải thứ chữa lỗi nuốt phím đầu. Thứ
 * chữa được là `injectChain`: mỗi lần gõ chờ lần trước xong, nên `windowfocus` của phím sau không
 * cắt ngang lúc `xdotool type` của phím trước đang chạy. Vì vậy ở đây không thêm `setTimeout` nào.
 */
async function focusX11Window(win: number): Promise<void> {
  await xdotool(['windowfocus', '--sync', String(win)], 800);
}
