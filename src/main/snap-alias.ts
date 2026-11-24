/**
 * Ghép binary sẽ chạy với tiền tố trong `EXTERNAL_PROCS` — kể cả khi binary là shim của snap.
 *
 * Vì sao cần một hàm riêng (QA09-03): snap cài `/snap/bin/firefox` là một **symlink**, và đó là đường
 * dẫn `dock-actions.ts` thật sự chạy. Nhưng `/proc/<pid>/cmdline` báo đường dẫn **đã resolve**,
 * `/snap/firefox/<rev>/...` — nên phép so `'/snap/bin/firefox'.startsWith('/snap/firefox/')` trả
 * `false`. Hệ quả đo trên panel: chạm tile Firefox thì `externalIdForBinary()` trả `null`, bàn phím
 * giữ đích `kiosk`, popup nằm dưới cửa sổ Firefox (`target=kiosk overlay=false`) và không gõ được gì.
 *
 * Cùng một app có **ba** dạng đường dẫn, và bảng `EXTERNAL_PROCS.prefix` chỉ chứa dạng thứ hai:
 *
 * 1. `/snap/bin/firefox` — shim trong PATH, đây là thứ dock gọi;
 * 2. `/snap/firefox/6063/...` — đường dẫn đã resolve, đây là thứ `/proc` báo;
 * 3. `/usr/bin/firefox` — chỉ có khi cài qua apt, không phải ca của máy này.
 *
 * Nên chuẩn hoá dạng 1 về dạng 2 **trước** khi so tiền tố, và so cả dạng gốc để `/usr/bin` hay một
 * đường dẫn bất kỳ vẫn đi qua đúng luật cũ. Không đoán theo tên app: `/snap/bin/<x>` → `/snap/<x>/`
 * là đúng quy tắc snap dùng cho mọi snap, không riêng Firefox/Chromium.
 *
 * Hàm thuần, không đọc `/proc`, không `existsSync` — để test được ngoài máy thật.
 */

/** Tên snap trong một shim `/snap/bin/<name>`, hoặc `null` khi đường dẫn không phải shim snap. */
export function snapNameOf(binary: string): string | null {
  // Chỉ một đoạn tên, không có `/` con: `/snap/bin/firefox/foo` không phải shim.
  const match = /^\/snap\/bin\/([^/]+)\/?$/.exec(binary);
  return match?.[1] ?? null;
}

/**
 * Đường dẫn đã resolve mà `/proc` sẽ báo cho cùng binary đó.
 *
 * Giữ nguyên đường dẫn khi nó không phải shim snap — `/usr/bin/firefox` phải ở lại
 * `/usr/bin/firefox`, không được biến thành `/usr/bin/../..`.
 */
export function resolveSnapBinary(binary: string): string {
  const name = snapNameOf(binary);
  return name === null ? binary : `/snap/${name}/`;
}

/**
 * Binary có thuộc tiền tố của một app ngoài không.
 *
 * So **cả hai** dạng để một tiền tố trỏ thẳng vào `/snap/firefox/` khớp được shim, còn tiền tố kiểu
 * `/opt/FreeTube/freetube` không bị ảnh hưởng gì.
 */
export function matchesExternalPrefix(binary: string, prefix: string): boolean {
  return binary.startsWith(prefix) || resolveSnapBinary(binary).startsWith(prefix);
}
