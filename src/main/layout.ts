import {
  APP_CLOSE_H,
  APP_CLOSE_W,
  DOCK_CSS,
  FRAME_INSET,
  FRAME_MASK_CSS,
  FRAME_RING_CSS,
  FRAME_TOP_CSS,
  TOP_BAR_CSS,
} from '../shared/chrome.js';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ChromeLayout {
  top: Rect;
  dock: Rect;
  content: Rect;
}

/**
 * The panel is one 2560x1600 output. The top bar and the dock are real WebContentsViews, not HTML
 * inside the page, so a remote site can never draw over them and cannot capture their input.
 *
 * The wallpaper is full bleed, while the bar and the dock are pill-shaped strips inset by
 * FRAME_INSET: the page reads as content framed by two floating controls instead of a slab painted
 * to the bezel. The content band is bounded by the bar above and the dock below, so a service opens
 * *between* them and can never reach the rounded corners that the bar and dock paint.
 */
export interface FrameParts {
  /** Bốn dải viền, vẽ ngay bên trong mép rect content. */
  top: Rect;
  bottom: Rect;
  left: Rect;
  right: Rect;
  /** Cửa sổ nút ✕ phủ lên nút ✕ của app ngoài. */
  close: Rect;
  /**
   * Bốn ô mặt nạ 26x26 ở bốn góc băng, vẽ lại hình nền để che góc vuông của app ngoài.
   *
   * App ngoài là một toplevel Wayland riêng, surface của nó luôn là hình chữ nhật: compositor
   * không có API nào cho cửa sổ này khoét góc cửa sổ kia, và `cornerRadius` của labwc chỉ áp cho
   * buffer decoration do server vẽ — mà mọi app ở đây đều chạy `serverDecoration="no"`. Nên cách
   * duy nhất để bốn góc trông tròn là *vẽ đè* lên chúng bằng chính hình nền. Ô mặt nạ đúng bằng
   * cung tròn cộng bề dày vòng (26 = 24 + 2), nên nó chỉ che phần nằm ngoài cung và không ăn vào
   * một pixel nào của app ở bên trong cung.
   */
  cornerTL: Rect;
  cornerTR: Rect;
  cornerBL: Rect;
  cornerBR: Rect;
  /**
   * Chiều cao dải titlebar mà app ngoài tự vẽ trong băng. Khung không vẽ đè lên dải này, nhưng nó
   * chặn chiều cao nút ✕: nút không bao giờ cao hơn titlebar mà nó định thay thế.
   */
  titleBarHeight: number;
}

/**
 * Rect của bộ khung băng nội dung, suy ra từ `layoutFor().content`.
 *
 * Mọi số ở đây đến từ `chrome.ts` và từ rect content, không có số đo nào được viết lại: panel đổi
 * kích thước thì `content` đổi, và khung đi theo mà không phải sửa tệp này lẫn frame-window.ts.
 * Bốn dải viền nằm *bên trong* mép content vì mép ngoài đã là gutter của panel; đặt ra ngoài thì
 * viền sẽ trùm lên gutter và trông như panel bị lệch.
 */
export function framePartsFor(content: Rect, ring: number = FRAME_RING_CSS): FrameParts {
  const bottom = content.y + content.height - ring;
  const rightEdge = content.x + content.width - ring;
  return {
    top: { x: content.x, y: content.y, width: content.width, height: ring },
    bottom: { x: content.x, y: bottom, width: content.width, height: ring },
    left: { x: content.x, y: content.y, width: ring, height: content.height },
    right: { x: rightEdge, y: content.y, width: ring, height: content.height },
    // Nút ✕ nằm ở góc trên phải, đúng chỗ Firefox vẽ ✕ của nó (đo trên panel: vùng chạm
    // 2504–2549 × 54–97). Nó phải phủ trọn vùng chạm đó, nếu không người dùng sẽ chạm trúng ✕ của
    // app và app đóng bằng chính nó — nghĩa là không đóng được app đang treo.
    close: {
      x: content.x + content.width - APP_CLOSE_W,
      y: content.y,
      width: APP_CLOSE_W,
      height: Math.min(APP_CLOSE_H, FRAME_TOP_CSS),
    },
    titleBarHeight: FRAME_TOP_CSS,
    // Ô mặt nạ ôm đúng góc của băng. Góc trên-phải phủ lên nửa trái của nút ✕ (46x44): cửa sổ
    // `close` được tạo sau cùng nên nó nằm trên, nhưng ô mặt nạ vẫn phải click-through để một cú
    // chạm vào cung tròn không bị nuốt.
    cornerTL: { x: content.x, y: content.y, width: FRAME_MASK_CSS, height: FRAME_MASK_CSS },
    cornerTR: {
      x: content.x + content.width - FRAME_MASK_CSS,
      y: content.y,
      width: FRAME_MASK_CSS,
      height: FRAME_MASK_CSS,
    },
    cornerBL: {
      x: content.x,
      y: content.y + content.height - FRAME_MASK_CSS,
      width: FRAME_MASK_CSS,
      height: FRAME_MASK_CSS,
    },
    cornerBR: {
      x: content.x + content.width - FRAME_MASK_CSS,
      y: content.y + content.height - FRAME_MASK_CSS,
      width: FRAME_MASK_CSS,
      height: FRAME_MASK_CSS,
    },
  };
}

/**
 * Tên kebab của một mảnh khung — cũng là giá trị của query `?part=` mà renderer đọc.
 *
 * Khai báo ở đây chứ không ở `frame-window.ts` vì `layout.ts` là nơi duy nhất biết rect nào ứng với
 * mảnh nào; `frame-window.ts` chỉ quyết định thứ tự tạo cửa sổ.
 */
export type FramePart =
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'corner-tl'
  | 'corner-tr'
  | 'corner-bl'
  | 'corner-br'
  | 'close';

/**
 * Đặt tên kebab lên các rect camelCase mà `framePartsFor()` trả về. Bảng ánh xạ ở đây để tên mảnh
 * chỉ được mô tả ở một nơi — `frame-window.ts` nhận đúng `Record<FramePart, Rect>` nên nó không
 * cần biết field nào của `FrameParts` tương ứng mảnh nào.
 */
export function framePartRects(parts: FrameParts): Record<FramePart, Rect> {
  return {
    top: parts.top,
    bottom: parts.bottom,
    left: parts.left,
    right: parts.right,
    'corner-tl': parts.cornerTL,
    'corner-tr': parts.cornerTR,
    'corner-bl': parts.cornerBL,
    'corner-br': parts.cornerBR,
    close: parts.close,
  };
}

export function layoutFor(width: number, height: number): ChromeLayout {
  const dockHeight = Math.min(DOCK_CSS, Math.round(height * 0.14));
  const inset = FRAME_INSET;
  const innerWidth = Math.max(320, width - inset * 2);
  const contentTop = inset + TOP_BAR_CSS;
  const dockTop = Math.max(contentTop + 120, height - inset - dockHeight);
  return {
    top: { x: inset, y: inset, width: innerWidth, height: TOP_BAR_CSS },
    dock: { x: inset, y: dockTop, width: innerWidth, height: dockHeight },
    content: { x: inset, y: contentTop, width: innerWidth, height: Math.max(120, dockTop - contentTop) },
  };
}
