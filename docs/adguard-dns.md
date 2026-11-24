# Chặn quảng cáo bằng DNS (AdGuard Home)

```bash
export NTF_SUDO_PASS='<mật-khẩu>'
./scripts/install-adguard.sh            # chỉ báo cáo
./scripts/install-adguard.sh --apply    # tải, cài, chuyển DNS sang AdGuard
./scripts/install-adguard.sh --remove   # gỡ, trả DNS về như cũ

./scripts/install-adguard-status.sh --apply   # timer đẩy số liệu cho giao diện
./scripts/install-adguard-status.sh --remove
```

Chọn AdGuard Home thay vì Pi-hole vì: tarball chính thức (không cần Docker, không cần cài
`lighttpd`/`php`), nhị phân tĩnh chạy thẳng bằng systemd, có REST `/control/stats` sạch để giao diện
đọc, và có sẵn thống kê theo **từng client** — đúng thứ cần cho thiết bị treo tường.

**Bố cục trên máy:**

| Đường dẫn | Nội dung | Quyền |
| :-- | :-- | :-- |
| `/opt/AdGuardHome/AdGuardHome` | nhị phân | `root:root 0755` |
| `/var/lib/AdGuardHome/` | `AdGuardHome.yaml`, `data/stats.db` | `adguard:adguard 0700` |
| `/root/ntf-adguard-admin.txt` | tài khoản admin | `root:root 0600` |
| `/var/lib/ntf/adblock-status.json` | số liệu cho giao diện | `root:root 0644` |

AdGuard từ chối chạy bằng root sau lần khởi động đầu, nên installer tạo user hệ thống `adguard`
(`/usr/sbin/nologin`). Đây là ngoại lệ có chủ ý với luật "không tạo user mới".

**Vì sao `/etc/resolv.conf` là tệp thật, không phải drop-in của `systemd-resolved`:** drop-in toàn
cục `DNS=… Domains=~.` bị cắt danh sách về **một** nameserver, nên mất khả năng dự phòng. Tệp
`/etc/resolv.conf` tĩnh với hai dòng `nameserver` cho failover thật: `getent hosts` trả trong **56
ms** kể cả khi AdGuard chết, rơi sang `8.8.8.8`. Máy không có `libnss_resolve.so.2` và `nsswitch`
là `hosts: files dns`, nên `/etc/resolv.conf` thực sự quyết định việc phân giải.

> **Luật: không bao giờ `cp` lên `/etc/resolv.conf`.** Nó là symlink vào `/run`; `cp` đi theo
> symlink và ghi đè `stub-resolv.conf`. Luôn `rm` rồi `ln -s`. Nếu đã lỡ: `systemctl restart
> systemd-resolved` sinh lại tệp.

**Lấy mật khẩu admin** (không in ra log, không đưa vào mã):

```bash
sudo sed -n 's/^password: //p' /root/ntf-adguard-admin.txt
```

Giao diện quản trị: `http://192.168.1.100:3000` — URL này cũng hiện ở cuối khối "Chặn quảng cáo"
trong panel Cài đặt. Loopback **đóng** (`http.address` gắn vào IP LAN), nên `curl 127.0.0.1:3000`
trả `000`; mọi thứ phải trỏ IP LAN.

**Giao diện chỉ đọc, có chủ ý.** Renderer hiển thị trang web tuỳ ý; nếu nó giữ mật khẩu admin thì
một trang bị lỗi có thể viết lại toàn bộ luật DNS của nhà. Vì vậy: timer root đọc API rồi công bố
số liệu ra JSON, renderer chỉ đọc tệp. Hệ quả: không có công tắc bật/tắt trong panel, và việc xem
chi tiết từng truy vấn nằm ở giao diện web AdGuard.

**Chặn ở mức DNS không chặn được quảng cáo trong luồng video YouTube** — quảng cáo và nội dung
dùng chung `googlevideo.com`. Việc đó là của FreeTube.

**Định tuyến:** đặt DNS mà router phát qua DHCP thành `192.168.1.100`. Nếu router của ISP khoá mục
này, đặt DNS tĩnh cho từng thiết bị. Khi AdGuard chết, máy kiosk vẫn phân giải được nhờ
`8.8.8.8` dự phòng, nhưng khi đó **không còn chặn quảng cáo**.

