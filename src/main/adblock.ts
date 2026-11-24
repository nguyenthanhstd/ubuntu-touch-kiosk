import { readFile } from 'node:fs/promises';
import type { AdblockDomain, AdblockStats } from '../shared/chrome.js';

/**
 * Đọc số liệu chặn quảng cáo do `scripts/ntf-adblock-status.sh` ghi ra.
 *
 * Vì sao không gọi thẳng API AdGuard: `/control/stats` đòi mật khẩu quản trị, còn
 * `/control/filtering/*` đòi quyền ghi. Renderer của kiosk hiển thị trang web tuỳ ý, nên đặt mật
 * khẩu ở đó là cho một trang quảng cáo khả năng đổi DNS của cả nhà. Tiến trình root giữ bí mật và
 * chỉ công bố con số; ở đây chỉ đọc một tệp JSON.
 *
 * Số liệu không đổi nhanh hơn 30 giây (nhịp của timer) nên đọc lại mỗi lần mở panel là đủ, không
 * cần cache trong tiến trình.
 */

/** Chưa có tệp hoặc tệp hỏng: panel hiện "chưa có dữ liệu" thay vì báo 0 lượt chặn. */
export const ADBLOCK_EMPTY: AdblockStats = {
  ok: false,
  at: 0,
  queries: 0,
  blocked: 0,
  percent: 0,
  topBlocked: [],
  topQueried: [],
  topClients: [],
  adminUrl: '',
};

const STATUS_PATH = process.env['NTF_ADBLOCK_STATUS'] ?? '/var/lib/ntf/adblock-status.json';

/** AdGuard trả `[name, count]`; giữ nguyên kiểu cặp thay vì hai mảng song song. */
function toRows(value: unknown): AdblockDomain[] {
  if (!Array.isArray(value)) return [];
  const rows: AdblockDomain[] = [];
  for (const item of value) {
    if (!Array.isArray(item)) continue;
    const name = item[0];
    const count = item[1];
    if (typeof name !== 'string' || name === '') continue;
    rows.push({ domain: name, count: typeof count === 'number' && Number.isFinite(count) ? count : 0 });
  }
  return rows;
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

/**
 * Chuẩn hoá JSON trên đĩa. Tệp do root ghi, nhưng vẫn kiểm từng trường: một bản AdGuard mới đổi
 * tên khoá sẽ làm panel hiện `NaN` chứ không làm app vỡ, và đó là kiểu hỏng tệ nhất trên kiosk.
 */
export function parseAdblockStats(raw: string): AdblockStats {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) return ADBLOCK_EMPTY;
  const row = parsed as Record<string, unknown>;
  const percent = typeof row['percent'] === 'number' && Number.isFinite(row['percent']) ? row['percent'] : 0;
  return {
    ok: row['ok'] === true,
    at: toCount(row['at']),
    queries: toCount(row['queries']),
    blocked: toCount(row['blocked']),
    percent: Math.min(100, Math.max(0, percent)),
    topBlocked: toRows(row['topBlocked']),
    topQueried: toRows(row['topQueried']),
    topClients: toRows(row['topClients']),
    adminUrl: typeof row['adminUrl'] === 'string' ? row['adminUrl'] : '',
  };
}

/** Đọc tệp số liệu. Mọi lỗi — chưa cài, chưa chạy lần nào, JSON hỏng — đều thành `ADBLOCK_EMPTY`. */
export async function readAdblockStats(): Promise<AdblockStats> {
  try {
    return parseAdblockStats(await readFile(STATUS_PATH, 'utf8'));
  } catch {
    return ADBLOCK_EMPTY;
  }
}
