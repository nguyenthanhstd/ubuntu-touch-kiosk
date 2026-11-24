#!/usr/bin/env bash
# install-autostart.sh — make the kiosk come up by itself after a reboot.
#
# Uses a systemd *user* unit plus `loginctl enable-linger`, not an autologin drop-in. Reasons:
#   * no tty autologin means getty@tty1 keeps working, so you can still log in on the console;
#   * the unit runs as the kiosk user, never root (spec G);
#   * linger keeps the user manager alive without an open login session, which is what a kiosk
#     needs, while `sudo systemctl disable --now getty@tty1` remains the emergency escape hatch.
#
# Reversible and idempotent: running it twice changes nothing, and uninstall-autostart.sh restores
# exactly the previous state (unit removed, linger disabled).
#
#   ./scripts/install-autostart.sh              # report only
#   ./scripts/install-autostart.sh --apply
set -uo pipefail

APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h | --help)
      sed -n '2,17p' "$0"
      exit 0
      ;;
    *)
      echo "tham số lạ: $arg" >&2
      exit 2
      ;;
  esac
done

if [ "$(id -u)" -eq 0 ]; then
  echo "chạy bằng tài khoản thường (unit là user unit của chính bạn)" >&2
  exit 1
fi

APPDIR="${APPDIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_NAME="ntfitness-kiosk.service"
UNIT_PATH="$UNIT_DIR/$UNIT_NAME"
ENTRY="$APPDIR/dist/main/main.js"
RUNNER="$APPDIR/scripts/run-kiosk.sh"

# Over SSH there is no terminal, so `sudo` cannot prompt. Use NTF_SUDO_PASS when the caller sets
# it, and fall back to a non-interactive sudo that fails instead of hanging forever.
run_sudo() {
  if [ -n "${NTF_SUDO_PASS:-}" ]; then
    printf '%s\n' "$NTF_SUDO_PASS" | sudo -S -p '' "$@"
  else
    sudo -n "$@"
  fi
}

echo "=== Kiểm tra điều kiện ==="
[ -x "$RUNNER" ] && echo "  runner: $RUNNER" || { echo "  THIẾU $RUNNER" >&2; exit 1; }
[ -f "$ENTRY" ] && echo "  build:  $ENTRY" || { echo "  THIẾU $ENTRY (chạy npm run build)" >&2; exit 1; }
# The kiosk runs under labwc so an external app can sit inside the frame. Without the compositor
# run-kiosk.sh silently falls back to cage, where apps cover the whole panel — worth saying out loud
# at install time rather than discovering it at the panel.
if command -v labwc >/dev/null 2>&1; then
  echo "  compositor: labwc $(labwc --version 2>/dev/null | head -n 1)"
  [ -x "$APPDIR/scripts/gen-labwc-config.sh" ] ||
    { echo "  THIẾU quyền chạy $APPDIR/scripts/gen-labwc-config.sh" >&2; exit 1; }
else
  echo "  CẢNH BÁO: chưa cài labwc — kiosk sẽ chạy bằng cage và app ngoài sẽ phủ toàn màn hình." >&2
  echo "    sudo apt-get install -y labwc" >&2
fi
if [ -w /dev/dri/card0 ]; then
  echo "  /dev/dri/card0: mở được"
else
  echo "  /dev/dri/card0: KHÔNG mở được — kiểm tra nhóm video/seatd" >&2
  exit 1
fi
echo "  getty@tty1: $(systemctl is-enabled getty@tty1 2>/dev/null || echo 'không rõ') (giữ nguyên, không tắt)"
echo "  linger:     $(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo 'không rõ')"

# /run/seatd.sock is root:video. The user manager caches the account's groups at start, so a manager
# older than the account's video membership makes cage die in ~30 ms. Catch it here, before writing
# anything, and print the one command that fixes it. The probe reads the manager's own /proc entry:
# `id -nG` would answer for the calling shell, not for the manager that will spawn cage.
manager_groups() {
  local main_pid
  main_pid=$(systemctl --user show -p MainPID --value 2>/dev/null)
  [ -n "$main_pid" ] && [ "$main_pid" != "0" ] || return 0
  sed -n 's/^Groups:[[:space:]]*//p' "/proc/$main_pid/status" 2>/dev/null
}

has_video_group() {
  local groups gid
  groups=$(manager_groups)
  # An unreadable /proc is not evidence of a problem; stay quiet rather than cry wolf.
  [ -n "$groups" ] || return 0
  gid=$(getent group video 2>/dev/null | cut -d: -f3)
  [ -n "$gid" ] || return 0
  case " $groups " in
    *" $gid "*) return 0 ;;
    *) return 1 ;;
  esac
}

