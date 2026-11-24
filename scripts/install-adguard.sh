#!/usr/bin/env bash
# install-adguard.sh — dựng AdGuard Home làm DNS chặn quảng cáo cho cả nhà.
#
#   ./scripts/install-adguard.sh            # chỉ báo cáo hiện trạng, không ghi gì
#   ./scripts/install-adguard.sh --apply    # cài đặt (cần sudo)
#   ./scripts/install-adguard.sh --remove   # gỡ, trả DNS về như cũ
#
# Kiến trúc (đã đo trên máy thật trước khi viết):
#   1. AdGuard chỉ nghe trên IP LAN :53; systemd-resolved giữ 127.0.0.53/.54. Không đụng
#      DNSStubListener, không sửa netplan. Nhờ vậy máy khác trỏ thẳng vào IP kiosk và
#      AdGuard thấy đúng IP từng máy — điều kiện để xem "máy nào truy cập gì".
#   2. Chạy bằng user `adguard` không đặc quyền, chỉ thêm AmbientCapabilities=
#      CAP_NET_BIND_SERVICE (đã kiểm chứng bind được cổng 53 theo cách này).
#   3. /etc/resolv.conf thành tệp tĩnh trỏ kiosk, kèm 8.8.8.8 dự phòng: đo được sang
#      dự phòng trong 56 ms, nên AdGuard hỏng không làm mất DNS của máy.
#   4. nsswitch là `files dns` và máy KHÔNG có libnss_resolve, nên tệp tĩnh có hiệu lực
#      (nếu có nss-resolve thì nó đi vòng qua resolv.conf).
set -uo pipefail

APPLY=0
REMOVE=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --remove) REMOVE=1 ;;
    -h | --help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      echo "tham số lạ: $arg" >&2
      exit 2
      ;;
  esac
done

