import type { DockAction } from '../shared/chrome.js';
import { existsSync } from 'node:fs';
import {
  DESKTOP_APPS,
  EXTERNAL_PROCS,
  SERVICE_ORDER,
  SYSTEM_BROWSERS,
  WEB_APPS,
  type ServiceId,
} from '../shared/services.js';
import { launchDetached, launchSystemBrowser } from './browser-launch.js';
import type { SettingsStore } from './settings.js';
import type { ViewManager } from './view-manager.js';
import { focusExternal, minimizeExternal } from './compositor.js';
import { appIdsFor, activeExternalGroup, closeFrontExternalApp, noteActiveExternal, scanExternalGroups } from './external-apps.js';
import { matchesExternalPrefix } from './snap-alias.js';

/**
 * Mọi thứ xảy ra khi một mục trên dock được chạm: điều hướng trong kiosk, hoặc mở một app ngoài.
 *
 * Tách khỏi `main.ts` vì đây là nhóm duy nhất *thay đổi trạng thái nghiệp vụ* — nó quyết định view
 * nào bị huỷ, app nào được spawn. Phần mở trình duyệt/desktop app nằm ở `browser-launch.ts`.
 */

/**
 * Mở một app desktop tuỳ chọn. Cũng như trình duyệt, nó là client Wayland riêng, nên một binary
 * thiếu hay một app bên thứ ba bị crash vẫn để nguyên kiosk ở dưới.
 */
export function launchDesktopApp(id: string): void {
  const app = DESKTOP_APPS.find((candidate) => candidate.id === id);
  if (!app) return;
  if (!existsSync(app.binary)) {
    console.error(`[app] ${app.label}: chưa cài (${app.binary}) — chạy scripts/install-apps.sh --apply`);
    return;
  }
  launchDetached(app.binary, [...app.args], `app:${app.id}`);
}

/** Dock gửi lên object thường; xác thực lại hình dạng trước khi có bất kỳ tác dụng phụ nào. */
export function parseDockAction(raw: unknown): DockAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const type = (raw as { type?: unknown }).type;
  const id = (raw as { id?: unknown }).id;
  switch (type) {
    case 'home':
    case 'keyboard':
    case 'browser':
    case 'session':
    case 'close-app':
    case 'lock':
      return { type } as DockAction;
    case 'service':
      return typeof id === 'string' && SERVICE_ORDER.includes(id as ServiceId)
        ? { type: 'service', id: id as ServiceId }
        : null;
    case 'web':
      return typeof id === 'string' && WEB_APPS[id] ? { type: 'web', id } : null;
    case 'app':
      return typeof id === 'string' && DESKTOP_APPS.some((app) => app.id === id)
        ? { type: 'app', id }
        : null;
    default:
      return null;
  }
}

/** Những gì `handleDockAction` cần từ main process; truyền vào để tệp này không giữ trạng thái. */
export interface DockActionHost {
  views(): ViewManager | null;
  store(): SettingsStore | null;
  pushState(): void;
  endSession(): Promise<boolean>;
  /** Đưa panel vào màn hình chờ ngay (nút Khóa ở dock hoặc ở menu Nguồn). */
  lock(): Promise<void>;
  /** Đẩy trạng thái app ngoài ngay sau khi đóng, để nút ✕ không nán lại tới vòng poll sau. */
  pushApps(): void;
}