## IPv6 (bắt buộc đọc nếu nhà có IPv6)

Máy này **có IPv6 thật**: `eno1` nhận địa chỉ toàn cầu `2001:db8:abcd:1234::/64` do router quảng
bá, và ping `2606:4700:4700::1111` chạy được. Nghĩa là router cũng phát **DNS IPv6** (qua RDNSS
trong bản tin RA — `resolvectl dns` cho thấy `2001:db8:isp::1` và `2001:db8:isp::2`).
Nếu để nguyên, mọi máy trong nhà sẽ hỏi DNS IPv6 đó và **đi vòng qua AdGuard**, mất chặn quảng cáo
dù IPv4 vẫn trỏ đúng.

Đo được ngày 2026-11-24 trên Windows: `Resolve-DnsName doubleclick.net` trả về 6 IP Google thật,
nhưng `Resolve-DnsName doubleclick.net -Server 192.168.1.100` trả `0.0.0.0`. Cùng một tên, hai
kết quả — vì Windows đang ưu tiên DNS IPv6.

**Cách xử lý (đã làm):** `scripts/install-adguard-ipv6.sh` cài timer 5 phút, đọc địa chỉ IPv6 toàn
cầu đang có trên card mạng rồi ghi vào `dns.bind_hosts` của AdGuard. Không bind cứng vì prefix
`2001:db8:...` do ISP cấp và **sẽ đổi**; bind cứng thì hôm đổi prefix AdGuard nghe một địa chỉ
không còn tồn tại, IPv6 hỏng âm thầm.

```bash
./scripts/install-adguard-ipv6.sh            # báo cáo
./scripts/install-adguard-ipv6.sh --apply    # cài timer + sửa ngay lần đầu
./scripts/install-adguard-ipv6.sh --remove
```

**Không dùng `"::"` trong `bind_hosts`.** Đã thử: bind `::` là dual-stack nên đụng ngay
`127.0.0.53:53` của `systemd-resolved` và `192.168.1.100:53` của chính AdGuard →
`listen tcp 0.0.0.0:53: bind: address already in use`, AdGuard chết lặp vô hạn. Phải liệt kê từng
địa chỉ cụ thể.

### Ba mục trên trang Local Network → DNS

Trang này có ba mục accordion. **Chỉ mục thứ ba liên quan chặn quảng cáo** — hai mục đầu để trống.

| Mục | Thực chất là gì | Setup |
| --- | --- | --- |
| **Domain Name** | Tên miền của chính router (WAN/DDNS), **không** phải DNS resolver | Bỏ trống |
| **Host Name** | Bảng tên→IP tĩnh trong LAN, tương đương `/etc/hosts` của router | Bỏ trống, trừ khi cần gọi máy trong nhà bằng tên |
| **DNS** | DNS server cấp cho máy khách qua DHCP/RDNSS | **Đặt ở đây** |

Mục `Host Name` hay bị nhầm nhất: nó **không** chặn quảng cáo, không ảnh hưởng phân giải tên ra
Internet, chỉ thêm bản ghi tên cho mạng nội bộ. Điền nhầm vào đó thì tốn công mà không có tác dụng.

**Phần router bạn phải tự làm** (script không đăng nhập được vào router):

Điền đúng như bảng này. Cột "ô 2" là chỗ hay bị điền sai nhất.

| Mục trên router | Ô 1 | Ô 2 |
| --- | --- | --- |
| **DNS IPv4** (DHCPv4) | `192.168.1.100` (kiosk) | `8.8.8.8` (Google dự phòng) |
| **DNS IPv6** (DHCPv6 / RDNSS) | **để trống** | **để trống** |

Ô 2 = `8.8.8.8` là lựa chọn **ưu tiên mạng luôn sống**: AdGuard chết thì nhà vẫn có mạng, đổi lại
**lặng lẽ mất chặn** trong lúc đó. Đo trên firmware này (router ISP): khi ô 1 sống, router **luôn** dùng
ô 1 — `40/40` truy vấn qua AdGuard, kể cả khi ô 2 là Google, nên không bị rò một nửa. Chỉ khi ô 1
chết hẳn mới chuyển sang ô 2.

