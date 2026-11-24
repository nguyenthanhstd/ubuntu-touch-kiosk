#!/usr/bin/env bash
# close-apps.sh — close the opt-in desktop apps the dock can launch, and nothing else.
#
# WHY THIS EXISTS: `pkill -f freetube` and `pkill -f /snap/firefox` match an unanchored substring,
# so they also match the shell running the command, the SSH session that started it, and any other
# process whose command line happens to contain that text. Running that once over SSH killed the
# login itself and the account's user manager. Every pattern here is anchored with ^ and applied to
# the binary path, and nothing is ever sent to cage or Electron.
#
#   ./scripts/close-apps.sh              # report only
#   ./scripts/close-apps.sh --apply
set -uo pipefail

APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h | --help)
      sed -n '2,15p' "$0"
      exit 0
      ;;
    *)
      echo "tham số lạ: $arg" >&2
      exit 2
      ;;
  esac
done

# Anchored to the start of the command line, and only for the known app binaries. `pgrep -f`
# without ^ would match this script's own argument list.
PATTERNS=(
  '^/opt/FreeTube/freetube'
  '^/snap/firefox/.*/firefox$'
  '^/snap/chromium/.*/chromium$'
)

if [ "$(id -u)" -eq 0 ]; then
  echo "chạy bằng tài khoản thường; không cần sudo để đóng app của chính mình" >&2
  exit 1
fi

echo "=== Tiến trình đang chạy ==="
found=0
for pattern in "${PATTERNS[@]}"; do
  pids=$(pgrep -f "$pattern" 2>/dev/null | tr '\n' ' ')
  if [ -n "${pids// /}" ]; then
    found=1
    echo "  $pattern -> $pids"
  fi
done
[ "$found" -eq 0 ] && echo "  không có app nào của dock đang chạy"

if [ "$APPLY" -eq 0 ]; then
  echo
  echo "Chưa đóng gì. Chạy lại với --apply để đóng."
  exit 0
fi
[ "$found" -eq 0 ] && exit 0

echo
echo "=== Đóng ==="
for pattern in "${PATTERNS[@]}"; do
  # SIGTERM first so FreeTube can flush its own settings file, then SIGKILL only survivors.
  pkill -TERM -f "$pattern" 2>/dev/null || true
done
for _ in 1 2 3 4 5 6 7 8 9 10; do
  still=0
  for pattern in "${PATTERNS[@]}"; do
    pgrep -f "$pattern" >/dev/null 2>&1 && still=1
  done
  [ "$still" -eq 0 ] && break
  sleep 1
done
for pattern in "${PATTERNS[@]}"; do
  pgrep -f "$pattern" >/dev/null 2>&1 && pkill -KILL -f "$pattern" 2>/dev/null || true
done

echo "  xong"
comp=0
for name in labwc cage; do
  comp=$(pgrep -c -x "$name" 2>/dev/null || true)
  [ -n "$comp" ] && [ "$comp" -gt 0 ] && echo "Kiosk không bị chạm tới: $comp tiến trình $name vẫn chạy"
done
