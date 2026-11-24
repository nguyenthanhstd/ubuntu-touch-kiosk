#!/usr/bin/env bash
# install-adguard-ipv6.sh — cài timer giữ AdGuard nghe đúng IPv6 hiện có.
#
#   ./scripts/install-adguard-ipv6.sh            # báo cáo
#   ./scripts/install-adguard-ipv6.sh --apply    # cài timer (cần sudo)
#   ./scripts/install-adguard-ipv6.sh --remove   # gỡ timer
#
# Tách khỏi install-adguard.sh vì hai tệp làm hai việc: một tệp dựng DNS, một tệp
# bám theo địa chỉ IPv6 do router cấp. Gỡ tệp này KHÔNG làm mất chặn quảng cáo qua
# IPv4 — chỉ là AdGuard ngừng cập nhật khi prefix IPv6 đổi.
set -uo pipefail

APPLY=0
REMOVE=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --remove) REMOVE=1 ;;
    *) echo "tham số lạ: $arg" >&2; exit 2 ;;
  esac
done

SRC=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/ntf-adguard-ipv6.sh
BIN=/usr/local/sbin/ntf-adguard-ipv6
UNIT=/etc/systemd/system/ntf-adguard-ipv6.service
TIMER=/etc/systemd/system/ntf-adguard-ipv6.timer
EVERY=${NTF_IPV6_EVERY:-300}

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

echo "=== Hiện trạng ==="
echo "  script: $([ -x "$BIN" ] && echo CÓ || echo 'chưa')"
echo "  timer:  $(systemctl is-enabled ntf-adguard-ipv6.timer 2>/dev/null || echo 'chưa') / $(systemctl is-active ntf-adguard-ipv6.timer 2>/dev/null || echo 'không chạy')"
echo "  IPv6 mà AdGuard đang nghe:"
ss -lntuH 2>/dev/null | awk '{print $5}' | grep -E '^\[.*\]:53$' | sort -u | sed 's/^/    /' || echo "    (không có)"

if [ "$REMOVE" -eq 1 ]; then
  echo
  run_sudo systemctl disable --now ntf-adguard-ipv6.timer 2>/dev/null
  run_sudo rm -f "$UNIT" "$TIMER" "$BIN"
  run_sudo systemctl daemon-reload
  echo "  đã gỡ timer (cấu hình AdGuard giữ nguyên)"
  exit 0
fi

if [ "$APPLY" -eq 0 ]; then
  echo
  echo "Chưa thay đổi gì. Chạy lại với --apply để cài."
  exit 0
fi

echo
echo "=== 1. Cài script ==="
# Copy chứ không symlink: root không được chạy tệp mà tài khoản kiosk ghi được.
run_sudo install -o root -g root -m 0755 "$SRC" "$BIN" || exit 1
echo "  $BIN"

echo "=== 2. Chạy thử một lần ==="
# Chạy ngay để lần cài này tự sửa luôn địa chỉ nếu prefix đã đổi, không phải chờ
# 5 phút. Có thể mất ~10 giây vì script phải khởi động lại AdGuard.
run_sudo "$BIN" || { echo "  lần chạy đầu thất bại — dừng, không cài timer" >&2; exit 1; }

echo "=== 3. Unit + timer ==="
TB=$(mktemp -d)
trap 'rm -rf "$TB"' EXIT
cat >"$TB/svc" <<EOF
[Unit]
Description=Giu AdGuard nghe dung dia chi IPv6 hien co
After=AdGuardHome.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/flock -w 20 /run/ntf-adguard-ipv6.lock $BIN
# Script có thể restart AdGuard, nên phải rộng hơn TimeoutStopSec của nó.
TimeoutStartSec=120
EOF
cat >"$TB/timer" <<EOF
[Unit]
Description=Dinh ky dong bo IPv6 cho AdGuard

[Timer]
OnBootSec=90s
OnUnitActiveSec=${EVERY}s
AccuracySec=15s
Unit=ntf-adguard-ipv6.service

[Install]
WantedBy=timers.target
EOF
run_sudo install -o root -g root -m 0644 "$TB/svc" "$UNIT" || exit 1
run_sudo install -o root -g root -m 0644 "$TB/timer" "$TIMER" || exit 1
run_sudo systemctl daemon-reload || exit 1
run_sudo systemctl enable --now ntf-adguard-ipv6.timer >/dev/null 2>&1

echo
echo "=== Kiểm tra ==="
echo "  timer:  $(systemctl is-enabled ntf-adguard-ipv6.timer) / $(systemctl is-active ntf-adguard-ipv6.timer)"
echo "  lần chạy: $(systemctl show -p Result --value ntf-adguard-ipv6.service)"
echo "  IPv6 đang nghe:"
ss -lntuH 2>/dev/null | awk '{print $5}' | grep -E '^\[.*\]:53$' | sort -u | sed 's/^/    /'
V6=$(ip -6 addr show dev "$(ip -4 route show default | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')" scope global 2>/dev/null |
  awk '/inet6/ && !/deprecated/ && !/temporary/ {print $2}' | cut -d/ -f1 | head -1)
if [ -n "$V6" ]; then
  if dig +time=2 +tries=1 +short A doubleclick.net @"$V6" 2>/dev/null | grep -qx '0.0.0.0'; then
    echo "  chặn qua IPv6: OK ($V6 trả 0.0.0.0 cho doubleclick.net)"
  else
    echo "  chặn qua IPv6: CHƯA ĐÚNG — kiểm tra \`journalctl -u ntf-adguard-ipv6\`" >&2
    exit 1
  fi
fi