Firmware (router ISP) **không cho lưu khi thiếu ô IPv4 nào** — phải điền đủ cả hai. Có hai cách, chọn
theo mục tiêu:

- **Ô 2 = `8.8.8.8`** — mạng luôn sống, nhưng AdGuard chết thì mất chặn âm thầm.
- **Ô 2 = `192.168.1.100`** — chặn tuyệt đối, nhưng AdGuard chết thì **cả nhà mất phân giải tên**.

Hai ô cùng trỏ một máy chủ vẫn chặn 100% — hỏi ô nào cũng vào AdGuard (đo: `192.168.1.100` hai lần
liên tiếp đều `0.0.0.0`).

Còn IPv6 thì **xoá trắng cả hai ô** (router ISP cho phép — chỉ IPv4 mới bắt buộc đủ). Hai giá trị dưới
đây là bẫy, hay gặp nhất vì firmware tự điền sẵn:

| Giá trị thấy trong ô | Là gì | Xử lý |
| --- | --- | --- |
| IPv4 ô 2 = `8.8.8.8` | DNS Google | **Giữ được** nếu chọn "mạng luôn sống"; xoá nếu chọn chặn tuyệt đối. Đo được: `142.250.198.46`, không chặn |
| IPv4 ô 2 = `1.1.1.1` | DNS Cloudflare | **Xoá.** Đo được: `142.250.198.174`, không chặn. Nếu muốn dự phòng thì dùng `8.8.8.8` cho dễ nhận biết |
| IPv6 ô 2 = `2001:4860:4860::8888` | DNS Google | **Xoá.** Đo được: `142.250.199.78`, không chặn |
| IPv6 ô 1 = `2001:4860:4860::8844` | DNS Google | **Xoá.** Như trên |
| IPv6 ô 1 = `2001:db8:...` | DNS của nhà mạng | **Xoá**, trừ khi đúng là GUA của kiosk |

**Phép đo, làm lại cho đúng đối tượng (2026-11-24).** Phép đo cũ hỏi `Resolve-DnsName` trống
`-Server`, tức là hỏi **máy Windows dev** — mà máy đó tự đặt DNS tay (`DHCPEnabled: False`,
`8.8.8.8, 1.1.1.1`), không nhận từ router. Kết quả cũ vì thế **không phản ánh router**. Hỏi thẳng
từng máy chủ mới đúng:

```bash
dig +short A doubleclick.net @192.168.1.100   # 0.0.0.0          -> AdGuard, chặn
dig +short A doubleclick.net @192.168.1.1     # 0.0.0.0          -> router, chặn
dig +short A doubleclick.net @8.8.8.8         # 142.250.198.46   -> Google, KHÔNG chặn
dig +short A doubleclick.net @1.1.1.1         # 142.250.198.174  -> Cloudflare, KHÔNG chặn
```

**Router không quay vòng hai ô.** Hỏi `192.168.1.1` ba mươi lần liên tiếp: **30 chặn / 0 rò**.
Hỏi qua IPv6 (`fe80::1%12`, cũng là router): **30 chặn / 0 rò**. Firmware dùng ô 1, chỉ chuyển sang
ô 2 khi ô 1 **chết hẳn**. Vì thế khi AdGuard còn sống thì ô 2 = `8.8.8.8` **không** làm rò — nhưng
vẫn phải xoá, vì lúc AdGuard chết thì cả nhà lặng lẽ rò sang Google mà không có triệu chứng gì.

Trên kiosk, `resolvectl dns eno1` từng trả `8.8.8.8 1.1.1.1 2001:db8:isp::1
2001:db8:isp::2` — **đây mới là rò thật**, vì máy khách nhận thẳng DNS của ISP/Google chứ
không qua router. Nghĩa là giá trị trong trang quản trị router và giá trị router thật sự phát ra
**không nhất thiết giống nhau**. Vì thế sau khi sửa phải đo bằng `resolvectl dns`, đừng tin trang
quản trị.

Ba lý do cho bảng trên, đều đã đo trên máy thật:

