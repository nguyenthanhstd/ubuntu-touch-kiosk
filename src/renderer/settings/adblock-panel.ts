/**
 * Phần "Chặn quảng cáo" trong thẻ Cài đặt — chỉ đọc.
 *
 * Tách khỏi `settings.ts` vì đây là thứ duy nhất trong thẻ không phải một cài đặt của ứng dụng: hai
 * nhóm kia là cấu hình do người dùng đặt rồi bấm Lưu, còn khối này chỉ vẽ lại số liệu đã có trong tệp
 * JSON của `scripts/ntf-adblock-status.sh`. Gộp vào một tệp thì `settings.ts` vượt trần 200 dòng và
 * trộn hai vòng đời khác nhau (đọc-và-lưu so với chỉ đọc).
 *
 * Không có nút "bật/tắt chặn" ở đây, và đó là quyết định có chủ ý: tắt chặn quảng cáo là một lệnh ghi
 * vào cấu hình DNS của cả nhà. App không giữ mật khẩu quản trị AdGuard, nên nó cũng không thể làm
 * việc đó — muốn tắt thì vào giao diện web.
 */

import type { AdblockStats } from '../../shared/chrome.js';

/** Số tên miền tối đa hiện trong danh sách. Năm dòng là vừa một lần nhìn, không phải cuộn. */
const TOP_N = 5;

const NUM = new Intl.NumberFormat('vi-VN');
const ONE_DECIMAL = new Intl.NumberFormat('vi-VN', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`khối chặn quảng cáo thiếu phần tử #${id}`);
  return element;
}

const blockedEl = byId('adblock-blocked');
const percentEl = byId('adblock-percent');
const totalEl = byId('adblock-total');
const listEl = byId('adblock-list');
const footEl = byId('adblock-foot');

/** Dựng danh sách tên miền. `textContent` chứ không `innerHTML`: tên miền đến từ log DNS. */
function renderList(rows: AdblockStats['topBlocked']): void {
  listEl.replaceChildren();
  if (rows.length === 0) {
    listEl.hidden = true;
    return;
  }
  for (const row of rows.slice(0, TOP_N)) {
    const li = document.createElement('li');
    li.className = 'adblock__item';

    const name = document.createElement('span');
    name.className = 'adblock__domain';
    name.textContent = row.domain;
    name.title = row.domain;

    const count = document.createElement('span');
    count.className = 'adblock__count';
    count.textContent = NUM.format(row.count);

    li.append(name, count);
    listEl.append(li);
  }
  listEl.hidden = false;
}

/**
 * Vẽ một lần đọc. Mọi trường hợp "không có số" đều hiện dấu gạch chứ không hiện 0: `0 lượt chặn` trên
 * một máy đang chạy bình thường là thông tin sai, còn `—` là thông tin đúng (chưa đọc được).
 */
export function renderAdblock(stats: AdblockStats): void {
  if (stats.at === 0) {
    blockedEl.textContent = '—';
    percentEl.textContent = '—';
    totalEl.textContent = 'Chưa có số liệu. Bộ thu thập chạy 30 giây một lần sau khi khởi động.';
    renderList([]);
    footEl.textContent = '';
    return;
  }

  blockedEl.textContent = NUM.format(stats.blocked);
  percentEl.textContent = `${ONE_DECIMAL.format(stats.percent)}%`;
  totalEl.textContent = `${NUM.format(stats.queries)} truy vấn DNS`;
  renderList(stats.topBlocked);

  // Mất kết nối: con số vẫn là của lần chạy cuối, nên phải nói rõ tuổi của nó.
  if (!stats.ok) {
    const minutes = Math.max(1, Math.round((Date.now() / 1000 - stats.at) / 60));
    footEl.textContent = `Không đọc được AdGuard — số liệu cũ ${minutes} phút trước.`;
    footEl.classList.add('is-stale');
    return;
  }
  footEl.classList.remove('is-stale');
  footEl.textContent = stats.adminUrl
    ? `Chi tiết từng truy vấn: ${stats.adminUrl}`
    : 'Chi tiết từng truy vấn: mở giao diện web AdGuard trên máy tính cùng mạng.';
}
