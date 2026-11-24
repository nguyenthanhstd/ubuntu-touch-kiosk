#!/usr/bin/env bash
# install-maintenance.sh — bật lịch bảo trì (apt update/upgrade) tự động cho máy kiosk.
#
#   ./scripts/install-maintenance.sh            # chỉ báo cáo, không ghi gì
#   ./scripts/install-maintenance.sh --apply    # cài timer hệ thống (cần sudo)
#   ./scripts/install-maintenance.sh --run      # chạy thử ngay một lần (cần sudo)
#   ./scripts/install-maintenance.sh --remove   # gỡ timer và cấu hình
#
# Cài những thứ sau:
#   1. /usr/local/sbin/ntf-maintenance — bản sao của scripts/ntf-maintenance.sh, root:root 0755.
#      Sao chép thay vì trỏ vào thư mục ứng dụng vì thư mục đó đổi theo mỗi lần deploy, còn root thì
#      không được chạy một tệp mà người dùng thường ghi được (leo thang đặc quyền).
#   2. ntf-maintenance.service + .timer — Type=oneshot, OnCalendar=Sun 03:00, Persistent=true.
#   3. /etc/needrestart/conf.d/50-ntf.conf — không hỏi, không tự khởi động lại dịch vụ giữa chừng.
#   4. /var/lib/ntf/update-status.json — để giao diện hiện được "đã cập nhật N gói".
#
# Timer của **hệ thống**, không phải `systemctl --user`: apt cần root, còn user manager của kiosk
# sống trong /run/user/<uid> và biến mất mỗi lần logout. Một timer hệ thống chạy đúng dù không ai
# đăng nhập, đúng thứ cần cho thiết bị treo tường.
set -uo pipefail

APPLY=0
REMOVE=0
RUNNOW=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --remove) REMOVE=1 ;;
    --run) RUNNOW=1 ;;
    -h | --help)
      sed -n '2,26p' "$0"
      exit 0
      ;;
    *)
      echo "tham số lạ: $arg" >&2
      exit 2
      ;;
  esac
done

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
SRC="$SCRIPT_DIR/ntf-maintenance.sh"
SRC_STATUS="$SCRIPT_DIR/ntf-update-status.sh"
BIN=/usr/local/sbin/ntf-maintenance
BIN_STATUS=/usr/local/sbin/ntf-update-status
UNIT=/etc/systemd/system/ntf-maintenance.service
TIMER=/etc/systemd/system/ntf-maintenance.timer
NEEDRESTART_CONF=/etc/needrestart/conf.d/50-ntf.conf
STATE_DIR=/var/lib/ntf

run_sudo() {
  if [ -n "${NTF_SUDO_PASS:-}" ]; then
    printf '%s\n' "$NTF_SUDO_PASS" | sudo -S -p '' "$@"
  else
    sudo -n "$@"
  fi
}

if [ "$(id -u)" -ne 0 ]; then
  if ! run_sudo true 2>/dev/null; then
    echo "cần sudo (hoặc đặt NTF_SUDO_PASS) — SSH không có terminal nên sudo không hỏi được" >&2
    exit 1
  fi
fi

echo "=== Hiện trạng ==="
echo "  script nguồn:   $SRC $([ -f "$SRC" ] && echo 'CÓ' || echo 'THIẾU')"
echo "  script trạng thái: $SRC_STATUS $([ -f "$SRC_STATUS" ] && echo 'CÓ' || echo 'THIẾU')"
echo "  timer:          $(systemctl is-enabled ntf-maintenance.timer 2>/dev/null || echo 'chưa cài') / $(systemctl is-active ntf-maintenance.timer 2>/dev/null || echo 'không chạy')"
echo "  lần chạy cuối:  $(systemctl show -p Result --value ntf-maintenance.service 2>/dev/null || echo 'chưa có')"
if [ -f "$STATE_DIR/update-status.json" ]; then
  echo "  trạng thái:     $(tr -d '\n' <"$STATE_DIR/update-status.json")"
else
  echo "  trạng thái:     chưa có tệp"
fi
echo "  unattended-upgrades: $(systemctl is-enabled unattended-upgrades 2>/dev/null || echo 'không có')"

if [ "$REMOVE" -eq 1 ]; then
  run_sudo systemctl disable --now ntf-maintenance.timer 2>/dev/null
  run_sudo rm -f "$TIMER" "$UNIT" "$NEEDRESTART_CONF" "$BIN" "$BIN_STATUS"
  run_sudo systemctl daemon-reload
  echo "=== Đã gỡ ==="
  echo "  giữ nguyên $STATE_DIR và /var/log/ntf-maintenance.log để còn đối chiếu"
  exit 0
fi

