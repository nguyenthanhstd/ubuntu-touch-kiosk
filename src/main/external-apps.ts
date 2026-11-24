import { readFileSync, readdirSync } from 'node:fs';
import { EXTERNAL_PROCS } from '../shared/services.js';
import { activeExternalId } from './compositor.js';
import { matchesExternalPrefix } from './snap-alias.js';
import { isExternalMinimized } from './toplevel-state.js';

/**
 * Quét và đóng các app ngoài (FreeTube, Firefox, Chromium) — những cửa sổ không thuộc kiosk.
 *
 * Nhận diện bằng *tiền tố đường dẫn tuyệt đối của argv[0]* trong `/proc/<pid>/cmdline`, không dùng
 * `comm`: kiosk của chính ta báo `comm=electron`, Chromium báo `comm=chrome`, và `/usr/bin/freetube`
 * là symlink nên chỉ đường dẫn đã resolve mới xuất hiện trong cmdline. Một rule theo `comm` sẽ hoặc
 * bỏ sót Chromium, hoặc tệ hơn là khớp nhầm và tắt chính kiosk.
 *
 * Ba tiền tố trong `EXTERNAL_PROCS` (services.ts) là nguồn sự thật duy nhất, cả cho việc quét lẫn
 * việc đóng: thêm một app ngoài mới chỉ cần thêm một dòng ở đó.
 */

export interface ExternalScan {
  pids: number[];
  labels: string[];
}

/**
 * Một app ngoài đang chạy, gộp mọi tiến trình con của nó.
 *
 * `startedAt` là `starttime` của tiến trình **cũ nhất** thuộc app (đơn vị jiffies từ lúc boot, chỉ
 * dùng để so sánh tương đối). Từ NTF-R09 nó **không còn** là cách xác định app đang ở phía trước —
 * `frontExternalApp()` hỏi compositor trước; số này chỉ là fallback khi compositor không trả lời.
 */
export interface ExternalGroup {
  id: string;
  label: string;
  pids: number[];
  startedAt: number;
}

export function scanExternalGroups(): ExternalGroup[] {
  const groups = new Map<string, ExternalGroup>();
  let entries: string[] = [];
  try {
    entries = readdirSync('/proc');
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    // Không bao giờ signal chính mình hoặc cha mình: kiosk cũng là một client `normal`.
    if (pid === process.pid || pid === process.ppid) continue;
    let cmdline: string;
    try {
      cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
    } catch {
      continue; // tiến trình vừa chết giữa lúc quét, hoặc không có quyền đọc
    }
    // cmdline ngăn cách bằng NUL; argv[0] là binary đúng như lúc exec.
    const argv0 = cmdline.split('\0', 1)[0];
    if (!argv0) continue;
    const match = EXTERNAL_PROCS.find((proc) => matchesExternalPrefix(argv0, proc.prefix));
    if (!match) continue;
    const startedAt = startTimeOf(entry);
    const existing = groups.get(match.id);
    if (existing) {
      existing.pids.push(pid);
      existing.startedAt = Math.min(existing.startedAt, startedAt);
    } else {
      groups.set(match.id, { id: match.id, label: match.label, pids: [pid], startedAt });
    }
  }
  return [...groups.values()];
}

/**
 * Trường 22 của `/proc/<pid>/stat` (`starttime`). Trả `Number.MAX_SAFE_INTEGER` khi không đọc được,
 * để một tiến trình lạ không bao giờ bị coi là "vừa mở" chỉ vì ta không đọc nổi số của nó.
 *
 * Không `split(/\s+/)` cả dòng: trường 2 (`comm`) có thể chứa dấu cách và dấu ngoặc, nên phải cắt
 * từ dấu `)` cuối cùng rồi mới tách.
 */
function startTimeOf(pid: string): number {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
  const close = stat.lastIndexOf(')');
  if (close < 0) return Number.MAX_SAFE_INTEGER;
  const rest = stat.slice(close + 2).split(' ');
  // rest[0] là trường 3 (state); trường 22 nằm ở chỉ số 19.
  const raw = Number(rest[19]);
  return Number.isFinite(raw) ? raw : Number.MAX_SAFE_INTEGER;
}

