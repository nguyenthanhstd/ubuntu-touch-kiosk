#!/usr/bin/env bash
# ntf-doctor.sh — read-only diagnostics for the NT Fitness kiosk.
#
# Why this exists instead of an editor on the machine: the target has no desktop session, only
# labwc under `run-kiosk.sh`, so a GUI editor there would fight the compositor for the panel and
# give no more evidence than plain text. This script turns "what is the machine actually doing"
# into a single file that can be read over SSH or copied back to a workstation.
#
#   ./ntf-doctor.sh                # full report to stdout
#   ./ntf-doctor.sh --watch 3      # refresh the live section every 3 s until Ctrl-C
#   ./ntf-doctor.sh --out /tmp/x   # also write the report to a file
#
# Section GIẢI MÃ VIDEO explains "video giật": it prints the GPU driver actually loaded, the kernel
# modeset flag, hardware codec profiles from vainfo, the real OpenGL renderer, and the Chromium
# decoder switches of the live renderer. Read-only: it never starts, stops, installs or
# reconfigures anything.
set -uo pipefail

WATCH=0
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --watch) WATCH="${2:-3}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    -h | --help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "tham số lạ: $1" >&2; exit 2 ;;
  esac
done

hr() { printf '\n===== %s =====\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

# Prints only the switches that decide whether a decoder exists at all, so the output stays
# readable. A renderer with no `--enable-features=` line is running purely on Chromium defaults.
renderer_flags() {
  local cmd="$1"
  [ -n "$cmd" ] || { echo "không thấy tiến trình renderer — kiosk đang tắt?"; return 0; }
  printf '%s\n' "$cmd" | tr ' ' '\n' |
    grep -E '^(--)?(enable-features|disable-features|use-gl|use-angle|ozone-platform|disable-gpu)[= ]' ||
    echo "không có cờ giải mã/màn hình nào (toàn bộ là mặc định)"
}

section_processes() {
  hr "TIẾN TRÌNH KIOSK"
  # labwc and electron are the only two processes the kiosk needs. Showing the tree makes a
  # half-dead run (labwc alive, electron gone) obvious at a glance.
  if pgrep -af 'labwc|electron' | grep -v ntf-doctor; then :; else echo "không có labwc/electron nào đang chạy"; fi
  printf '\n-- chuỗi tiến trình --\n'
  pgrep -af 'labwc|chrome-sandbox|electron' | grep -v ntf-doctor | awk '{print $1}' |
    while read -r pid; do ps -o pid=,ppid=,stat=,pcpu=,pmem=,etime=,comm= -p "$pid"; done
}

section_display() {
  hr "MÀN HÌNH / WAYLAND"
  echo "-- phiên đồ hoạ --"
  loginctl list-sessions --no-legend 2>/dev/null || echo "loginctl không dùng được"
  printf '\n-- DRM --\n'
  for card in /sys/class/drm/card*-*/status; do
    [ -e "$card" ] || continue
    printf '%s = %s\n' "${card%/status}" "$(cat "$card" 2>/dev/null)"
  done
  printf '\n-- chế độ hiện tại --\n'
  if [ -n "${WAYLAND_DISPLAY:-}" ]; then
    echo "WAYLAND_DISPLAY=$WAYLAND_DISPLAY XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-}"
  else
    echo "shell này không ở trong phiên Wayland (bình thường khi SSH vào)"
  fi
  ls -l /run/user/"$(id -u)"/wayland-* 2>/dev/null || echo "không thấy socket wayland-* (Cage chưa chạy)"
  printf '\n-- GPU --\n'
  lsmod | grep -E '^(nouveau|nvidia|i915)' || echo "không thấy module GPU"
}

# Reads the environment of a live process. `LIBVA_DRIVER_NAME`/`NVD_BACKEND` are exported by
# `session.sh`, so this SSH shell never inherits them — looking at /proc is the only way to see what
# the kiosk itself is really using.
proc_env() {
  local pid="$1" name="$2"
  tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null | grep -E "^${name}=" ||
    echo "${name}=(không có trong môi trường tiến trình)"
}

section_decode() {
  hr "GIẢI MÃ VIDEO (GPU / VA-API)"
  printf '\n-- thiết bị DRM --\n'
  ls -l /dev/dri 2>/dev/null || echo "không có /dev/dri"
  printf '\n-- driver GPU đang nạp --\n'
  lsmod 2>/dev/null | grep -E '^(nouveau|nvidia|nvidia_drm|nvidia_modeset|i915|amdgpu)' ||
    echo "không thấy module GPU nào"
  printf '\n-- tham số kernel --\n'
  grep -o 'nvidia[-_a-z]*\.modeset=[0-9]' /proc/cmdline 2>/dev/null ||
    echo "không có nvidia-drm.modeset=1 (bắt buộc cho nvidia-vaapi-driver)"
  if have nvidia-smi; then
    printf '\n-- nvidia-smi --\n'
    nvidia-smi --query-gpu=name,driver_version,memory.used,memory.total,utilization.gpu \
      --format=csv,noheader 2>&1 | head -3
  else
    echo "không có nvidia-smi -> chưa cài driver chính hãng (đang dùng nouveau?)"
  fi
  printf '\n-- VA-API khả dụng --\n'
  printf 'LIBVA_DRIVER_NAME=%s NVD_BACKEND=%s (từ shell này)\n' \
    "${LIBVA_DRIVER_NAME:-(chưa đặt)}" "${NVD_BACKEND:-(chưa đặt)}"
  if have pgrep; then
    local kpid
    kpid="$(pgrep -f 'type=gpu-process' | head -1 || true)"
    if [ -n "$kpid" ]; then
      printf 'tiến trình GPU %s: ' "$kpid"
      proc_env "$kpid" LIBVA_DRIVER_NAME
      printf 'tiến trình GPU %s: ' "$kpid"
      proc_env "$kpid" NVD_BACKEND
    else
      echo "không thấy tiến trình GPU — kiosk đang tắt?"
    fi
  fi
  if have vainfo; then
    vainfo 2>&1 | grep -E 'vainfo:|Driver version|VAProfile(VP9|H264|HEVC|AV1)' | head -24
  else
    echo "không có vainfo — cài: sudo apt install vainfo"
  fi
  printf '\n-- lớp OpenGL thực tế --\n'
  if have glxinfo; then
    glxinfo -B 2>/dev/null | grep -E 'OpenGL (vendor|renderer|version)' | head -4
  else
    echo "không có glxinfo — cài: sudo apt install mesa-utils"
  fi
  printf '\n-- cờ Chromium ở tiến trình renderer --\n'
  if have pgrep; then
    renderer_flags "$(pgrep -af 'type=renderer' | head -1 || true)"
  else
    echo "không có pgrep (gói procps)"
  fi
  printf '\n-- CPU của tiến trình con --\n'
  if have pgrep; then
    pgrep -af 'electron' | grep -v ntf-doctor | awk '{print $1}' |
      while read -r pid; do ps -o pid=,pcpu=,comm= -p "$pid"; done | sort -k2 -nr | head -8
  else
    ps -eo pid,pcpu,comm 2>/dev/null | sort -k2 -nr | head -8
  fi
}

section_media() {
  hr "MEDIA / ÂM THANH"
  if have wpctl; then
    wpctl status 2>/dev/null | sed -n '1,25p' || echo "wpctl lỗi"
    printf '\n-- âm lượng mặc định --\n'
    wpctl get-volume @DEFAULT_AUDIO_SINK@ 2>/dev/null || true
  else
    echo "không có wpctl (PipeWire chưa cài?)"
  fi
}

section_logs() {
  hr "LOG GẦN ĐÂY"
  # The probe scripts write plain text logs; tailing them is usually faster than rebuilding state.
  for log in /tmp/play1.log /tmp/svc1.log /tmp/probe4.log /tmp/cage.log; do
    [ -f "$log" ] || continue
    printf '\n-- %s (%s dòng) --\n' "$log" "$(wc -l <"$log")"
    grep -aE '^(PASS|FAIL|===|      |\[)' "$log" | tail -25
  done
  printf '\n-- journal cho ứng dụng --\n'
  journalctl --user -n 20 --no-pager 2>/dev/null | tail -20 || echo "journal user không đọc được khi SSH"
}

section_resources() {
  hr "TÀI NGUYÊN"
  cat /proc/loadavg
  free -m | sed -n '1,2p'
  printf '\n-- nhiệt độ --\n'
  if have sensors; then sensors 2>/dev/null | grep -E 'Package|Core 0|fan' | head -5 || true; else echo "không có lm-sensors"; fi
  printf '\n-- dung lượng --\n'
  df -h / | tail -1
}

report() {
  echo "NT FITNESS — CHẨN ĐOÁN $(date -Is) trên $(hostname) ($(uname -sr))"
  section_processes
  section_display
  section_decode
  section_media
  section_resources
  section_logs
}

if [ "$WATCH" -gt 0 ]; then
  while true; do
    clear 2>/dev/null || printf '\033[H\033[2J'
    report
    printf '\n(Ctrl-C để dừng — cập nhật mỗi %ss)\n' "$WATCH"
    sleep "$WATCH"
  done
fi

report | tee "${OUT:-/dev/null}"