1. **DNS IPv4 trả lời được cả bản ghi IPv6.** `dig AAAA google.com @192.168.1.100` ra
   `2404:6800:4005:806::200e`, `cloudflare.com` ra `2606:4700::6810:85e5` — y như hỏi thẳng
   `8.8.8.8`. Máy khách vẫn dùng IPv6 cho dữ liệu bình thường. Họ địa chỉ (address family) của
   máy chủ DNS **không** quyết định họ địa chỉ trong câu trả lời. Vì thế bỏ hẳn DNS IPv6 **không
   mất gì**.
2. **Địa chỉ IPv6 của kiosk là `dynamic`.** `ip -6 addr` ghi rõ `2001:db8:abcd:1234::10
   scope global dynamic`. Prefix `2001:db8:abcd:1234::/64` do ISP cấp qua RA; khi ISP đổi prefix,
   địa chỉ điền trong router thành **chết** và cả nhà mất DNS IPv6 (trong khi IPv4 vẫn chạy nên
   triệu chứng rất khó đoán). Đừng điền nó.
3. **Không có địa chỉ IPv6 cố định nào để điền.** Máy không có ULA (`fd00::/8`) — đã kiểm, bằng 0.
   Địa chỉ link-local `fe80::200:5eff:fe00:5301` thì sinh từ MAC nên không đổi, nhưng AdGuard
   **không bind được**: đã thử thêm `"fe80::200:5eff:fe00:5301%eno1"` vào `bind_hosts`, AdGuard
   khởi động bình thường nhưng **không mở socket** (nó bỏ phần `%eno1`), `dig @fe80::...%eno1` trả
   `connection refused`. Đã khôi phục cấu hình cũ.

**Nếu firmware bắt buộc điền cả ô IPv6.** Đo trên kiosk ngày 2026-11-24: AdGuard **đã nghe sẵn
trên địa chỉ IPv6 toàn cầu** — `ss -lntuH` có cả `tcp` và `udp` ở
`[2001:db8:abcd:1234::10]:53`, và `dig +short A doubleclick.net @<GUA>` trả `0.0.0.0`
trong khi `dig +short A vnexpress.net @<GUA>` trả `111.65.250.2` (không chặn oan). Nên điền GUA của
kiosk vào ô IPv6 **là hợp lệ và có chặn thật**:

```bash
# Lấy GUA hiện tại để dán vào router
ip -6 addr show dev eno1 scope global | awk '/inet6/{print $2}'
ssh <kiosk-user>@192.168.1.100 'ip -6 addr show dev eno1 scope global' | awk '/inet6/{print $2}'
```

Nhưng đây là lựa chọn **kém hơn**: GUA là `dynamic`, ISP đổi prefix là ô đó chết. Timer
`ntf-adguard-ipv6` bám theo prefix mới nên AdGuard vẫn phục vụ đúng, còn **router thì không tự cập
nhật** — phải vào sửa tay. Vì vậy chỉ dùng cách này khi firmware thật sự không cho để trống.

**Kiểm tra sau khi `Apply`** — đừng tin trang quản trị, hãy đo từ một máy khách trong nhà:

```bash
resolvectl dns                      # phải KHÔNG còn DNS của ISP hay 8.8.8.8/2001:4860:... ở đây
dig +short A doubleclick.net        # phải ra 0.0.0.0
```

Nếu `resolvectl dns` vẫn hiện `2001:db8:isp:...` thì cấu hình chưa ăn — xem mục reboot bên dưới.

Nếu router không cho để trống ô DNS IPv6 và cũng không cho trỏ về máy trong nhà: **tắt phát DNS
IPv6 (RDNSS)**. Vẫn giữ IPv6 cho dữ liệu, chỉ bỏ DNS IPv6 — đây là cách ít rủi ro nhất.

**Về việc reboot router:** đổi DNS trong router chỉ áp dụng cho **lease mới**. Máy khách đang giữ
lease cũ vẫn hỏi DNS cũ cho tới khi hết hạn (thường 12–24 giờ). Ba cách, chọn một:

- Reboot router — chắc chắn nhất, áp dụng ngay cho mọi máy.
- Trên từng máy khách: tắt WiFi/bật lại, hoặc `ipconfig /release` + `/renew` (Windows),
  `sudo dhclient -r && sudo dhclient` (Linux), hoặc tắt/bật WiFi trên điện thoại.
