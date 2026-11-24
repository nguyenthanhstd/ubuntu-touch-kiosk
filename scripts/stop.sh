#!/usr/bin/env bash
# stop.sh — stop anything the test scripts started, and nothing else.
#
# Only processes whose command line points at this prototype are killed, so a stray `pkill cage`
# cannot take down a session someone else owns. Safe to run when nothing is running.
#
#   ./scripts/stop.sh        # dừng Electron + cage của prototype
#   ./scripts/stop.sh -h     # chỉ in trợ giúp, KHÔNG dừng gì
set -uo pipefail

# Phải xử lý tham số **trước** khi kill. Bản trước bỏ qua mọi tham số, nên `stop.sh -h` (một bài
# kiểm tra "chỉ in trợ giúp") lại hạ luôn Electron của kiosk đang chạy. Hậu quả trên bộ e2e: harness
# đã mở cổng 9222 bằng drop-in, `-h` giết tiến trình đang phục vụ cổng đó, và **mọi ca sau** nhận
# `ECONNRESET` (tier-2: 56/85 fail trong ~1.5 ms) dù sản phẩm không có lỗi.
for arg in "$@"; do
  case "$arg" in
    -h | --help)
      sed -n '2,9p' "$0"
      exit 0
      ;;
    *)
      echo "tham số lạ: $arg" >&2
      exit 2
      ;;
  esac
done

APPDIR="${APPDIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

killed=0
kill_tree() {
  local pid="$1" label="$2"
  # TERM first: Electron flushes its session partitions on a clean exit. KILL would leave a
  # half-written cookie jar behind for the next customer.
  if kill -TERM "$pid" 2>/dev/null; then
    echo "dừng $label (pid $pid)"
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$pid" 2>/dev/null || return 0
      sleep 0.5
    done
    kill -KILL "$pid" 2>/dev/null && echo "buộc dừng $label (pid $pid)"
    killed=$((killed + 1))
  fi
}

for pid in $(pgrep -f "dist/main/main.js" || true); do kill_tree "$pid" "Electron"; done
for pid in $(pgrep -x cage || true); do kill_tree "$pid" "cage"; done

if [ "$killed" -eq 0 ]; then
  echo "không có tiến trình nào của prototype đang chạy"
fi

# Report leftovers rather than guessing: a surviving electron means it ignored TERM.
left=$(pgrep -af "dist/main/main.js" || true)
[ -n "$left" ] && printf 'còn sót:\n%s\n' "$left"
exit 0
