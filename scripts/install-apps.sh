#!/usr/bin/env bash
# install-apps.sh — opt in to the two desktop applications the dock can launch.
#
#   FreeTube  https://github.com/FreeTubeApp/FreeTube — AGPL-3.0, installed as a Debian package.
#             Chosen over the AppImage because AppImage needs FUSE, which this box does not have.
#   Firefox   snap — the kiosk only ever starts it as a normal window, never as the session shell.
#
# Both are OPTIONAL: the dock works without them and the "browser" item falls back to Chromium.
# Nothing here starts a daemon, changes a driver, or touches Phase 1 configuration.
#
#   ./scripts/install-apps.sh              # report only
#   ./scripts/install-apps.sh --apply      # install both
#   ./scripts/install-apps.sh --apply --only freetube
set -uo pipefail

APPLY=0
ONLY="both"
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --only)
      ONLY="${2:-both}"
      shift
      ;;
    -h | --help)
      sed -n '2,15p' "$0"
      exit 0
      ;;
    *)
      echo "tham số lạ: $1" >&2
      exit 2
      ;;
  esac
  shift
done

if [ "$(id -u)" -eq 0 ]; then
  echo "chạy bằng tài khoản thường; script tự gọi sudo khi cần" >&2
  exit 1
fi

FREE_TUBE_PATTERN='freetube'

# Over SSH there is no terminal, so plain `sudo` cannot prompt. `sudo -n` succeeds when the caller
# already has a valid timestamp; otherwise we pipe NTF_SUDO_PASS into `sudo -S`. Neither path ever
# writes the password to a file or the log — it only travels through this function's stdin.
run_sudo() {
  if [ -n "${NTF_SUDO_PASS:-}" ]; then
    printf '%s\n' "$NTF_SUDO_PASS" | sudo -S -p '' "$@"
  else
    sudo -n "$@"
  fi
}

have_freetube() { command -v freetube >/dev/null 2>&1; }
have_firefox() { command -v firefox >/dev/null 2>&1; }

echo "=== Hiện trạng ==="
have_freetube && echo "  FreeTube: $( (freetube --version 2>/dev/null || echo 'đã cài') | head -1)" || echo "  FreeTube: chưa cài"
have_firefox && echo "  Firefox:  $(firefox --version 2>/dev/null | head -1)" || echo "  Firefox:  chưa cài"

if [ "$APPLY" -eq 0 ]; then
  echo
  echo "Chưa cài gì. Chạy lại với --apply để cài."
  exit 0
fi

wanted_freetube=0
wanted_firefox=0
case "$ONLY" in
  both) wanted_freetube=1; wanted_firefox=1 ;;
  freetube) wanted_freetube=1 ;;
  firefox) wanted_firefox=1 ;;
  *)
    echo "--only chỉ nhận: both | freetube | firefox" >&2
    exit 2
    ;;
esac

if [ "$wanted_freetube" -eq 1 ] && ! have_freetube; then
  echo
  echo "=== Cài FreeTube ==="
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  # Read the release metadata rather than hard-coding a version, so this keeps working when the
  # project ships a new beta. FreeTube tags every release as a pre-release, hence no /latest call.
  url=$(curl -fsSL https://api.github.com/repos/FreeTubeApp/FreeTube/releases \
    | grep -o 'https://[^"]*_amd64\.deb' | head -1)
  if [ -z "$url" ]; then
    echo "  không tìm được gói .deb trong release mới nhất" >&2
  else
    echo "  tải $(basename "$url")"
    if curl -fsSL -o "$tmp/freetube.deb" "$url"; then
      run_sudo apt-get install -y "$tmp/freetube.deb" || echo "  cài thất bại — bỏ qua FreeTube" >&2
      have_freetube && echo "  xong: $(command -v freetube)"
    else
      echo "  tải thất bại" >&2
    fi
  fi
  trap - EXIT
  rm -rf "$tmp"
fi

if [ "$wanted_firefox" -eq 1 ] && ! have_firefox; then
  echo
  echo "=== Cài Firefox (snap) ==="
  run_sudo snap install firefox || echo "  cài thất bại — bỏ qua Firefox" >&2
fi

echo
echo "=== Sau khi cài ==="
have_freetube && echo "  FreeTube: OK" || echo "  FreeTube: KHÔNG có"
have_firefox && echo "  Firefox:  OK" || echo "  Firefox:  KHÔNG có"
echo
echo "FreeTube là AGPL-3.0: nếu phát hành bản sửa đổi của nó, phải công bố mã nguồn theo AGPL."
echo "Bản FreeTube hiện tại là bản beta — dùng làm bản thử, không phải bản production."
