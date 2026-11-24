/**
 * Bảng ô của dock — tầng ① dữ liệu.
 *
 * Tệp này chỉ mô tả **có những ô nào, nhãn gì, glyph gì, bấm thì gửi hành động nào**. Không có
 * `addEventListener`, không đọc DOM, không giữ trạng thái. Nhờ vậy bảng ô đọc được như một bảng cấu
 * hình, và `dock.ts` chỉ còn lo cơ chế chạm (RULE §1.6: tách dữ liệu khỏi cơ chế trước khi sửa).
 *
 * Glyph lấy từ `icons.ts` (đường dẫn Lucide nhúng sẵn) chứ không vẽ tay ở đây. Lucide không có
 * nhãn hiệu, nên ba ô mạng xã hội mượn ẩn dụ trung tính gần nhất: music
 * cho feed thiên về âm thanh, đám đông cho reel, tờ báo cho tin tức. Gradient thương hiệu
 * của ô cộng nhãn chữ là thứ nhận diện ứng dụng.
 */
import type { DockAction } from '../../shared/chrome.js';
import { icon } from './icons.js';

export type DockEntry =
  | { kind: 'item'; key: string; label: string; icon: string; tint: string; action: DockAction }
  | { kind: 'sep' };

export const DOCK_ITEMS: readonly DockEntry[] = [
  {
    kind: 'item',
    key: 'home',
    label: 'Trang chủ',
    icon: icon('house'),
    tint: 'icon-home',
    action: { type: 'home' },
  },
  // YouTube itself comes from the FreeTube item below; the youtube.com service tile was dropped from
  // the dock because two YouTube buttons side by side only confused visitors. The service still
  // exists on the bar's nav path, so DOCK_ORDER in shared/services.ts keeps it.
  {
    kind: 'item',
    key: 'tiktok',
    label: 'TikTok',
    icon: icon('music2'),
    tint: 'icon-tiktok',
    action: { type: 'service', id: 'tiktok' },
  },
  {
    kind: 'item',
    key: 'facebook',
    label: 'Facebook Reel',
    icon: icon('users'),
    tint: 'icon-facebook',
    action: { type: 'service', id: 'facebook' },
  },
  // News is an ordinary service view since the in-page reader was removed, so it presses like every
  // other app tile instead of asking for a special news screen.
  {
    kind: 'item',
    key: 'news',
    label: 'Tin tức',
    icon: icon('newspaper'),
    tint: 'icon-news',
    action: { type: 'service', id: 'news' },
  },
  {
    kind: 'item',
    key: 'app:freetube',
    label: 'FreeTube',
    icon: icon('circlePlay'),
    tint: 'icon-youtube',
    action: { type: 'app', id: 'freetube' },
  },
  { kind: 'sep' },
  {
    kind: 'item',
    key: 'web:google',
    label: 'Tìm kiếm',
    icon: icon('search'),
    tint: 'icon-search',
    action: { type: 'web', id: 'google' },
  },
  {
    kind: 'item',
    key: 'browser',
    label: 'Trình duyệt',
    icon: icon('globe'),
    tint: 'icon-browser',
    action: { type: 'browser' },
  },
  { kind: 'sep' },
  {
    kind: 'item',
    key: 'keyboard',
    label: 'Bàn phím',
    icon: icon('keyboard'),
    tint: 'icon-keyboard',
    action: { type: 'keyboard' },
  },
  // Lock sits next to the keyboard because both are "put the panel into a state", not "open an app".
  // A visitor standing at the panel reaches the bottom edge with a thumb, which is also why this tile
  // exists here as well as on the top strip (see the plan's §6 proposal 1).
  {
    kind: 'item',
    key: 'lock',
    label: 'Khóa',
    icon: icon('lock'),
    tint: 'icon-lock',
    action: { type: 'lock' },
  },
  {
    kind: 'item',
    key: 'session',
    label: 'Kết thúc phiên',
    icon: icon('logOut'),
    tint: 'icon-session',
    action: { type: 'session' },
  },
];