export function scanExternalApps(): ExternalScan {
  const groups = scanExternalGroups();
  return { pids: groups.flatMap((group) => group.pids), labels: groups.map((group) => group.label) };
}

/**
 * Đóng mọi app ngoài.
 *
 * SIGTERM trước để trình duyệt kịp ghi state, rồi SIGKILL những gì còn lại sau thời gian ân hạn —
 * đây là kiosk, một cửa sổ treo tệ hơn một phiên bị mất. Chỉ resolve khi lần quét mới đã rỗng, để
 * nơi gọi ẩn nút dựa trên kết quả đã kiểm chứng chứ không dựa trên hy vọng.
 *
 * Chỉ dùng cho đường quản trị (`scripts/` và chế độ dev). Nút ✕ của khách đi qua
 * `closeFrontExternalApp()` — NTF-R09: nút đóng của khách không được tắt app khác đang chạy.
 */
export function closeExternalApps(): Promise<boolean> {
  return closePids(scanExternalApps().pids);
}

/**
 * App ngoài đang ở trên cùng — **hỏi compositor**, không suy từ thời điểm khởi chạy (NTF-R09).
 *
 * Bản trước chọn nhóm có `startedAt` lớn nhất, tức là "app mở sau cùng". Sai đúng ở ca người dùng
 * báo: mở Firefox → mở FreeTube → chạm lại Firefox để đưa nó ra trước → ✕. Firefox ra trước nhưng
 * vẫn là app *cũ hơn*, nên bản cũ đóng FreeTube.
 *
 * `activeExternalId()` (compositor.ts) là câu trả lời thật vì nó hỏi compositor. `startedAt` chỉ còn
 * là **fallback** cho trường hợp compositor không trả lời được: `wlrctl` vắng mặt, hoặc cả hai app
 * đều bị minimize nên không app nào active. Fallback được ghi log để lần sau không phải đoán lại.
 */
/**
 * App ngoài **cuối cùng** được compositor báo là active.
 *
 * Vì sao phải nhớ: khi overlay bàn phím đã map, chính nó là toplevel đang active, nên **không** app
 * ngoài nào còn báo `state:active`. Đo trên panel: Firefox đang trước, chạm ô bàn phím, rồi ✕ —
 * `wlrctl` trả `no` cho cả Firefox lẫn FreeTube, nên bản trước rơi vào `startedAt` và đóng FreeTube
 * trong khi Firefox mới là cửa sổ người dùng đang nhìn. Đây đúng là lỗi NTF-R09 mà đợt này phải sửa,
 * chỉ khác đường vào.
 *
 * Giá trị này chỉ dùng khi compositor **không** trả lời được, và chỉ khi nhóm đó còn chạy — người dùng
 * không thể đổi cửa sổ trong lúc overlay đang che màn hình, nên nó không thể lỗi thời theo cách khác.
 */
let lastActiveId: string | null = null;

/**
 * Ghi nhớ app ngoài mà người dùng **vừa nhắm tới** (tile app, hoặc đích popup bàn phím).
 *
 * Cần vì overlay bàn phím chiếm active của compositor ngay khi map: nếu chỉ dựa vào
 * `activeExternalId()` thì mọi câu hỏi "app nào đang trước" đặt ra trong lúc popup mở đều trả `null`.
 */
export function noteActiveExternal(id: string | null): void {
  if (id !== null) lastActiveId = id;
}

export interface FrontExternalDeps {
  readonly scanGroups?: () => ExternalGroup[];
  readonly isMinimized?: (appIds: readonly string[]) => Promise<boolean>;
  readonly activeGroup?: () => Promise<ExternalGroup | null>;
  readonly appIdsFor?: (id: string) => readonly string[];
}