if ! has_video_group; then
  echo "  CẢNH BÁO: user manager thiếu nhóm video (gid $(getent group video | cut -d: -f3)) — cage sẽ không mở được seatd." >&2
  echo "    systemctl --user exit     # linger sẽ dựng lại manager và đọc lại nhóm" >&2
fi

if [ "$APPLY" -eq 0 ]; then
  echo
  echo "Chưa thay đổi gì. Chạy lại với --apply để bật tự khởi động."
  exit 0
fi

echo
echo "=== Ghi unit ==="
mkdir -p "$UNIT_DIR"
cat >"$UNIT_PATH" <<EOF
[Unit]
Description=NT Fitness Touch kiosk (labwc + Electron)
After=graphical.target
# Never let a crashed kiosk flap forever: 3 restarts, then stop and stay stopped so an operator
# notices instead of a black screen looping every 5 seconds.
StartLimitIntervalSec=120
StartLimitBurst=3

[Service]
Type=simple
WorkingDirectory=$APPDIR
Environment=NTF_COMPOSITOR=labwc
# Hardware video decode is opt-in, on purpose: add "Environment=NTF_VAAPI_DRIVER=nvidia" here only
# after "vainfo" lists VAProfile* entries. run-kiosk.sh turns that into LIBVA_DRIVER_NAME,
# NVD_BACKEND=direct and NTF_GPU_NVIDIA=1. Why it is not the default: docs/video-acceleration.md.
ExecStart=$RUNNER
Restart=on-failure
RestartSec=5
# The compositor holds the DRM device and the Electron child holds the Wayland connection; a plain
# SIGTERM to the unit can therefore wait forever on a wedged client. SIGTERM the group first, then
# SIGKILL what is left, so "systemctl --user stop" always returns instead of hanging the shell.
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=10
SendSIGKILL=yes
# Groups (video, render, input, audio) must already be on the account when the *user manager*
# started, because that manager snapshots the group list once. SupplementaryGroups= cannot fix a
# stale snapshot: a non-root user manager gets "Changing group credentials failed" and
# "status=216/GROUP". The remedy is "systemctl --user exit" with linger on — see the check above.
UnsetEnvironment=DISPLAY WAYLAND_DISPLAY

[Install]
WantedBy=default.target
EOF
echo "  $UNIT_PATH"

# Firefox draws its own GTK client-side-decoration shadow around every window. labwc's
# `dropShadows=no` only silences the compositor's own shadows, so without this override the shadow
# bleeds over both 10px gutters and reaches y=1518, on top of the dock. The file is user-level and
# survives a rebuild, but an OS reinstall loses ~/.config, hence this step.
GTK_DIR="$HOME/.config/gtk-3.0"
GTK_CSS="$GTK_DIR/gtk.css"
# Matches both the pretty-printed form already on the panel and the one-line form appended below.
if [ -f "$GTK_CSS" ] && grep -qE 'box-shadow[[:space:]]*:[[:space:]]*none' "$GTK_CSS"; then
  echo "  gtk.css đã có luật bỏ bóng CSD"
else
  mkdir -p "$GTK_DIR"
  if [ -f "$GTK_CSS" ]; then
    cp -a "$GTK_CSS" "$GTK_CSS.bak-$(date +%Y%m%d-%H%M%S)"
    echo "  đã sao lưu gtk.css cũ"
  fi
  printf 'decoration { box-shadow: none; margin: 0; border-radius: 0; }\n' >>"$GTK_CSS"
  echo "  $GTK_CSS"
fi

systemctl --user daemon-reload || exit 1
systemctl --user enable "$UNIT_NAME" || exit 1
echo "  đã enable"

# Without linger the user manager stops the moment the last login session ends, which on a kiosk
# means the app never survives a logout. `sudo -n` never prompts: when it cannot authenticate we
# must say so and exit non-zero, because a half-done install silently fails to boot the kiosk.
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" = "yes" ]; then
  echo "  linger đã bật từ trước"
elif run_sudo loginctl enable-linger "$USER" 2>/dev/null; then
  echo "  đã bật linger cho $USER"
else
  echo "  CHƯA bật được linger (cần sudo). Chạy riêng:" >&2
  echo "    sudo loginctl enable-linger $USER" >&2
  echo "  Unit đã enable nên kiosk vẫn chạy sau khi đăng nhập, nhưng KHÔNG tự chạy khi chưa ai đăng nhập." >&2
  exit 1
fi

echo
echo "Xong. Từ lần khởi động sau máy sẽ tự vào kiosk."
echo "  xem trạng thái: systemctl --user status $UNIT_NAME"
echo "  dừng tạm:      systemctl --user stop $UNIT_NAME"
echo "  gỡ hẳn:        ./scripts/uninstall-autostart.sh --apply"