if [ ! -f "$SRC" ] || [ ! -f "$SRC_STATUS" ]; then
  echo "THIẾU $SRC hoặc $SRC_STATUS" >&2
  exit 1
fi

if [ "$RUNNOW" -eq 1 ]; then
  if [ ! -x "$BIN" ]; then
    echo "chưa cài — chạy --apply trước" >&2
    exit 1
  fi
  echo "=== Chạy ngay một lần ==="
  run_sudo "$BIN"
  rc=$?
  echo "  rc=$rc"
  [ -f "$STATE_DIR/update-status.json" ] && tr -d '\n' <"$STATE_DIR/update-status.json" && echo
  exit "$rc"
fi

if [ "$APPLY" -eq 0 ]; then
  echo
  echo "Chưa thay đổi gì. Chạy lại với --apply để bật lịch bảo trì."
  exit 0
fi

echo
echo "=== Cài đặt ==="

# root:root 0755 và không phải symlink: root không được `source` một tệp mà tài khoản kiosk sửa được.
run_sudo install -o root -g root -m 0755 "$SRC" "$BIN" || exit 1
run_sudo install -o root -g root -m 0755 "$SRC_STATUS" "$BIN_STATUS" || exit 1
echo "  $BIN"
echo "  $BIN_STATUS"

run_sudo mkdir -p "$STATE_DIR"
run_sudo chmod 0755 "$STATE_DIR"
echo "  $STATE_DIR"

run_sudo mkdir -p /etc/needrestart/conf.d
printf '%s\n' \
  '# Do kiosk cài: needrestart không được hỏi và không được tự khởi động lại dịch vụ.' \
  '# `l` = chỉ liệt kê vào log; `i`/`a` sẽ restart ngay giữa lúc timer đang chạy và có thể làm' \
  '# mất phiên Wayland của kiosk mà không ai biết.' \
  "\$nrconf{restart} = 'l';" \
  >/tmp/50-ntf.conf.$$
run_sudo install -o root -g root -m 0644 /tmp/50-ntf.conf.$$ "$NEEDRESTART_CONF"
rm -f /tmp/50-ntf.conf.$$
echo "  $NEEDRESTART_CONF"

# OnCalendar=Sun 03:00: máy đang khoá, mạng sống, và nếu một gói làm hỏng giao diện thì còn nguyên
# tuần để phát hiện. RandomizedDelaySec tránh mọi máy trong nhà cùng đập vào kho gói một giây.
# Persistent=true chạy bù lần bị lỡ khi máy tắt qua đêm — đây là thứ thay thế cho "cập nhật lúc bật máy".
cat >/tmp/ntf-maintenance.service.$$ <<EOF
[Unit]
Description=NT Fitness Touch - bao tri apt (update/upgrade)
Documentation=file:///var/log/ntf-maintenance.log
After=network-online.target
Wants=network-online.target
# Một lần chạy hiếm khi quá 10 phút; chặn ở 45 phút để dpkg treo không chiếm máy mãi.
ConditionPathExists=!/run/ntf-maintenance.hold

[Service]
Type=oneshot
ExecStart=$BIN
TimeoutStartSec=2700
Nice=10
IOSchedulingClass=idle
# Timer chạy bằng root nhưng tiến trình con không cần quyền gì thêm ngoài apt.
NoNewPrivileges=yes
PrivateTmp=yes
EOF

cat >/tmp/ntf-maintenance.timer.$$ <<EOF
[Unit]
Description=NT Fitness Touch - lich bao tri hang tuan (Sun 03:00)

[Timer]
OnCalendar=Sun *-*-* 03:00:00
RandomizedDelaySec=30m
Persistent=true
AccuracySec=1min
Unit=ntf-maintenance.service

[Install]
WantedBy=timers.target
EOF

run_sudo install -o root -g root -m 0644 /tmp/ntf-maintenance.service.$$ "$UNIT"
run_sudo install -o root -g root -m 0644 /tmp/ntf-maintenance.timer.$$ "$TIMER"
rm -f /tmp/ntf-maintenance.service.$$ /tmp/ntf-maintenance.timer.$$
echo "  $UNIT"
echo "  $TIMER"

run_sudo systemctl daemon-reload || exit 1
run_sudo systemctl enable --now ntf-maintenance.timer || exit 1

echo
echo "=== Kiểm tra ==="
echo "  timer:     $(systemctl is-enabled ntf-maintenance.timer) / $(systemctl is-active ntf-maintenance.timer)"
systemctl list-timers ntf-maintenance.timer --no-pager 2>/dev/null | sed -n '1,3p'
echo "  lệnh tay:  sudo $BIN --check"
echo "  nhật ký:   tail -f /var/log/ntf-maintenance.log"
