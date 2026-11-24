#!/usr/bin/env bash
# run-test.sh — start the Online Edition prototype for a manual trial.
#
# Deliberately NOT a systemd unit and NOT an autostart entry: Phase 2 stops short of production
# (spec G/H). The script starts Cage on the local tty, runs Electron inside it, and exits when the
# user closes the app, so nothing keeps running after a session.
#
#   ./scripts/run-test.sh              # kiosk on the panel (needs the tty, no SSH)
#   ./scripts/run-test.sh --headless   # offscreen render, for CI/log-only checks
#   NTF_LOG=/tmp/ntf.log ./scripts/run-test.sh
#
# Credentials are never stored here: it uses the invoking user's uid and HOME.
set -euo pipefail

APPDIR="${APPDIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ELECTRON="${ELECTRON:-$(cd "$APPDIR/.." && pwd)/electron-dist/electron}"
ENTRY="$APPDIR/dist/main/main.js"
LOG="${NTF_LOG:-/tmp/ntf-run.log}"
MODE="kiosk"

for arg in "$@"; do
  case "$arg" in
    --headless) MODE="headless" ;;
    -h | --help)
      sed -n '2,13p' "$0"
      exit 0
      ;;
    *)
      echo "tham số lạ: $arg" >&2
      exit 2
      ;;
  esac
done

[ -x "$ELECTRON" ] || {
  echo "không thấy Electron tại $ELECTRON" >&2
  echo "đặt ELECTRON=/đường/dẫn/electron nếu nó nằm chỗ khác" >&2
  exit 1
}
[ -f "$ENTRY" ] || {
  echo "chưa build: thiếu $ENTRY (chạy npm run build)" >&2
  exit 1
}

# Never run as root (spec G): a kiosk with a root browser can write anywhere on the box.
if [ "$(id -u)" -eq 0 ]; then
  echo "chạy bằng tài khoản thường, không phải root" >&2
  exit 1
fi

if [ "$MODE" = "headless" ]; then
  echo "chạy offscreen, log: $LOG"
  "$ELECTRON" "$ENTRY" --ntf-dev --ozone-platform=headless --disable-gpu >"$LOG" 2>&1 &
  echo "pid $! — dừng bằng scripts/stop.sh"
  exit 0
fi

# Cage needs the seat, which SSH sessions do not own. Refuse early with a clear reason instead of
# printing a confusing wlroots error.
has_seat() { [ -w /dev/dri/card0 ]; }

if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ ! -d "/run/user/$(id -u)" ]; then
  echo "không có XDG_RUNTIME_DIR và /run/user/$(id -u) — không có phiên đăng nhập để chạy Cage" >&2
  exit 1
fi
if ! has_seat; then
  echo "tài khoản này không mở được /dev/dri/card0 — cần chạy từ tty của máy, không phải SSH" >&2
  exit 1
fi

if ! command -v cage >/dev/null; then
  echo "không có lệnh cage" >&2
  exit 1
fi

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export LIBSEAT_BACKEND="${LIBSEAT_BACKEND:-seatd}"
export XDG_SESSION_TYPE=wayland
# Do not set XDG_SESSION_DESKTOP/WAYLAND_DISPLAY here: cage exports the display it creates.

echo "khởi động Cage + Electron, log: $LOG"
# -d: log to stderr, -s: no client-side decorations (there is no desktop to draw them on)
# `exec cage ... | tee "$LOG"` made `tee` the shell, so $LOG was never written; PIDs are needed
# by stop.sh anyway, so run the pipeline in the background and wait on it.
cage -d -s -- "$ELECTRON" "$ENTRY" --ntf-dev 2>&1 | tee "$LOG" &
CAGE_PID=$!
wait "$CAGE_PID"
