# Khung cửa sổ, thanh trên và hình nền

Ứng dụng chạy `frame: false` và không có titlebar của WM, nên "khung" là do **hình học + bo góc CSS**
tạo ra chứ không phải cửa sổ X11 trang trí. Kiosk chiếm toàn panel (2560×1600 tại `0,0`) và ba view
con vẽ thanh trên, nội dung, dock — không còn tấm slab bọc thanh + dock.

| Hằng số | Giá trị | Ở đâu | Ý nghĩa |
| :-- | :-- | :-- | :-- |
| `FRAME_INSET` | `10` | `src/shared/chrome.ts` | Viền quanh thanh và dock; đây là "khoảng không" thấy hình nền |
| `FRAME_RADIUS` | `22` | `src/shared/chrome.ts` | Bo **cả 4 góc** thanh trên; bằng nửa chiều cao 44 px nên thanh thành viên thuốc |
| `BAND_RADIUS_CSS` | `24` | `src/shared/chrome.ts` | Bán kính cung của băng nội dung (lớn hơn `FRAME_RADIUS` 2 px để cung không cắt vào thanh) |
| `FRAME_RING_CSS` | `2` | `src/shared/chrome.ts` | Độ dày vòng hairline vẽ quanh băng nội dung |
| `FRAME_MASK_CSS` | `26` | `src/shared/chrome.ts` | Cạnh **ô mặt nạ góc** = `BAND_RADIUS_CSS + FRAME_RING_CSS` |

`FRAME_RADIUS` được khai lại thành `--frame-radius` trong `shell.css` (không có đường inject CSS, nên
buộc phải khai bằng tay — sửa một nơi là phải sửa cả hai). `scripts/gen-labwc-config.sh` cũng lặp lại
`FRAME_INSET` / `TOP_BAR_CSS` / `DOCK_CSS` vì shell không import được TypeScript:

- Thanh trên là một **viên thuốc** bo 4 góc ở `y 10…54`; dock bo góc riêng ở đáy. Không còn khung nào
  bao quanh cả hai.
- `navView` phủ **toàn bộ** cửa sổ để hình nền trải hết khung; `.news` tự chừa chỗ cho thanh và dock.
- `topView` và `dockView` **trong suốt** (`setBackgroundColor('#00000000')`) để đọc hình nền bên dưới.
- Nền kính của thanh trên nằm ở `.bar-surface`, **không** đặt trên `body.top`: background của `body`
  bị CSS propagate ra canvas, nơi `border-radius` không cắt được, và góc sẽ bị vuông. `.dock-shell`
  đã đúng pattern này từ trước.

## Mặt nạ góc — vì sao phải là cửa sổ riêng

App ngoài (Chromium, FreeTube, Firefox) là **toplevel client riêng** của labwc. Surface Wayland của
nó luôn là hình chữ nhật phủ đúng băng `2540×1440 @ (10,54)`; labwc là stacking compositor nên **không
có API Wayland nào** cho cửa sổ A cắt góc cửa sổ B. `cornerRadius` trong `rc.xml` chỉ khoét buffer
decoration/shadow do **server** vẽ, mà mọi rule ở đây đều `serverDecoration="no"` — server không vẽ gì
thì cũng không có gì để bo. Vòng hairline 2 px chỉ phủ vài hàng đầu của cung 24 px, phần ngoài cung vẫn
là pixel của app ⇒ lòi góc.

Cách xử: **bốn ô 26×26 px** vẽ lại đúng hình nền, đục ở phần **ngoài** cung 24 px và trong suốt ở phần
trong. Chín cửa sổ khung (`src/main/frame-window.ts`) nên `PART_ORDER` là:

```
corner-tl, corner-tr, corner-bl, corner-br, top, bottom, left, right, close
```

Ô mặt nạ **phải tạo trước** bốn dải 2 px: vùng đục của mặt nạ vẫn chồng lên hai hàng đầu của dải tại
góc, nơi cung bị bóp dẹt; nếu mặt nạ nằm trên sẽ ăn mất hai hàng ấy. `close` luôn cuối vì nó phải nhận
chạm.

Luật cứng:

