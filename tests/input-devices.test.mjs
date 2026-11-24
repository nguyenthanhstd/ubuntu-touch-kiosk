import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInputDevices } from '../dist/main/input-devices.js';

/**
 * Khối chép nguyên từ `/proc/bus/input/devices` của panel QA (`ELAN Touchscreen`), không sửa một byte:
 * đây là bằng chứng cho định dạng bitmap 32 bit, word cao trước, in hex không đệm.
 */
const ELAN = `I: Bus=0003 Vendor=04f3 Product=8512 Version=0110
N: Name="ELAN Touchscreen"
P: Phys=usb-0000:00:14.0-1/input0
S: Sysfs=/devices/pci0000:00/0000:00:14.0/usb1/1-1/1-1:1.0/0003:04F3:8512.0001/input/input12
U: Uniq=
H: Handlers=mouse0 event5
B: PROP=2
B: EV=1b
B: KEY=400 0 0 0 0 0
B: ABS=3273800000000003
B: MSC=20`;

/** Một chuột không dây: chỉ ba nút chuột trong `KEY`, không có `EV_ABS`. */
const MOUSE = `I: Bus=0005 Vendor=046d Product=c52b Version=0121
N: Name="Logitech M185"
H: Handlers=mouse1 event6
B: EV=17
B: KEY=70000 0 0 0 0 0 0 0 0
B: REL=103`;

/**
 * Một loa USB: có `EV_KEY` cho nút nguồn, không có chạm và không có `EV_ABS`.
 *
 * `KEY=0 0 0 0 0 100000 0 0 0` — chín word, word **cao nhất trước**. Word thứ sáu (index 5) phủ các
 * mã 96–127, và bit 20 của nó là mã 116 = `KEY_POWER`, tức là **ngoài** dải nút chuột 272–279. Con số
 * này không tuỳ tiện: nếu đặt bit đó vào word đầu thì nó rơi đúng vào dải chuột và thiết bị bị loại,
 * làm ca kiểm thử mất chính thứ nó định kiểm.
 */
const SPEAKER = `I: Bus=0003 Vendor=1234 Product=5678 Version=0100
N: Name="USB Speaker"
H: Handlers=event9
B: EV=3
B: KEY=0 0 0 0 0 100000 0 0 0`;

test('màn cảm ứng thật của panel được chọn, đúng node', () => {
  const devices = parseInputDevices(ELAN);
  assert.deepEqual(devices, [{ node: '/dev/input/event5', name: 'ELAN Touchscreen' }]);
});

test('bitmap 32 bit word-cao-trước: 0x70000 ở word đầu là bit 16..18, tức BTN_LEFT/RIGHT/MIDDLE', () => {
  // Nếu đọc sai thứ tự, `0x70000` sẽ thành bit 16 của *word thấp* — vẫn trong dải chuột, nên ca này
  // một mình không khoá được thứ tự. Ca `BTN_TOOL_FINGER` bên dưới mới khoá: sai thứ tự thì `0x400`
  // thành bit 10 và màn cảm ứng bị loại vì "chỉ có phím lạ", không phải vì đúng lý do.
  assert.deepEqual(parseInputDevices(MOUSE), []);
});

test('BTN_TOOL_FINGER 0x400 ở word cao nhất nằm NGOÀI dải chuột nên được giữ', () => {
  // Sáu word: `0x400` là code 170 với cách đọc đúng. Với cách đọc 64-bit/word nó cũng là 170, nhưng với
  // cách đọc word-thấp-trước nó thành 10 — và 10 vẫn ngoài dải chuột, nên phải kiểm cả một mã *trong*
  // dải để phân biệt. Đó là việc của ca chuột ở trên; ca này chỉ xác nhận kết luận cuối cùng.
  const devices = parseInputDevices(ELAN);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, 'ELAN Touchscreen');
});

test('chuột chỉ có nút chuột bị loại', () => {
  assert.deepEqual(parseInputDevices(MOUSE), []);
});

test('thiết bị không có EV_KEY và không có EV_ABS bị loại', () => {
  const noKeys = `N: Name="USB Camera"
H: Handlers=event9
B: EV=1
B: REL=0`;
  assert.deepEqual(parseInputDevices(noKeys), []);
});

test('nhiều thiết bị trong một lần đọc: chỉ màn cảm ứng sống sót', () => {
  const devices = parseInputDevices(`${ELAN}\n\n${MOUSE}\n\n${SPEAKER}`);
  // Loa có EV_KEY nhưng chỉ nút ngoài dải chuột nên vẫn được giữ — phím cứng là thao tác thật.
  assert.deepEqual(devices, [
    { node: '/dev/input/event5', name: 'ELAN Touchscreen' },
    { node: '/dev/input/event9', name: 'USB Speaker' },
  ]);
});

test('bàn phím có rất nhiều bit phím vẫn được giữ', () => {
  const keyboard = `N: Name="AT Translated Set 2 keyboard"
H: Handlers=sysrq kbd event3 leds
B: EV=120013
B: KEY=402000000 3803078f800d001 feffffdfffefffff fffffffffffffffe`;
  assert.deepEqual(parseInputDevices(keyboard), [{ node: '/dev/input/event3', name: 'AT Translated Set 2 keyboard' }]);
});

test('nút chỉ khai EV_ABS (không EV_KEY) vẫn được chọn — đây là lý do EV_ABS được kiểm', () => {
  const absOnly = `N: Name="Abs-only panel"
H: Handlers=event7
B: EV=9
B: ABS=3273800000000003`;
  assert.deepEqual(parseInputDevices(absOnly), [{ node: '/dev/input/event7', name: 'Abs-only panel' }]);
});

test('chuỗi rỗng và khối rác không làm nổ', () => {
  assert.deepEqual(parseInputDevices(''), []);
  assert.deepEqual(parseInputDevices('garbage\n\nmore garbage'), []);
});

test('nhiều event node trên cùng thiết bị đều được giữ', () => {
  const multi = `N: Name="Multi"
H: Handlers=event1 event2 mouse0
B: EV=1b
B: ABS=1`;
  assert.deepEqual(parseInputDevices(multi), [
    { node: '/dev/input/event1', name: 'Multi' },
    { node: '/dev/input/event2', name: 'Multi' },
  ]);
});
