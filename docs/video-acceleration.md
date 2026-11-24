# Video giật: chẩn đoán và tăng tốc giải mã

Tài liệu này trả lời câu "sao xem video cứ giật, hay do không có card màn hình?".

## 0. Thứ tự ưu tiên đã đính chính

Bản đầu của tài liệu này đặt **VA-API** làm nguyên nhân chính. Điều đó **sai**. Câu hỏi "sao cùng máy
đó, Firefox lại không giật?" đã lật lại giả thuyết và buộc phải xếp lại thứ tự:

**Ghép lớp GPU (compositing) là thủ phạm chính. Giải mã phần cứng chỉ là tối ưu phụ.**

Lý do: nếu thiếu VA-API là nguyên nhân thì Firefox cũng phải giật, vì Firefox bản snap **không thấy**
driver VA-API của máy host. Nhưng Firefox mượt. Vậy phần giải mã bằng CPU **đủ sức** — và điều này
khớp với phép đo MP4 loopback 1080p/1440p cho `readyState=4`, **0 khung rơi**.

Bốn nhánh đo thực nghiệm trên panel, **cùng một trang Google Tin tức, cùng một thao tác kéo
chạm**, chỉ khác hai biến:

| Nhánh | Ghép lớp GPU | Cách dựng trang | p95 mỗi khung | Số sự kiện |
| --- | --- | --- | --- | --- |
| `normal-direct` | **bật** | view phủ trực tiếp | **17.6 ms** | 52 |
| `soft-direct` | tắt (phần mềm) | view phủ trực tiếp | 20.7 ms | 43 |
| `normal-embedded` | **bật** | lồng trong khung | 34.0 ms | 49 |
| `soft-embedded` | tắt (phần mềm) | lồng trong khung | **44.2 ms** | 25 |

Đọc bảng này:

- **Bật ghép lớp nhanh hơn 2.5×** khi trang bị lồng: 17.6 → 44.2 ms. Đây là hiệu ứng lớn nhất, và nó
  giải thích vì sao kéo chạm khựng.
- **Việc lồng trang cũng tốn gần gấp đôi** (17.6 → 34.0 ms) ngay cả khi đã bật ghép lớp. Đây là lý do
  nhất quán với quan sát thực tế: FreeTube và Firefox là **toplevel riêng**, không lồng, nên mượt.
- **Tắt ghép lớp khi không lồng gần như không hại** (17.6 → 20.7 ms). Nghĩa là cờ
  `--disable-gpu-compositing` một mình chưa đủ gây khựng; nó chỉ thành thảm hoạ khi **cộng** với trang
  bị lồng — đúng cấu trúc mà kiosk dùng.

Trên máy QA, `NTF_GPU_MODE` đang là `auto`, tức là renderer chạy `--disable-gpu-compositing` (đo
trước đây với NTF-R02: `auto` được chọn để né `SIGSEGV` trong `libgallium`). Cộng thêm việc kiosk luôn
lồng view phủ (`navView`, `topView`, `dockView` là các `WebContentsView` anh em trong
`contentView`), ta rơi đúng vào ô **`soft-embedded` — ô chậm nhất bảng**.

Kết luận thao tác: **đổi `NTF_GPU_MODE` sang `on` trước, đo lại, rồi mới nghĩ tới VA-API.** Việc sửa
tên feature VA-API (§3) vẫn có giá trị — giảm tải CPU, đỡ nóng — nhưng không phải liều thuốc chính.

> Mọi số trong tài liệu này đến từ đo trên máy thật hoặc từ mã nguồn upstream đọc trực tiếp. Chỗ nào
> chưa đo được thì ghi rõ "chưa đo", không suy ra.

## 1. Ba loại "giật" khác nhau, đừng sửa chung một chỗ

