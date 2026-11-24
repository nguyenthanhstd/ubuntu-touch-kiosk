#!/usr/bin/env bash
# rollback.sh — remove the prototype from this machine and prove nothing of Phase 1 changed.
#
# Phase 2 was built to be reversible: no systemd unit, no autostart, no driver or network change,
# nothing written outside $HOME. So rollback means deleting what this prototype created and
# verifying the Phase 1 setup is intact.
#
#   ./scripts/rollback.sh            # report what would be removed
#   ./scripts/rollback.sh --apply    # actually remove it
set -uo pipefail

APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h | --help)
      sed -n '2,10p' "$0"
      exit 0
      ;;
    *) echo "tham số lạ: $arg" >&2; exit 2 ;;
  esac
done

PROTO="${NTF_ROOT:-$HOME/ntfitness-online}"
DATA="$HOME/.config/ntfitness-online"
KEPT="$HOME/test_kiosk" # Phase 1 artifact: never touched, listed only to prove we left it alone

echo "=== Kiểm tra Phase 1 còn nguyên ==="
for item in "$KEPT" /dev/dri/card0; do
  [ -e "$item" ] && echo "  có: $item" || echo "  THIẾU: $item"
done
if command -v chromium >/dev/null; then echo "  chromium: $(chromium --version 2>/dev/null)"; else echo "  chromium: không tìm thấy trong PATH"; fi
systemctl is-active seatd 2>/dev/null | sed 's/^/  seatd: /'

echo
echo "=== Sẽ xoá ==="
for path in "$PROTO" "$DATA"; do
  if [ -e "$path" ]; then
    echo "  $path ($(du -sh "$path" 2>/dev/null | cut -f1))"
  else
    echo "  $path (không có)"
  fi
done

if [ ! -e "$PROTO" ] && [ ! -e "$DATA" ]; then
  echo "Không còn gì để xoá — rollback đã hoàn tất."
  exit 0
fi

if [ "$APPLY" -eq 0 ]; then
  echo
  echo "Chạy lại với --apply để xoá thật."
  exit 0
fi

# Stop first so a running Electron cannot rewrite its partition data mid-delete.
"$(dirname "${BASH_SOURCE[0]}")/stop.sh" || true
rm -rf -- "$PROTO" "$DATA"
echo "Đã xoá. Phase 1 không bị chạm tới."