export function createDockActionHandler(host: DockActionHost): (action: DockAction) => Promise<void> {
  return async function handleDockAction(action: DockAction): Promise<void> {
    const views = host.views();
    if (!views || !host.store()) return;
    switch (action.type) {
      case 'home':
        // NTF-R13: `leaveToHome()` gộp dừng media và gỡ view vào một đường duy nhất, có await và
        // hoãn `close()` sang tick sau. Gọi `stopMedia()` rồi `goHome()` trực tiếp trong callback IPC
        // là đúng chuỗi thao tác đã sinh ra SIGTRAP 133.
        await views.setKeyboardOpen(false);
        await views.setKeyboardTarget('kiosk');
        await views.leaveToHome();
        host.pushState();
        return;
      case 'keyboard': {
        // Nút bàn phím là công tắc **thủ công**: người dùng chạm nó sau khi đã tự đưa Firefox/FreeTube
        // ra trước, nên đích phải là app đang thật sự active chứ không phải `kiosk` mặc định. Thiếu
        // bước này thì popup mở ra với `target=kiosk` và mọi phím rơi vào im lặng — đo trên panel:
        // Firefox active, chạm ô bàn phím, log ghi `popup … target=kiosk`.
        //
        // Đích `external` đang trỏ tới một app còn chạy thì giữ nguyên: người dùng vừa chạm tile
        // FreeTube rồi chạm ô bàn phím, và lúc đó kiosk đang ở trước nên hỏi lại compositor sẽ trả
        // `null` và xoá mất đích vừa đặt.
        if (!views.keyboardVisible) {
          const groups = scanExternalGroups();
          const keep = views.keyboardTargetValue === 'external' && groups.some((group) => group.id === views.keyboardTargetExternalId);
          if (!keep) {
            const front = await activeExternalGroup();
            if (front) await views.setKeyboardTarget('external', front.id);
            else await views.setKeyboardTarget('kiosk');
          }
        }
        const open = await views.setKeyboardOpen(!views.keyboardVisible);
        console.log(`[keyboard] ${open ? 'mở' : 'đóng'} target=${views.keyboardTargetValue}`);
        host.pushState();
        return;
      }
      case 'service':
        if (!SERVICE_ORDER.includes(action.id)) return;
        await views.setKeyboardOpen(false);
        await views.setKeyboardTarget('kiosk');
        await views.open(action.id);
        await revealKioskOverExternal();
        host.pushState();
        return;
      case 'web':
        if (!WEB_APPS[action.id]) return;
        await views.setKeyboardOpen(false);
        await views.setKeyboardTarget('kiosk');
        await views.openWebApp(action.id);
        await revealKioskOverExternal();
        host.pushState();
        return;
      case 'browser':
        // NTF-R07: tile trình duyệt là công tắc, không phải lệnh mở. Đang chạy thì đưa lên trước;
        // chưa chạy mới spawn. Thiếu bước này thì chạm lần hai mở thêm một cửa sổ nữa và app đã hạ
        // xuống vẫn không quay lại được, vì kiosk không có taskbar để chọn cửa sổ.
        await views.setKeyboardOpen(false);
        {
          const commands = SYSTEM_BROWSERS.map((browser) => browser.command);
          const running = await focusRunningApp(commands);
          if (running !== null) {
            await views.setKeyboardTarget('external', running);
            noteActiveExternal(running);
            // Popup vừa tắt mà không đẩy trạng thái thì ô bàn phím trên dock vẫn sáng `keyboard-on`
            // trong khi màn hình không còn bàn phím nào — người dùng chạm lần nữa mới thấy nó tắt
            // thật. Mọi nhánh có `setKeyboardOpen`/`setKeyboardTarget` đều phải đẩy lại `dockState`.
            host.pushState();
            return;
          }
          // Chưa chạy: id của app đích lấy từ chính binary sắp spawn, nên nó khớp id mà `/proc` sẽ
          // báo — không đoán theo thứ tự ứng viên.
          const launched = launchSystemBrowser();
          const launchedId = launched === null ? null : externalIdForBinary(launched);
          await views.setKeyboardTarget('external', launchedId);
          noteActiveExternal(launchedId);
        }
        host.pushState();
        return;
      case 'app':
        await views.setKeyboardTarget('external', action.id);
        await views.setKeyboardOpen(false);
        if ((await focusRunningApp([action.id])) === null) launchDesktopApp(action.id);
        // Người dùng vừa chọn app này; đó là app "đang trước" theo ý họ, kể cả khi overlay bàn phím
        // đang giữ active của compositor.
        noteActiveExternal(action.id);
        host.pushState();
        return;
      case 'close-app': {
        // NTF-R09: một lần chạm, đúng thứ đang ở phía trước, không hỏi kết thúc phiên, không xoá dữ
        // liệu duyệt web. App nằm trên băng nội dung nên xét app ngoài trước; app còn lại (nếu có)
        // vẫn chạy. Không có app ngoài thì đóng băng nội dung nhúng qua cùng đường dọn `leaveToHome()`.
        //
        // Ẩn popup **trước** khi hỏi compositor: overlay bàn phím là toplevel always-on-top nên chính
        // nó giữ `state:active`, và câu hỏi "app nào đang trước" sẽ trả `null` cho mọi app. Đo trên
        // panel trước khi sửa: Firefox đang trước, popup mở, bấm ✕ → FreeTube bị đóng. Ẩn trước vừa
        // trả active về cho app thật, vừa đúng ý người dùng (bấm ✕ thì bàn phím phải tắt).
        if (views.keyboardVisible) await views.setKeyboardOpen(false);
        const closed = await closeFrontExternalApp();
        if (closed !== null) {
          host.pushApps();
          // Đóng app cuối cùng thì đích phím không còn app ngoài nào để nhận; trả về kiosk để
          // bàn phím mở lại ở lần sau gõ vào trang nội bộ.
          if (scanExternalGroups().length === 0) {
            await views.setKeyboardOpen(false);
            await views.setKeyboardTarget('kiosk');
          }
          // Popup vừa đóng (hoặc vừa đổi đích) nhưng `dockState` chưa được đẩy thì ô bàn phím còn
          // sáng `keyboard-on` trên một màn hình không còn bàn phím. Cùng lý do như nhánh `browser`.
          host.pushState();
          return;
        }
        if (!views.hasVisibleContent()) return;
        await views.setKeyboardOpen(false);
        await views.setKeyboardTarget('kiosk');
        await views.leaveToHome();
        host.pushState();
        return;
      }
      case 'session':
        await host.endSession();
        return;
      /*
       * Lock is the one dock action that must not touch the view manager at all: no navigation, no
       * keyboard state, no media. It only raises the lock overlay, so a visitor who tapped it by
       * accident still finds the same page underneath after unlocking.
       */
      case 'lock':
        await host.lock();
        return;
      default:
        return;
    }
  };
}