AGH_DIR=/opt/AdGuardHome
AGH_BIN=$AGH_DIR/AdGuardHome
# Cấu hình và dữ liệu tách khỏi thư mục chứa binary: AdGuard ghi lại YAML sau mỗi thay đổi,
# nên tệp cấu hình phải nằm trong thư mục user `adguard` ghi được. Để chung /opt thì hoặc
# phải cho adguard quyền ghi đè chính binary, hoặc AdGuard chết vì "permission denied".
AGH_DATA=/var/lib/AdGuardHome
AGH_CFG=$AGH_DATA/AdGuardHome.yaml
AGH_USER=adguard
UNIT=/etc/systemd/system/AdGuardHome.service
RELEASE=https://static.adtidy.org/adguardhome/release
PASS_FILE=/root/ntf-adguard-admin.txt
RESOLV=/etc/resolv.conf
RESOLV_BAK=/etc/resolv.conf.ntf-backup
RESOLV_TARGET_BAK=/etc/resolv.conf.ntf-target
LOCK_HOST=${NTF_LAN_IP:-$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')}
FALLBACK_DNS=${NTF_FALLBACK_DNS:-8.8.8.8}
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
SEED="$SCRIPT_DIR/adguard-seed.yaml"

run_sudo() {
  if [ -n "${NTF_SUDO_PASS:-}" ]; then
    printf '%s\n' "$NTF_SUDO_PASS" | sudo -S -p '' "$@"
  else
    sudo -n "$@"
  fi
}

if [ "$((APPLY + REMOVE))" -gt 0 ] && [ "$(id -u)" -ne 0 ] && ! run_sudo true 2>/dev/null; then
  echo "cần sudo (hoặc đặt NTF_SUDO_PASS) — SSH không có terminal nên sudo không hỏi được" >&2
  exit 1
fi

port53_listen() { ss -lntuH 2>/dev/null | awk '{print $5}' | grep -cE "(^|\[)$1:53(%[a-z0-9]+)?$"; }
port53_busy() { [ "$(port53_listen "$1")" -gt 0 ]; }

echo "=== Hiện trạng ==="
echo "  đã cài:        $([ -x "$AGH_BIN" ] && echo "CÓ ($("$AGH_BIN" --version 2>/dev/null | tail -1))" || echo 'chưa')"
echo "  dịch vụ:       $(systemctl is-enabled AdGuardHome 2>/dev/null || echo 'chưa') / $(systemctl is-active AdGuardHome 2>/dev/null || echo 'không chạy')"
echo "  user:          $(id -un "$AGH_USER" 2>/dev/null || echo 'chưa có')"
echo "  cổng 53 LAN:   $(port53_listen "$LOCK_HOST") listener trên $LOCK_HOST"
echo "  /etc/resolv.conf: $(head -1 "$RESOLV" 2>/dev/null)"
echo "  bản sao lưu:   $([ -f "$RESOLV_BAK" ] || [ -f "$RESOLV_TARGET_BAK" ] && echo CÓ || echo 'chưa')"
if [ -f "$RESOLV" ] && ! [ -L "$RESOLV" ] && grep -q "^# ntf-adguard" "$RESOLV" 2>/dev/null; then
  echo "  CẢNH BÁO: $RESOLV do script này tạo nhưng không có bản ghi khôi phục —"
  echo "  trả về mặc định: sudo rm -f $RESOLV && sudo ln -s /run/systemd/resolve/stub-resolv.conf $RESOLV"
fi

if [ "$REMOVE" -eq 1 ]; then
  echo
  echo "=== Gỡ đặt ==="
  run_sudo systemctl disable --now AdGuardHome 2>/dev/null
  if [ -f "$RESOLV_TARGET_BAK" ]; then
    # Bản cũ là symlink: khôi phục bằng cách tạo lại đường dẫn, không ghi đè tệp đích.
    run_sudo rm -f "$RESOLV"
    run_sudo ln -s "$(cat "$RESOLV_TARGET_BAK")" "$RESOLV"
    run_sudo rm -f "$RESOLV_TARGET_BAK"
    run_sudo systemctl restart systemd-resolved 2>/dev/null
    echo "  đã trả $RESOLV về symlink cũ"
  elif [ -f "$RESOLV_BAK" ] && ! grep -q "^# ntf-adguard" "$RESOLV_BAK" 2>/dev/null; then
    run_sudo rm -f "$RESOLV"
    run_sudo cp "$RESOLV_BAK" "$RESOLV"
    run_sudo rm -f "$RESOLV_BAK"
    echo "  đã trả $RESOLV về tệp cũ"
  else
    run_sudo rm -f "$RESOLV" "$RESOLV_BAK"
    run_sudo ln -s /run/systemd/resolve/stub-resolv.conf "$RESOLV"
    run_sudo systemctl restart systemd-resolved 2>/dev/null
    echo "  đã trả $RESOLV về symlink mặc định của Ubuntu"
  fi
  run_sudo rm -f "$UNIT"
  run_sudo systemctl daemon-reload
  run_sudo systemctl reload systemd-resolved 2>/dev/null
  echo "  giữ nguyên $AGH_DATA (thống kê + bộ lọc tự thêm) và $PASS_FILE"
  echo "  muốn xoá hẳn: sudo rm -rf $AGH_DATA $AGH_DIR $PASS_FILE"
  exit 0
fi

if [ "$APPLY" -eq 0 ]; then
  echo
  echo "Chưa thay đổi gì. Chạy lại với --apply để cài."
  exit 0
fi

echo
echo "=== 1. Tải và kiểm tra chữ ký tệp ==="
case "$(uname -m)" in
  x86_64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *)
    echo "kiến trúc chưa hỗ trợ: $(uname -m)" >&2
    exit 1
    ;;
esac
TB=$(mktemp -d)
trap 'run_sudo rm -rf "$TB" 2>/dev/null || rm -rf "$TB" 2>/dev/null' EXIT
PKG=AdGuardHome_linux_${ARCH}.tar.gz
mkdir -p "$TB/dl"
for f in "$PKG" checksums.txt; do
  curl -fsSL --retry 3 -o "$TB/dl/$f" "$RELEASE/$f" || { echo "tải $f thất bại" >&2; exit 1; }
done
WANT=$(awk -v f="$PKG" '{n=$2; sub(/^\.\//,"",n)} n==f {print $1}' "$TB/dl/checksums.txt" | head -1)
GOT=$(sha256sum "$TB/dl/$PKG" | cut -d' ' -f1)
echo "  $PKG $(stat -c%s "$TB/dl/$PKG") byte"
echo "  sha256 $GOT"
if [ -z "$WANT" ] || [ "$WANT" != "$GOT" ]; then
  echo "  SHA256 KHÔNG KHỚP (mong đợi '${WANT}') — dừng, không cài tệp không xác thực" >&2
  exit 1
fi
echo "  khớp checksums.txt"