| Loại | Dấu hiệu | Nằm ở đâu | Đo bằng |
| --- | --- | --- | --- |
| **A. Video trong Electron** (YouTube, TikTok, Instagram, Facebook trong app) | hình chuyển động giật nhưng thanh tiến trình vẫn chạy, tiếng không vấp | renderer + GPU process | `droppedVideoFrames` của `getVideoPlaybackQuality()`, `section_decode` của doctor |
| **B. Video trong cửa sổ ngoài** (FreeTube, Firefox) | chỉ giật khi xem bằng app ngoài; trong Electron lại mượt | tiến trình con của app đó | `about:support` của Firefox, `media.ffmpeg.vaapi.enabled` |
| **C. Cuộn/chạm giao diện giật** | video không liên quan; vuốt danh sách Tin tức hay dock thì khựng | compositor + cờ ghép lớp GPU | `rafOver33ms`, `scrollP95Ms` của harness E2E |

Cách phân biệt nhanh tại panel: mở **cùng một video YouTube** hai lần, một lần trong app (dịch vụ
`youtubeCom`) và một lần trong Firefox. Nếu chỉ một bên giật thì nguyên nhân nằm ở bên đó, không phải
ở GPU nói chung.

## 2. Đo trước khi sửa

```bash
./scripts/ntf-doctor.sh --out /tmp/doctor.txt
```

Mục **GIẢI MÃ VIDEO** in ra, theo thứ tự:

1. `/dev/dri` — có node `card0`/`renderD128` không.
2. Module GPU đang nạp — `nouveau` hay `nvidia`/`nvidia_drm`.
3. `nvidia-drm.modeset=` trong `/proc/cmdline` — bắt buộc phải là `1` cho `nvidia-vaapi-driver`.
4. `nvidia-smi` — có driver chính hãng chưa.
5. `LIBVA_DRIVER_NAME` / `NVD_BACKEND` **của tiến trình GPU đang chạy**, đọc từ
   `/proc/<pid>/environ`. Đây là chỗ hay bị đánh lừa: shell SSH không kế thừa biến của unit, nên nhìn
   `echo $LIBVA_DRIVER_NAME` trong phiên SSH luôn ra rỗng dù kiosk có đặt.
6. `vainfo` — danh sách `VAProfile*` phần cứng thật.
7. `glxinfo -B` — renderer OpenGL thật (`llvmpipe` nghĩa là đang vẽ bằng CPU).
8. Cờ của renderer đang sống — lọc từ `/proc/<pid>/cmdline` chỉ những cờ quyết định việc có decoder.
9. `%CPU` từng tiến trình con.

Cách đọc: nếu **5 và 6** thiếu profile và **9** cho thấy tiến trình renderer ăn 200–400% CPU khi phát
video thì đúng là đang giải mã bằng phần mềm. Nếu **8** không có dòng `--enable-features=` nào thì
renderer đang chạy mặc định của Chromium — nghĩa là cờ chưa được áp.

## 3. Nguyên nhân đã xác minh trong mã

`src/main/gpu-flags.ts` từng truyền:

```
--enable-features=VaapiVideoDecoder,VaapiIgnoreDriverChecks
```

`VaapiVideoDecoder` **không còn tồn tại** trong Chromium `156.0.8078.100` (bản nằm trong Electron
45.4.1). Chromium bỏ qua tên feature lạ trong im lặng, nên toàn bộ phần VA-API của ứng dụng là no-op.
Đã sửa thành:

```
--enable-features=AcceleratedVideoDecoder,AcceleratedVideoDecodeLinuxGL,VaapiIgnoreDriverChecks
```

Ba điểm dễ sai khi tự sửa lại chỗ này:

- **Tên chuỗi không phải tên C++.** `media_switches.cc` khai
  `BASE_FEATURE(kAcceleratedVideoDecodeLinux, "AcceleratedVideoDecoder", …)` — tên dùng trên dòng lệnh
  là chuỗi `"AcceleratedVideoDecoder"`. Viết `AcceleratedVideoDecodeLinux` vào `--enable-features` thì
  Chromium cũng bỏ qua.