export async function frontExternalApp(deps?: FrontExternalDeps): Promise<ExternalGroup | null> {
  const scanGroups = deps?.scanGroups ?? scanExternalGroups;
  const checkMinimized = deps?.isMinimized ?? isExternalMinimized;
  const findActive = deps?.activeGroup ?? activeExternalGroup;
  const getAppIds = deps?.appIdsFor ?? appIdsFor;

  const allGroups = scanGroups();
  if (allGroups.length === 0) return null;

  // QA09-04: loại nhóm đang minimized trước short-circuit 1 nhóm và trước mọi fallback.
  const groups: ExternalGroup[] = [];
  for (const group of allGroups) {
    if (!(await checkMinimized(getAppIds(group.id)))) groups.push(group);
  }
  if (groups.length === 0) return null;
  if (groups.length === 1) {
    const only = groups[0];
    if (only) return only;
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const active = await findActive();
    if (active && groups.some((group) => group.id === active.id)) return active;
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 120));
  }
  if (lastActiveId !== null) {
    const remembered = groups.find((group) => group.id === lastActiveId);
    if (remembered) {
      console.log(`[external] overlay đang giữ active — dùng app active gần nhất: ${remembered.label}`);
      return remembered;
    }
  }
  const newest = groups.reduce((best, group) => (group.startedAt > best.startedAt ? group : best));
  console.log(`[external] không app nào báo state:active trong ${groups.length} nhóm — dùng fallback startedAt cho ${newest.label}`);
  return newest;
}

/**
 * App ngoài đang active theo **đúng** câu trả lời của compositor, không có fallback.
 *
 * Cần riêng khỏi `frontExternalApp()` cho nút bàn phím thủ công: ở đó "không app nào active" là một
 * câu trả lời **có nghĩa** — kiosk đang ở phía trước, vì `revealKioskOverExternal()` đã hạ app ngoài
 * xuống — nên đoán bừa theo `startedAt` sẽ mở popup với đích là một cửa sổ đang bị che.
 */
export async function activeExternalGroup(): Promise<ExternalGroup | null> {
  const groups = scanExternalGroups();
  if (groups.length === 0) return null;
  const index = await activeExternalId(groups.map((group) => appIdsFor(group.id)));
  const found = index === null ? null : (groups[index] ?? null);
  if (found) lastActiveId = found.id;
  return found;
}

/**
 * Đóng **chỉ** app ngoài đang ở trên cùng. Trả nhãn đã đóng, hoặc `null` khi không có gì để đóng.
 *
 * Đây là hành vi NTF-R09 yêu cầu: khi Firefox và FreeTube cùng mở, một lần chạm ✕ phải đóng đúng
 * cửa sổ đang che kiosk và app còn lại vẫn phải chạy. Vì vậy hàm này lọc theo `group.pids` của đúng
 * một nhóm, không gọi `closePids()` với toàn bộ `/proc`.
 */
export async function closeFrontExternalApp(): Promise<string | null> {
  const group = await frontExternalApp();
  if (!group) return null;
  await closePids(group.pids);
  if (lastActiveId === group.id) lastActiveId = null;
  return group.label;
}

/**
 * Các `app_id` mà compositor có thể báo cho một app ngoài, lấy từ cùng bảng `EXTERNAL_PROCS` đã dùng
 * để quét `/proc`.
 *
 * Cần cho NTF-R07: sau khi `revealKiosk()` hạ app ngoài xuống, cách duy nhất để khách lấy lại nó là
 * chạm lại đúng tile trên dock — và lúc đó phải `focus` được cửa sổ đã hạ, tức là phải biết `app_id`.
 */
export function appIdsFor(id: string): readonly string[] {
  return EXTERNAL_PROCS.find((proc) => proc.id === id)?.appIds ?? [];
}

async function closePids(pids: number[]): Promise<boolean> {
  if (pids.length === 0) return true;
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* đã chết trước đó */
    }
  }
  // Điều kiện dừng là *những pid này* đã chết, không phải "không còn app ngoài nào": nếu khách vừa
  // mở thêm Firefox trong lúc ta đang đóng FreeTube thì vòng chờ cũ sẽ không bao giờ kết thúc.
  const alive = (): number[] => pids.filter((pid) => isAlive(pid));
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const remaining = alive();
    if (remaining.length === 0) return true;
    if (attempt === 5) {
      for (const pid of remaining) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* đã chết trước đó */
        }
      }
    }
  }
  return alive().length === 0;
}

/** `kill(pid, 0)` chỉ kiểm tra sự tồn tại; EPERM nghĩa là còn sống nhưng khác chủ. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === 'EPERM';
  }
}
