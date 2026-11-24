#!/usr/bin/env bash
# uninstall-autostart.sh — undo install-autostart.sh and nothing else.
#
#   ./scripts/uninstall-autostart.sh              # report only
#   ./scripts/uninstall-autostart.sh --apply
set -uo pipefail

APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h | --help)
      sed -n '2,8p' "$0"
      exit 0
      ;;
    *)
      echo "tham số lạ: $arg" >&2
      exit 2
      ;;
  esac
done

UNIT_NAME="ntfitness-kiosk.service"
UNIT_PATH="$HOME/.config/systemd/user/$UNIT_NAME"

echo "=== Hiện trạng ==="
if [ -f "$UNIT_PATH" ]; then echo "  unit:   có ($UNIT_PATH)"; else echo "  unit:   không có"; fi
echo "  enable: $(systemctl --user is-enabled "$UNIT_NAME" 2>/dev/null || echo 'no')"
echo "  active: $(systemctl --user is-active "$UNIT_NAME" 2>/dev/null || echo 'no')"
echo "  linger: $(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo 'không rõ')"

if [ ! -f "$UNIT_PATH" ]; then
  echo
  echo "Không có gì để gỡ."
  exit 0
fi

if [ "$APPLY" -eq 0 ]; then
  echo
  echo "Chạy lại với --apply để gỡ."
  exit 0
fi

# Stop with a bounded wait. KillMode=mixed in the unit means the group gets SIGTERM and then
# SIGKILL, but a wedged DRM client can still outlive it, so never block the script forever.
timeout 20 systemctl --user stop "$UNIT_NAME" 2>/dev/null || {
  echo "  stop quá 20 s — kill cưỡng bức" >&2
  systemctl --user kill -s SIGKILL "$UNIT_NAME" 2>/dev/null || true
}
systemctl --user disable "$UNIT_NAME" 2>/dev/null || true
rm -f "$UNIT_PATH"
systemctl --user daemon-reload || true

# Linger is deliberately NOT disabled. `loginctl disable-linger` makes systemd tear down the whole
# user manager, which kills every process of this account — including an SSH login living inside
# that manager. Doing it here once killed connectivity to this kiosk mid-rollback. Linger is a
# machine-level setting that other services may rely on, so it stays as the operator left it, and
# the script says so instead of silently changing it.
echo "  linger: vẫn giữ nguyên ($(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo 'không rõ'))"
echo "  (không tắt linger ở đây — tắt sẽ dựng lại cả user manager và có thể cắt phiên SSH đang chạy)"
echo "  muốn tắt hẳn:  sudo loginctl disable-linger $USER   # chỉ khi đã có phiên đăng nhập khác"

echo "Đã gỡ tự khởi động. getty@tty1 và Phase 1 không bị chạm tới."
