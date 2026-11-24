/**
 * Liệt kê nút vào cần theo dõi nhàn rỗi — tầng ② logic thuần, chỉ đọc văn bản.
 *
 * Đầu vào là nội dung `/proc/bus/input/devices`, không phải một lần quét `/dev/input` thô: mỗi khối ở
 * đó có tên thiết bị và bitmap khả năng, nên chọn được đúng nút có thao tác thật. Quét
 * `/dev/input/event*` thô sẽ mở cả 23 nút (đo được trên panel này), trong đó phần lớn không bao giờ
 * phát sự kiện — mỗi nút là một fd và hai lần đọc mỗi giây, nhân lên thành việc vô ích.
 *
 * Tách khỏi `idle-watch.ts` để phần chọn nút kiểm được bằng `node --test` trên một chuỗi `/proc`
 * chép tay, không cần panel và không cần Wayland.
 *
 * Định dạng bitmap là thứ đã đo, không phải suy đoán. Trên panel QA, `ELAN Touchscreen` in:
 *
 *     B: EV=1b
 *     B: KEY=400 0 0 0 0 0
 *     B: ABS=3273800000000003
 *
 * Tức là mỗi word là **32 bit**, in hex **không đệm**, ngăn bằng dấu cách, và **word cao trước** — nên
 * `0x400` ở vị trí đầu tiên là bit 170 (`BTN_TOOL_FINGER`), không phải bit 10. Đọc nhầm thứ tự này sẽ
 * chọn đúng thiết bị nhưng vì lý do sai, rồi vỡ ở thiết bị khác.
 */

export interface InputDevice {
  /** Đường dẫn nút, ví dụ `/dev/input/event5`. */
  node: string;
  /** Tên do kernel đặt, dùng cho nhật ký chẩn đoán. */
  name: string;
}

/** `EV_SYN` = 0, `EV_KEY` = 1, `EV_ABS` = 3. */
const EV_KEY = 1;
const EV_ABS = 3;
/** `BTN_LEFT` = 0x110 … `BTN_TASK` = 0x117 là dải nút chuột duy nhất trong toàn bảng mã. */
const BTN_MOUSE_FIRST = 0x110;
const BTN_MOUSE_LAST = 0x117;
/** Số bit một word của bitmap kernel. */
const WORD_BITS = 32;

/**
 * Kernel in bitmap dạng các word 32 bit, **word cao trước**. Nên bit `code` nằm ở word
 * `words.length - 1 - floor(code / 32)`, tại vị trí `code % 32`.
 */
function bitmapHas(words: string[], code: number): boolean {
  const index = words.length - 1 - Math.floor(code / WORD_BITS);
  const word = words[index];
  if (word === undefined) return false;
  const value = Number.parseInt(word, 16);
  if (!Number.isFinite(value)) return false;
  return (value & (1 << (code % WORD_BITS))) !== 0;
}

/**
 * Đọc danh sách nút từ nội dung `/proc/bus/input/devices`.
 *
 * Mỗi khối cách nhau một dòng trống. `H: Handlers=` liệt kê các node kèm cờ một chữ cái
 * (`event5`, `kbd`, `mouse0`); chỉ lấy `event\d+`.
 */
export function parseInputDevices(procText: string): InputDevice[] {
  const devices: InputDevice[] = [];
  for (const block of procText.split(/\r?\n\r?\n/)) {
    let name = '';
    let handlers = '';
    let evWords: string[] = [];
    let keyWords: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('N: Name=')) name = line.slice('N: Name='.length).replace(/^"|"$/g, '');
      else if (line.startsWith('H: Handlers=')) handlers = line.slice('H: Handlers='.length);
      else if (line.startsWith('B: EV=')) evWords = words(line.slice('B: EV='.length));
      else if (line.startsWith('B: KEY=')) keyWords = words(line.slice('B: KEY='.length));
    }
    // Màn cảm ứng của panel khai `EV=1b` (EV_SYN|EV_KEY|EV_ABS|EV_MSC) và bitmap KEY chỉ có
    // `BTN_TOOL_FINGER`, nên `EV_ABS` mới là thứ chắc chắn phân biệt được nó với một cái loa USB.
    if (!bitmapHas(evWords, EV_KEY) && !bitmapHas(evWords, EV_ABS)) continue;
    // Thiết bị **chỉ** có nút chuột không phải nguồn "có người": một con chuột không dây rung theo mặt
    // bàn sẽ phát sự kiện liên tục và màn hình chờ không bao giờ hiện. Bàn phím khai hàng trăm bit,
    // màn cảm ứng khai `BTN_TOOL_FINGER` (0xaa, ngoài dải chuột) — cả hai vẫn được giữ.
    if (keyWords.length > 0 && isMouseOnly(keyWords)) continue;
    for (const token of handlers.split(/\s+/)) {
      if (/^event\d+$/.test(token)) devices.push({ node: `/dev/input/${token}`, name });
    }
  }
  return devices;
}

function words(raw: string): string[] {
  return raw.trim().split(/\s+/).filter(Boolean);
}

/** Đúng khi mọi bit đặt trong `KEY` đều nằm trong dải nút chuột (hoặc không có bit nào). */
function isMouseOnly(keyWords: string[]): boolean {
  const width = keyWords.length * WORD_BITS;
  for (let code = 0; code < width; code += 1) {
    if (!bitmapHas(keyWords, code)) continue;
    if (code < BTN_MOUSE_FIRST || code > BTN_MOUSE_LAST) return false;
  }
  return true;
}
