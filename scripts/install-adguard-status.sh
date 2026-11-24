#!/usr/bin/env bash
# install-adguard-status.sh — hẹn giờ ghi số liệu chặn quảng cáo cho panel đọc.
#
#   ./scripts/install-adguard-status.sh            # báo cáo hiện trạng
#   ./scripts/install-adguard-status.sh --apply    # cài timer (cần sudo)
#   ./scripts/install-adguard-status.sh --remove   # gỡ timer
#
# Chỉ là một timer chạy `ntf-adblock-status.sh` mỗi 30 giây. Tách khỏi install-adguard.sh vì
# hai tệp làm hai việc khác nhau: một tệp dựng DNS, một tệp nuôi panel. Nhờ vậy gỡ DNS
# không kéo theo panel và ngược lại.
set -uo pipefail

APPLY=0
REMOVE=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --remove) REMOVE=1 ;;
    *)
      echo "tham số lạ: $arg" >&2
      exit 2
      ;;
  esac
done

SRC=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/ntf-adblock-status.sh
BIN=/usr/local/sbin/ntf-adblock-status
UNIT=/etc/systemd/system/ntf-adblock-status.service
TIMER=/etc/systemd/system/ntf-adblock-status.timer
STATUS=/var/lib/ntf/adblock-status.json
EVERY=${NTF_ADBLOCK_EVERY:-30}

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
echo "  script:   $([ -x "$BIN" ] && echo CÓ || echo 'chưa')"
echo "  timer:    $(systemctl is-enabled ntf-adblock-status.timer 2>/dev/null || echo 'chưa') / $(systemctl is-active ntf-adblock-status.timer 2>/dev/null || echo 'không chạy')"
echo "  số liệu:  $([ -r "$STATUS" ] && echo "CÓ ($(stat -c%s "$STATUS") byte)" || echo 'chưa')"

if [ "$REMOVE" -eq 1 ]; then
  echo
  run_sudo systemctl disable --now ntf-adblock-status.timer 2>/dev/null
  run_sudo rm -f "$UNIT" "$TIMER" "$BIN" "$STATUS"
  run_sudo systemctl daemon-reload
  echo "  đã gỡ timer và tệp số liệu (AdGuard giữ nguyên)"
  exit 0
fi

if [ "$APPLY" -eq 0 ]; then
  echo
  echo "Chưa thay đổi gì. Chạy lại với --apply để cài."
  exit 0
fi

echo
echo "=== 1. Cài script ==="
# Copy chứ không symlink: root không được chạy một tệp mà tài khoản kiosk ghi được.
run_sudo install -o root -g root -m 0755 "$SRC" "$BIN" || exit 1
echo "  $BIN"

echo "=== 2. Unit + timer ==="
TB=$(mktemp -d)
trap 'rm -rf "$TB"' EXIT
cat >"$TB/svc" <<EOF
[Unit]
Description=Ghi so lieu chan quang cao cho panel
After=AdGuardHome.service

[Service]
Type=oneshot
# Bọc bằng flock tại đây: nếu lần chạy trước còn treo thì lần này chờ rồi bỏ, không ghi đè nhau.
ExecStart=/usr/bin/flock -w 10 /run/ntf-adblock-status.lock $BIN
TimeoutStartSec=60
EOF
cat >"$TB/timer" <<EOF
[Unit]
Description=Dinh ky ghi so lieu chan quang cao

[Timer]
OnBootSec=30s
OnUnitActiveSec=${EVERY}s
AccuracySec=5s
Unit=ntf-adblock-status.service

[Install]
WantedBy=timers.target
EOF
run_sudo install -o root -g root -m 0644 "$TB/svc" "$UNIT" || exit 1
run_sudo install -o root -g root -m 0644 "$TB/timer" "$TIMER" || exit 1
run_sudo systemctl daemon-reload || exit 1
run_sudo systemctl enable --now ntf-adblock-status.timer >/dev/null 2>&1
# Chạy một lần ngay để panel có số liệu trước khi hết 30 giây đầu.
run_sudo systemctl start ntf-adblock-status.service 2>/dev/null

echo
echo "=== Kiểm tra ==="
echo "  timer:    $(systemctl is-enabled ntf-adblock-status.timer) / $(systemctl is-active ntf-adblock-status.timer)"
echo "  lần chạy: $(systemctl show -p Result --value ntf-adblock-status.service)"
if [ -r "$STATUS" ]; then
  echo "  số liệu:  $(head -c 300 "$STATUS")"
else
  echo "  số liệu:  CHƯA CÓ — xem \`journalctl -u ntf-adblock-status\`" >&2
  exit 1
fi