- Chờ lease hết hạn — không cần làm gì, nhưng có thể tới mai mới sạch.

**Bẫy: router còn cache DNS cũ sau khi `Apply`.** Đo thật ngày 2026-11-24, ngay sau khi đổi
DNS IPv4 ô 1 sang kiosk và ô 2 sang Google: hỏi router `40/40` lần đều trả **IP Google thật**
(`142.250.71.174`) dù AdGuard vẫn chặn đúng (`0.0.0.0`). Tưởng như cấu hình không ăn. Nhưng hỏi
một tên **chưa từng tra** (`adtest<random>.doubleclick.net`) thì router trả `0.0.0.0` — chứng minh
cấu hình **đã đúng**, chỉ là những tên vừa tra trước đó còn nằm trong cache của router (đo được
`TTL=244s`). Chờ hết TTL rồi đo lại: **40/40 chặn, 0 rò**.

Vì thế khi kiểm tra, **đừng dùng tên vừa mới tra** — dùng tên ngẫu nhiên:

```bash
dig +short A "adtest$RANDOM.doubleclick.net" @192.168.1.1   # phải ra 0.0.0.0
```

Nếu tên ngẫu nhiên ra `0.0.0.0` mà tên quen vẫn ra IP thật thì chỉ là cache, chờ vài phút là hết.

**Cảnh báo khi ô 2 là `8.8.8.8`:** AdGuard chết thì cả nhà **vẫn có mạng nhưng mất chặn**, và
**không có triệu chứng nào báo** — quảng cáo quay lại âm thầm. Vì vậy cần biết cách phát hiện:
hỏi một tên ngẫu nhiên như `adtest$RANDOM.doubleclick.net`; ra `0.0.0.0` là AdGuard còn sống,
ra IP thật là đã rò sang ô 2.

- **Ưu tiên chặn tuyệt đối:** ô 2 cũng là `192.168.1.100`. Kiosk tắt là **cả nhà mất phân giải tên**.
- **Ưu tiên mạng luôn sống:** ô 2 là `8.8.8.8`. Kiosk tắt thì nhà vẫn có mạng, nhưng mất chặn.

Đây là đánh đổi có chủ ý, không phải lỗi cấu hình. Bản cài hiện tại chọn cách thứ hai.

Kiểm tra sau khi sửa router, từ một máy khác trong nhà:

```bash
dig +short A doubleclick.net @<IPv4 máy kiosk>     # phải ra 0.0.0.0
dig +short A doubleclick.net @<IPv6 máy kiosk>     # phải ra 0.0.0.0
```

Cả hai cùng ra `0.0.0.0` thì mới kín. Chỉ IPv4 ra `0.0.0.0` là còn đường vòng.

**Máy kiosk tự nó không bị rò:** `/etc/nsswitch.conf` là `hosts: files dns` và máy **không có**
`libnss_resolve.so.2`, nên `/etc/resolv.conf` (trỏ `192.168.1.100`) thật sự quyết định. Electron
cũng không bật DNS-over-HTTPS — chỉ `gpu-flags.ts` gọi `appendSwitch`, không có `DnsOverHttps`.

## Xem lịch sử truy cập (Query Log)

Có sẵn, **không cần bật gì thêm**. AdGuard Home mặc định `querylog.enabled: true`,
`file_enabled: true`, lưu **90 ngày** (`interval: 90d`) và giữ 1000 bản ghi trong RAM
(`size_memory: 1000`) trước khi ghi xuống `data/querylog.json`. Seed của dự án **không có khối
`querylog`**, nên bản cài hiện tại đang chạy đúng mặc định đó — không phải cấu hình thiếu.

Đối chiếu với mã nguồn `internal/home/config.go` của AdGuard (hàm dựng cấu hình mặc định):

```go
QueryLog: configmgr.QueryLogConfig{
    DirPath:     "",
    Ignored:     []string{},
    Interval:    timeutil.Duration(90 * timeutil.Day),
    MemSize:     1000,
    Enabled:     true,
    FileEnabled: true,
},
```

### Xem ở đâu