- `.mask-wall` là layer **toàn panel**, không phải layer 26×26: `navView` phủ toàn cửa sổ
  (`view-manager.ts` đặt `{0,0,width,height}`) nên gốc hình nền ở `(0,0)` của panel, không ở mép băng.
  Cửa sổ góc cắt layer đó bằng `overflow:hidden` của `html,body` (`shell/base.css`).
- Vì vậy `--mask-x`/`--mask-y` là toạ độ cửa sổ góc trong **toạ độ panel**, do main process gửi kèm
  trong payload `ntf:settings` (`FrameSettings { settings, geometry }`) — CSS không tự suy ra được.
- `background-attachment: fixed` **không dùng được**: viewport của cửa sổ góc chỉ 26×26 nên `cover`
  resolve sai.
- Công thức `mask-image` phải trong suốt tới **đúng** bán kính cung rồi mới đục:
  `radial-gradient(circle at …, transparent 0 24px, #000 25px)`. Dừng ở `23.5px` sẽ để lọt một viền
  pixel của app.
- `setIgnoreMouseEvents(true)` cho mọi part ≠ `close`: ô trên-phải chồng nửa trái nút ✕ (46×44).

`gen-labwc-config.sh` sinh thêm bốn rule `NTF frame corner-*` với `ResizeTo 26×26` tại
`(10,54) / (2524,54) / (10,1468) / (2524,1468)` — khớp `framePartRects()` trong `src/main/layout.ts`.

**Giới hạn đã biết:** nếu `uiZoom` khác `normal`, `navContents.setZoomFactor(1.15 | 1.3)` làm viewport
CSS px của nav thành `2560 / zoomFactor`, nên `--panel-w`/`--panel-h` phải chia cho zoom factor thì mặt
nạ mới khớp. Hiện `pushSettings()` gửi pixel vật lý, đúng cho mặc định `normal`.

Thanh trên chia 3 vùng (`top-left` / `clock` / `top-right`), trong đó `.clock` là `position: absolute`
giữa thanh nên **luôn** ở tâm cửa sổ bất kể hai cụm hai bên rộng bao nhiêu.

Đồng hồ **dùng chung một bộ định dạng** (`src/shared/clock.ts`: `clockParts()`), hiển thị
`HH:MM:SS` theo `hourCycle:'h23'` (không phải `'h24'` — `'h24'` vẽ nửa đêm thành `24:00`) và ghim
về `Asia/Ho_Chi_Minh`. Timezone của máy cũng đã đặt đúng `Asia/Ho_Chi_Minh`, nên đồng hồ hệ thống và
đồng hồ trong app khớp nhau.

Không dùng `'h24'` và **không** để mỗi màn hình tự định dạng: bản cũ có thanh trên do main process
định dạng, màn hình chờ do renderer tự `${getHours()}:${getMinutes()}` — hai nguồn, hai kết quả khác
nhau.

Vài giây màu đỏ (`--danger`) và sáu chữ số đều **lăn dọc** khi đổi giá trị
(`src/renderer/shared/clock-digits.ts`, `.dg`: hai mặt số xếp chồng, `transform: translateY`, có
nhánh `prefers-reduced-motion`). Thanh trên dùng số lăn; màn hình chờ dùng cùng bộ đó.

Hai nút phong cách Windows ở góc phải thanh trên:

| Nút | Hành vi | Vì sao |
| :-- | :-- | :-- |
| `─` | `press({type:'home'})` — đưa app về dock, giữ thanh trên + dock | Thu nhỏ thật sẽ để lộ app ngoài đang mở; `home` mới là "thu nhỏ" đúng nghĩa ở kiosk |
| `✕` | `press({type:'session'})` — hộp thoại xác nhận rồi kết thúc phiên | `Restart=on-failure` nên `app.quit()` không bị bật lại |

Logo **NT Fitness** cũng là nút Home.

Hình nền **cố định** là `assets/NT-Studio-2145-edited.png` (`DEFAULT_WALLPAPER = 'studio'` trong
`src/main/security.ts`), tham chiếu bằng `url()` tương đối trong `nav.css`. Bộ chọn hình nền, khối nội
dung Home và các ô dịch vụ đã được **bỏ**: trang Home giờ chỉ còn hình nền, thanh trên và dock.
`paintWallpaper()` vẫn còn trong `nav.js` để phục vụ ảnh `custom` nếu settings có sẵn.