- **`VaapiOnNvidiaGPUs` không nằm trong danh sách mặc định.** `vaapi_wrapper` gặp render node tên
  `nvidia-drm` mà feature này tắt thì log `"Should skip nVidia device named: nvidia-drm"` và **không
  tạo decoder**. Chromium cố ý tắt nó (crbug.com/1492880) vì driver NVIDIA độc quyền trên x64 từng
  làm treo tiến trình GPU. Vì vậy nó chỉ được bật khi có `NTF_GPU_NVIDIA=1`, không bật vô điều kiện.
- **`--ignore-gpu-blocklist`** mà README của `nvidia-vaapi-driver` khuyên dùng thì **không** được
  thêm: nó tắt cả blocklist của GPU compositing, không chỉ của VA-API, và trên `nouveau` từng gây
  `SIGSEGV` trong `libgallium` (lỗi NTF-R02). `VaapiIgnoreDriverChecks` là phạm vi hẹp hơn
  và đủ cho mục đích này.

## 4. Ba bước bật giải mã phần cứng

### Bước 1 — driver NVIDIA chính hãng (làm tại console vật lý)

```bash
sudo apt install nvidia-driver-580 linux-modules-nvidia-580-generic
sudo sed -i 's/^GRUB_CMDLINE_LINUX="/&nvidia-drm.modeset=1 /' /etc/default/grub
sudo update-grub
sudo reboot
```

Hai điều bắt buộc phải nhớ:

- **Làm tại bàn phím và màn hình gắn trực tiếp, không qua SSH.** Nếu driver hỏng thì màn hình mất tín
  hiệu và không còn đường vào máy để sửa. Đây là lý do bước này không nằm trong script nào của repo.
- `nvidia-drm.modeset=1` **đúng là bắt buộc**, không phải khuyến nghị: `nvidia-vaapi-driver` lấy
  buffer qua DRM node, mà thiếu modeset thì node đó không tồn tại ở dạng driver cần.

Sau khi reboot, `./scripts/ntf-doctor.sh` phải in `nvidia` trong mục module và có dòng `nvidia-smi`.

### Bước 2 — cầu VA-API cho NVIDIA

```bash
sudo apt install nvidia-vaapi-driver vainfo
vainfo        # phải thấy VAProfileH264High, VAProfileVP9Profile0, ...
```

`vainfo` **phải xanh trước** khi đụng vào kiosk. `LIBVA_DRIVER_NAME` trỏ tới driver không tồn tại làm
libva hỏng hẳn, tệ hơn "không có tăng tốc".

### Bước 3 — bật trong kiosk bằng biến môi trường

`scripts/run-kiosk.sh` đọc `NTF_VAAPI_DRIVER`; đặt biến này thì script tự export `LIBVA_DRIVER_NAME`,
`NVD_BACKEND=direct` và `NTF_GPU_NVIDIA=1` cho `gpu-flags.ts` thêm feature `VaapiOnNvidiaGPUs`:

```bash
systemctl --user edit ntfitness-kiosk.service    # thêm dòng dưới vào [Service]
# Environment=NTF_VAAPI_DRIVER=nvidia
systemctl --user daemon-reload && systemctl --user restart ntfitness-kiosk.service
```

`NVD_BACKEND=direct` là mặc định vì backend EGL của `nvidia-vaapi-driver` hỏng từ driver 525 trở đi.

### Bước 4 — kiểm chứng, không tin cảm giác

```bash
./scripts/ntf-doctor.sh | sed -n '/GIẢI MÃ VIDEO/,/MEDIA/p'
```

Bốn dấu hiệu "đã bật thật": `gpu-flags` in ra `--enable-features=...VaapiOnNvidiaGPUs...`;
tiến trình GPU có `LIBVA_DRIVER_NAME=nvidia` trong `/proc/<pid>/environ`; `vainfo` liệt kê profile;
`%CPU` của renderer tụt xuống khi phát video 1080p.

Codec trên **GP107 (Pascal)**: H.264 tới 4K60, HEVC Main/Main10 tới 8K, VP9 profile 0/2 tới 4K,
**không có AV1** và **không có YUV444** (YUV444 cần Turing trở lên). YouTube tự chọn AV1 cho nhiều
video — gặp video AV1 thì máy vẫn giải mã bằng CPU dù mọi thứ đã đúng. Ép `av01` sang `vp9` bằng
tiện ích trình duyệt là cách duy nhất nếu gặp ca đó.