echo
echo "=== 2. Giải nén vào $AGH_DIR ==="
tar -xzf "$TB/dl/$PKG" -C "$TB"
run_sudo mkdir -p "$AGH_DIR"
# Giữ AdGuardHome.yaml và data/ nếu đã có: đó là toàn bộ bộ lọc và thống kê người dùng đã tích.
run_sudo cp -f "$TB/AdGuardHome/AdGuardHome" "$AGH_DIR/AdGuardHome.new"
run_sudo chmod 0755 "$AGH_DIR/AdGuardHome.new"
run_sudo mv -f "$AGH_DIR/AdGuardHome.new" "$AGH_BIN"
echo "  $AGH_BIN"

echo
echo "=== 3. User hệ thống không đặc quyền ==="
if ! id -un "$AGH_USER" >/dev/null 2>&1; then
  run_sudo useradd --system --no-create-home --home-dir "$AGH_DATA" \
    --shell /usr/sbin/nologin "$AGH_USER" || exit 1
  echo "  đã tạo $AGH_USER"
else
  echo "  $AGH_USER đã có"
fi
run_sudo mkdir -p "$AGH_DATA"
run_sudo chown "$AGH_USER:$AGH_USER" "$AGH_DATA"
run_sudo chmod 0700 "$AGH_DATA"
echo "  $AGH_DATA thuộc $AGH_USER"

echo
echo "=== 4. Cấu hình ==="
if [ -f "$AGH_CFG" ]; then
  echo "  giữ nguyên $AGH_CFG đang có (không ghi đè bộ lọc đã thêm)"
else
  if ! python3 -c 'import bcrypt' 2>/dev/null; then
    echo "  cần python3-bcrypt (sudo apt install -y python3-bcrypt)" >&2
    exit 1
  fi
  PW=${NTF_AGH_PASSWORD:-$(python3 -c 'import secrets,string;a=string.ascii_letters+string.digits;print("".join(secrets.choice(a) for _ in range(20)))')}
  HASH=$(NTF_PW="$PW" python3 -c 'import bcrypt,os;print(bcrypt.hashpw(os.environ["NTF_PW"].encode(),bcrypt.gensalt(rounds=10)).decode())') || exit 1
  sed -e "s|@@PASSWORD_HASH@@|$HASH|" -e "s|@@BIND_HOST@@|$LOCK_HOST|" "$SEED" >"$TB/AdGuardHome.yaml" || exit 1
  # --check-config bắt buộc chạy bằng root, nếu không nó từ chối khởi động.
  if ! run_sudo "$AGH_BIN" -c "$TB/AdGuardHome.yaml" -w "$TB" --check-config --no-check-update 2>&1 |
    grep -q 'configuration file is ok'; then
    echo "  cấu hình không hợp lệ — dừng" >&2
    exit 1
  fi
  run_sudo cp -f "$TB/AdGuardHome.yaml" "$AGH_CFG"
  run_sudo chown "$AGH_USER:$AGH_USER" "$AGH_CFG"
  run_sudo chmod 0600 "$AGH_CFG"
  # Mật khẩu chỉ ghi ra tệp root đọc được, không in ra log SSH.
  (umask 077 && printf 'AdGuard Home — http://%s:3000\nuser: admin\npassword: %s\n' "$LOCK_HOST" "$PW" >"$TB/pw.txt")
  run_sudo install -o root -g root -m 0600 "$TB/pw.txt" "$PASS_FILE"
  echo "  đã tạo $AGH_CFG; mật khẩu admin ở $PASS_FILE (không in ra log)"
fi
run_sudo chown root:root "$AGH_BIN"
run_sudo chmod 0755 "$AGH_DIR"

echo "=== 5. Dịch vụ ==="
cat >"$TB/AdGuardHome.service" <<EOF
[Unit]
Description=AdGuard Home - DNS chan quang cao
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$AGH_USER
Group=$AGH_USER
WorkingDirectory=$AGH_DATA
ExecStart=$AGH_BIN -w $AGH_DATA -c $AGH_CFG --no-check-update
# Chỉ thư mục dữ liệu ghi được; /opt chỉ đọc, nên binary không thể bị ghi đè.
ReadWritePaths=$AGH_DATA
PrivateTmp=yes
# Cổng 53 thuộc diện đặc quyền. Chỉ mở đúng khả năng này thay vì chạy cả tiến trình bằng root.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
Restart=on-failure
RestartSec=5s
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
run_sudo install -o root -g root -m 0644 "$TB/AdGuardHome.service" "$UNIT"
run_sudo systemctl daemon-reload
run_sudo systemctl enable AdGuardHome >/dev/null 2>&1