/**
 * Hạ mọi app ngoài đang hiện xuống khi khách chọn nội dung của kiosk — NTF-R07.
 *
 * Phải chạy **sau** khi view đã nạp: trong lúc `open()` còn đang chờ `did-finish-load`, app ngoài vẫn
 * ở trên, và nếu hạ trước thì khách thấy màn hình đen của một view chưa vẽ gì. Trả về ngay nếu không
 * có app ngoài nào chạy, để đường đi thường không tốn một lần `spawn`.
 */
async function revealKioskOverExternal(): Promise<void> {
  const groups = scanExternalGroups();
  if (groups.length === 0) return;
  for (const group of groups) {
    const ok = await minimizeExternal(appIdsFor(group.id));
    if (!ok) console.log(`[compositor] không hạ được ${group.label} — nội dung kiosk có thể bị che`);
  }
}

/**
 * Id của app ngoài **sẽ mở**, suy ra từ chính binary mà dock sắp chạy.
 *
 * Không đoán theo thứ tự ứng viên: `resolveSystemBrowser()` chỉ trả Firefox khi `/snap/bin/firefox`
 * thật sự tồn tại, nên trên máy chỉ có Chromium mà lấy ứng viên đầu danh sách sẽ ghi id `firefox`
 * trong khi tiến trình sắp chạy là Chromium — và mọi phím sẽ đi nhầm nhánh. So khớp tiền tố cmdline
 * với `EXTERNAL_PROCS.prefix` là cùng quy tắc `scanExternalGroups()` dùng, nên id ở đây và id mà
 * `/proc` báo sau đó luôn là một.
 *
 * Phép so phải đi qua `matchesExternalPrefix()` (QA09-03): binary dock chạy là shim
 * `/snap/bin/firefox`, còn `/proc` báo `/snap/firefox/<rev>/...`, nên một `startsWith` trần trả `null`
 * cho mọi trình duyệt snap — và bàn phím giữ đích `kiosk` trong khi app ngoài đang che popup.
 */
function externalIdForBinary(binary: string): string | null {
  return EXTERNAL_PROCS.find((proc) => matchesExternalPrefix(binary, proc.prefix))?.id ?? null;
}

/**
 * Đưa app ngoài đã chạy lên trước; trả **id của app đã xử lý**, hoặc `null` khi không app nào trong
 * danh sách đang chạy.
 *
 * Trả id thay vì boolean vì nơi gọi cần cả hai thông tin trong một lượt: id là app đích cho bàn phím,
 * còn "khác null" nghĩa là đã có app và **không được spawn thêm bản thứ hai**. App có tiến trình
 * nhưng compositor không định địa chỉ được vẫn trả id — mở thêm cửa sổ chỉ làm tình trạng tệ hơn.
 */
async function focusRunningApp(ids: readonly string[]): Promise<string | null> {
  // Duyệt theo **thứ tự ưu tiên của nơi gọi**, không theo thứ tự `/proc` liệt kê: với hai trình
  // duyệt cùng chạy, `find` trên kết quả quét chọn app có pid nhỏ hơn chứ không chọn app đứng trước
  // trong `SYSTEM_BROWSERS`. Hệ quả đo được trên panel: Chromium (pid nhỏ hơn) được đưa lên trước và
  // trở thành đích phím, trong khi người dùng chạm tile để quay lại Firefox.
  const groups = scanExternalGroups();
  const running = ids
    .map((id) => groups.find((group) => group.id === id))
    .find((group) => group !== undefined);
  if (!running) return null;
  const ok = await focusExternal(appIdsFor(running.id));
  if (!ok) console.log(`[compositor] ${running.label} đang chạy nhưng không focus được — không mở thêm bản mới`);
  return running.id;
}