## 5. Nhánh sạch hơn: dùng iGPU Intel

Máy có CPU i5-8600K với UHD 630, nhưng BIOS đang đặt `iGPU Multi-Monitor = Disabled` nên `00:02.0`
vắng mặt trên bus PCI. Bật mục đó trong BIOS rồi cắm HDMI vào cổng mainboard sẽ có đường
`i915` + `intel-media-va-driver`: driver trong nhân, không cần cài gói độc quyền, không có rủi ro mất
hình khi cập nhật. Đổi lại phải mở máy và đổi dây, và mất 4GB VRAM rời (không quan trọng với kiosk).

Thứ tự khuyến nghị: thử bước 1–4 trước (không mở máy), chỉ chuyển sang iGPU nếu driver NVIDIA gây lỗi
lặp lại.

## 6. FreeTube và Firefox (loại B)

Firefox không tự bật VA-API khi thấy driver lạ. Trong `about:config`:

```
media.ffmpeg.vaapi.enabled              = true
media.hardware-video-decoding.force-enabled = true
media.rdd-ffmpeg.enabled                = true
gfx.x11-egl.force-enabled               = true
widget.dmabuf.force-enabled             = true
```

và chạy Firefox với `LIBVA_DRIVER_NAME=nvidia MOZ_DISABLE_RDD_SANDBOX=1`. **Firefox bản snap không
thấy driver VA-API của máy host** — nếu FreeTube hoặc Firefox cài bằng snap thì mọi cấu hình trên vô
nghĩa. Kiểm tra bằng `snap list | grep -E 'firefox|freetube'`; nếu có thì cài lại bằng `.deb`.

## 7. Số đo cũ, và chỗ chúng mâu thuẫn

| Nguồn | Điều kiện | Kết quả |
| --- | --- | --- |
| GPU A/B (dock cục bộ) | `NTF_GPU_MODE=auto` | 60.6 fps, p50 16.7 ms, p95 16.8 ms, **0** khung > 33 ms |
| GPU A/B (dock cục bộ) | `NTF_GPU_MODE=on` | 60.4 fps, p50 16.7 ms, p95 16.7 ms, **0** khung > 33 ms |
| QA PERF-01 | cuộn Tin tức, `auto` | `scrollP95Ms=49.4`, `rafOver33ms=9` (~20–30 fps) |
| QA report | có ghép lớp GPU | 17.6 ms/khung |
| YouTube diagnosis | MP4 loopback 1080p/1440p | `readyState=4`, **0** khung rơi |
| YouTube diagnosis | `*.googlevideo.com` | **403 Forbidden** — không phải vấn đề GPU |

Đọc bảng này phải nhớ: benchmark GPU A/B chỉ đo **chuyển động trang dock cục bộ** (rẻ), không đo phát
video và không đo trang nặng; còn PERF-01 đo cuộn trên Google Tin tức và bảng bốn nhánh ở §0 đo đúng
điều kiện đó. Vì vậy kết luận "auto và on không khác nhau" của bài đo trước **đúng trong phạm vi của nó
nhưng không dùng được để kết luận về trang thật** — bảng §0 cho thấy chênh 2.5×.

**Một kết luận đo cũ đã sai và cần bỏ qua:** ghi chép trước đây viết *"Giải mã video VA-API vẫn bật
(`VaapiVideoDecoder` có trong cmdline…)"*. `VaapiVideoDecoder` là **tên feature đã bị xoá** khỏi
Chromium; sự có mặt của nó trên dòng lệnh **không** chứng minh có giải mã phần cứng — Chromium bỏ qua
tên lạ trong im lặng. Xem §3.

**Chưa đo được** trên máy QA trong lần rà này (không có phiên SSH), nên không có kết luận nào về việc
bật VA-API cải thiện bao nhiêu fps. Con số phải đến từ `section_decode` sau khi làm bước 1–4.
