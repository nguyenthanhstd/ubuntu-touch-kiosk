#!/usr/bin/env bash
# ntf-adguard-ipv6.sh — giữ cho AdGuard Home nghe được DNS trên IPv6.
#
#   ntf-adguard-ipv6.sh [--check]
#
# Vì sao cần: AdGuard chỉ nghe đúng danh sách `dns.bind_hosts`. Máy này nhận IPv6
# toàn cầu từ router theo prefix ISP cấp (`2001:db8:...`), và prefix đó ĐỔI khi nhà
# mạng cấp lại. Nếu bind cứng một địa chỉ cũ thì IPv6 hỏng âm thầm: máy khách vẫn
# gửi truy vấn tới địa chỉ cũ, không ai trả lời, rồi tự rơi xuống DNS IPv4 — tức là
# vẫn vào mạng được nhưng KHÔNG còn chặn quảng cáo. Script này đọc địa chỉ IPv6
# đang thật sự có trên card mạng và ghi lại vào bind_hosts khi nó thay đổi.
#
# Không dùng `::` được: bind `::` là dual-stack, đụng ngay 127.0.0.53:53 của
# systemd-resolved và <LAN_IP>:53 của chính AdGuard → "address already in use".
# Đo được ngày 2026-11-24 trên labwc/Ubuntu 26.04.
set -uo pipefail

CFG=/var/lib/AdGuardHome/AdGuardHome.yaml
SVC=AdGuardHome
LAN_IP=${NTF_LAN_IP:-$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')}
CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

log() { echo "[$(date '+%F %T')] $*"; }

# Card mạng đi ra Internet, không đoán theo tên.
IFACE=$(ip -4 route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')
[ -n "$IFACE" ] || { log "không tìm được card mạng mặc định"; exit 1; }

# Chỉ lấy địa chỉ toàn cầu đang dùng được: bỏ link-local (fe80::), bỏ địa chỉ
# `deprecated` (đang bị thu hồi sau khi đổi prefix) và bỏ `temporary` (đổi liên tục).
mapfile -t V6 < <(ip -6 addr show dev "$IFACE" scope global 2>/dev/null |
  awk '/inet6/ && !/deprecated/ && !/temporary/ {print $2}' | cut -d/ -f1 | sort -u)

if [ "${#V6[@]}" -eq 0 ]; then
  log "card $IFACE không có IPv6 toàn cầu — không có gì để đồng bộ"
  exit 0
fi
log "card $IFACE, IPv6: ${V6[*]}"

command -v python3 >/dev/null || { log "thiếu python3"; exit 1; }

# Soạn danh sách mong muốn rồi ghi đè khối bind_hosts. Dùng python chứ không sed
# vì khối này nằm giữa YAML nhiều tầng thụt lề.
RESULT=$(python3 - "$CFG" "$LAN_IP" "${V6[@]}" <<'PY'
import sys
cfg, lan = sys.argv[1], sys.argv[2]
addrs = sys.argv[3:]
src = open(cfg, encoding="utf-8").read()
lines = src.split("\n")
try:
    start = next(i for i, l in enumerate(lines) if l.strip() == "bind_hosts:")
except StopIteration:
    print("ERR không thấy bind_hosts trong cấu hình"); sys.exit(0)
end = start + 1
while end < len(lines) and lines[end].startswith("    - "):
    end += 1
cur = [l.strip()[2:].strip('"') for l in lines[start + 1:end]]
# Thứ tự cố định: IPv4 LAN trước (resolv.conf trỏ vào đây), rồi loopback IPv6, rồi
# các địa chỉ toàn cầu. `::1` để tiến trình trên chính máy kiosk hỏi được.
want = [lan, "::1"] + list(addrs)
if cur == want:
    print("SAME"); sys.exit(0)
lines[start + 1:end] = ['    - "' + a + '"' for a in want]
open(cfg, "w", encoding="utf-8").write("\n".join(lines))
print("CHANGED " + ",".join(cur) + " -> " + ",".join(want))
PY
)
echo "  $RESULT"
case "$RESULT" in
  SAME) [ "$CHECK" -eq 1 ] && log "đã khớp, không cần làm gì"; exit 0 ;;
  CHANGED*) ;;
  *) log "không sửa được cấu hình"; exit 1 ;;
esac
[ "$CHECK" -eq 1 ] && { log "chế độ --check: đã ghi cấu hình nhưng KHÔNG khởi động lại"; exit 0; }

# AdGuard ghi ngược cấu hình của chính nó nên quyền phải đúng, nếu không nó chết
# với "permission denied" và lặp lại mãi.
chown adguard:adguard "$CFG" && chmod 600 "$CFG" || { log "không đặt được quyền cho $CFG"; exit 1; }

BK=$(mktemp) && cp -f "$CFG" "$BK" || exit 1
systemctl restart "$SVC" || { log "restart thất bại"; exit 1; }

# Chờ cổng 53 thật sự trả lời trên IPv6 mới. Không chờ thì lần chạy sau sẽ thấy
# cấu hình "đã đúng" trong khi dịch vụ còn đang khởi động.
ok=0
for _ in $(seq 1 20); do
  if [ -n "$(getent ahostsv6 localhost 2>/dev/null)" ] &&
     dig +time=1 +tries=1 +short A example.com @::1 >/dev/null 2>&1; then
    ok=1; break
  fi
  sleep 1
done
if [ "$ok" -ne 1 ]; then
  log "AdGuard không trả lời trên ::1 sau 20 giây — trả cấu hình cũ về"
  cp -f "$BK" "$CFG"; chown adguard:adguard "$CFG"; chmod 600 "$CFG"
  systemctl restart "$SVC"
  rm -f "$BK"; exit 1
fi
rm -f "$BK"
log "xong: AdGuard nghe IPv6 ${V6[*]}"
# In ra để nhật ký của timer có bằng chứng, không chỉ một dòng "thành công".
ss -lntuH 2>/dev/null | awk '{print $5}' | grep -E '^\[.*\]:53$' | sort -u | sed 's/^/  socket /'