| Cách | Đường dẫn | Dùng khi |
| :-- | :-- | :-- |
| Giao diện web | `http://192.168.1.100:3000` → **Query Log** | xem nhanh, lọc bằng ô tìm kiếm |
| Lọc theo máy | tab **Clients** → chọn IP | biết thiết bị nào hỏi gì |
| API | `GET /control/querylog?limit=200` | script, xuất dữ liệu |

Cần mật khẩu admin. Lấy bằng
`sudo sed -n 's/^password: //p' /root/ntf-adguard-admin.txt` — **không** in ra log.

API trả **NDJSON** (mỗi dòng một JSON), có Basic Auth. Hỏi bằng `curl` trên kiosk:

```bash
sudo bash -c 'PW=$(sed -n "s/^password: //p" /root/ntf-adguard-admin.txt); \
  curl -fsS -u "admin:$PW" "http://192.168.1.100:3000/control/querylog?limit=50"'
```

Tham số lọc: `limit`, `offset`, `search` (khớp tên miền), `response_status`
(`all`/`blocked`/`allowed`/`rewritten`), `older_than`.

### Thấy được gì

- **Tên miền** máy khách hỏi — `facebook.com`, `shopee.vn`, `googlevideo.com`…
- **Thời điểm** từng truy vấn.
- **Máy nào hỏi** — IP trong LAN (kiosk là `192.168.1.100`).
- **Bị chặn hay cho qua**, và **bởi luật/bộ lọc nào**.
- **Loại bản ghi** — `A`, `AAAA`, `HTTPS`, `PTR`…

### **Không** thấy được — giới hạn của DNS, không phải của AdGuard

- **Đường dẫn cụ thể.** Chỉ có `facebook.com`, **không** có `/messages/123`.
- **Nội dung trang, ảnh, video, tệp tải về.** DNS chỉ đổi tên thành địa chỉ, không chở dữ liệu.
- **Dữ liệu gửi lên** (mẫu đăng nhập, tin nhắn).
- **Bên trong HTTPS.** Tên miền lộ vì phải hỏi DNS *trước* khi bắt tay TLS; sau đó mọi thứ mã hoá.
- **Truy vấn đi qua DoH/DoT.** Chrome và Firefox có thể tự bật DNS-over-HTTPS ⇒ hỏi thẳng
  Cloudflare/Google, **không qua AdGuard**, nên vừa không thấy vừa **không chặn được**. Trong
  dự án này Electron không bật DoH (đã kiểm `gpu-flags.ts`), nhưng Firefox ngoài thì có thể —
  kiểm bằng `about:config` → `network.trr.mode` phải là `0` hoặc `5`.

Muốn thấy nội dung thật phải có **DPI** hoặc proxy chặn giữa (MITM) — kèm chứng chỉ giả lập trên
từng thiết bị. Không nên làm cho mạng gia đình.

### Muốn giữ lịch sử lâu hơn hoặc ngắn hơn

Sửa `querylog.interval` trong `/var/lib/AdGuardHome/AdGuardHome.yaml` (1h → 8760h), rồi
`sudo systemctl restart AdGuardHome`. Đặt `enabled: false` để tắt hẳn.

Để **không ghi** một số tên miền (ngân hàng, sức khoẻ): thêm vào `querylog.ignored` theo cú pháp
luật AdBlock và bật `ignored_enabled: true`.

### Cảnh báo riêng tư

Query log là **toàn bộ lịch sử duyệt web của mọi thiết bị trong nhà**, lưu 90 ngày, dạng đọc
được. Ai vào được dashboard là đọc được. Vì thế: mật khẩu admin nằm ở `/root/ntf-adguard-admin.txt`
(`0600`), **không** đưa vào panel Cài đặt của kiosk — panel chỉ đọc JSON
`/var/lib/ntf/adblock-status.json` do timer root ghi, nên một trang web lỗi trong renderer không
thể lấy được log hay sửa luật DNS.

Nếu mục đích là **quản lý** chứ không phải **xem lại**, dùng hai tính năng sẵn có thay vì đọc log:

- **Clients → Access Settings**: chặn/thả theo từng thiết bị, đặt lịch giờ được dùng mạng.
- **Filters → Parental Control**: chặn nội dung người lớn, an toàn tìm kiếm. Bật ở đây tác động
  ngay, không cần đọc log của ai.