echo
echo "=== 6. Chuyển DNS của máy sang AdGuard ==="
if port53_busy "$LOCK_HOST"; then
  echo "  cổng 53 trên $LOCK_HOST còn bận — dừng trước khi đổi resolv.conf" >&2
  exit 1
fi
run_sudo systemctl restart AdGuardHome || exit 1
ok=0
for _ in $(seq 1 20); do
  if dig +short +time=2 +tries=1 @"$LOCK_HOST" example.com 2>/dev/null | grep -qE '^[0-9]+\.[0-9]+\.'; then
    ok=1
    break
  fi
  sleep 1
done
if [ "$ok" -ne 1 ]; then
  echo "  AdGuard không trả lời trên $LOCK_HOST:53 — KHÔNG đổi resolv.conf, DNS giữ nguyên" >&2
  journalctl -u AdGuardHome -n 20 --no-pager >&2
  exit 1
fi
echo "  AdGuard trả lời trên $LOCK_HOST:53"

if [ ! -f "$RESOLV_BAK" ] && [ ! -f "$RESOLV_TARGET_BAK" ]; then
  if [ -L "$RESOLV" ]; then
    # Ghi lại đích của symlink. Không dùng `cp -L`: nó ghi đè tệp đích trong /run,
    # đúng lỗi đã làm hỏng stub-resolv.conf một lần khi thử nghiệm.
    readlink "$RESOLV" >"$TB/target" || exit 1
    run_sudo install -o root -g root -m 0644 "$TB/target" "$RESOLV_TARGET_BAK" || exit 1
    echo "  đã ghi nhớ symlink $RESOLV -> $(cat "$TB/target")"
  elif ! grep -q "^# ntf-adguard" "$RESOLV" 2>/dev/null; then
    run_sudo cp "$RESOLV" "$RESOLV_BAK" || exit 1
    echo "  đã sao lưu $RESOLV -> $RESOLV_BAK"
  else
    echo "  KHÔNG ghi đè bản sao lưu bằng chính tệp ta đã tạo" >&2
  fi
fi
run_sudo rm -f "$RESOLV"
{
  echo "# ntf-adguard — tệp do scripts/install-adguard.sh tạo."
  echo "# DNS nội bộ trỏ AdGuard Home; bản ghi thứ hai là dự phòng khi AdGuard chết."
  printf 'nameserver %s\nnameserver %s\noptions timeout:1 attempts:2 edns0 trust-ad\n' \
    "$LOCK_HOST" "$FALLBACK_DNS"
} >"$TB/resolv.conf"
run_sudo install -o root -g root -m 0644 "$TB/resolv.conf" "$RESOLV"
echo "  $RESOLV -> $LOCK_HOST (dự phòng $FALLBACK_DNS)"

echo
echo "=== Kiểm tra ==="
echo "  dịch vụ:     $(systemctl is-enabled AdGuardHome) / $(systemctl is-active AdGuardHome)"
echo "  cổng 53:     $(ss -lntuH 2>/dev/null | awk '{print $5}' | grep ':53' | tr '\n' ' ')"
# Bộ lọc tải lần đầu mất vài giây tới vài chục giây. Chờ thay vì báo nhầm "chưa chặn".
for _ in $(seq 1 30); do
  ls "$AGH_DATA/data/filters/"*.txt >/dev/null 2>&1 && break
  sleep 2
done
blocked=$(dig +short +time=3 @"$LOCK_HOST" doubleclick.net 2>/dev/null | head -1)
if [ "$blocked" = "0.0.0.0" ]; then
  echo "  chặn thử:    doubleclick.net -> 0.0.0.0 (bộ lọc đã nạp)"
else
  echo "  chặn thử:    doubleclick.net -> ${blocked:-không trả lời} (bộ lọc có thể đang tải;"
  echo "               xem tiến độ: curl -s http://127.0.0.1:3000/control/stats)"
fi
echo "  cho qua:     vnexpress.net -> $(dig +short +time=3 @"$LOCK_HOST" vnexpress.net 2>/dev/null | grep -E '^[0-9]+\.' | head -1)"
echo "  máy này:     $(getent hosts example.com | head -1)"
echo
echo "  Bảng điều khiển: http://$LOCK_HOST:3000 (trong LAN). Tài khoản admin,"
echo "  mật khẩu ở $PASS_FILE trên máy kiosk (không in ra log)."
echo
echo "  Bước tiếp theo (làm trên router): DHCP -> DNS server = $LOCK_HOST"
