#!/usr/bin/env bash
# ntf-maintenance.sh — cập nhật toàn bộ gói của máy kiosk, chạy bằng systemd timer.
#
# Vì sao theo lịch 03:00 Chủ nhật, KHÔNG theo lúc bật máy và KHÔNG theo lúc tắt máy:
#   * Bật máy rồi mới vào giao diện: `upgrade` mất 1–15 phút tuỳ số gói và tốc độ mạng, nên màn hình
#     đứng im đúng lúc người dùng muốn dùng. Nếu mạng chưa lên (DHCP chậm) thì lần chạy đó hỏng luôn,
#     mà người dùng lại phải chờ vô ích. `Persistent=true` đã bù được lần chạy bị lỡ khi máy tắt.
#   * Trước khi tắt máy: systemd không bảo đảm `Before=shutdown.target` chạy xong trước khi cắt điện
#     (người dùng bấm nút nguồn, mất điện, hoặc `shutdown -t`). `dpkg` bị cắt giữa chừng để lại cơ sở
#     dữ liệu gói hỏng — hỏng theo kiểu phải cứu bằng tay, không có lợi gì bù lại.
#   * 03:00 Chủ nhật: máy đang khoá màn hình, không ai chạm, mạng vẫn sống, và có cả tuần để người
#     dùng phát hiện hậu quả nếu một gói nào đó làm hỏng giao diện.
#
#   ./scripts/ntf-maintenance.sh --check     # chỉ báo cáo, không đổi gì (dùng khi khảo sát)
#   ./scripts/ntf-maintenance.sh             # cập nhật thật (đây là thứ timer gọi)
#   ./scripts/ntf-maintenance.sh --no-restart  # cập nhật nhưng không khởi động lại kiosk
#
# Đầu ra cho giao diện: /var/lib/ntf/update-status.json (0644, đọc được từ tiến trình kiosk).
set -uo pipefail

MODE=update
RESTART_KIOSK=1
for arg in "$@"; do
  case "$arg" in
    --check | --dry-run) MODE=check ;;
    --no-restart) RESTART_KIOSK=0 ;;
    -h | --help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      echo "tham số lạ: $arg" >&2
      exit 2
      ;;
  esac
done

LOG=/var/log/ntf-maintenance.log
STATE_DIR=/var/lib/ntf
LOCK=/run/ntf-maintenance.lock
KIOSK_USER="${NTF_KIOSK_USER:-${SUDO_USER:-kiosk}}"
KIOSK_UNIT=ntfitness-kiosk.service
# Trạng thái cho giao diện do một script riêng ghi, để chỉ có một chỗ sinh JSON.
STATUS_HELPER="${NTF_STATUS_HELPER:-/usr/local/sbin/ntf-update-status}"

log() {
  local line
  line="$(date '+%Y-%m-%d %H:%M:%S') $*"
  printf '%s\n' "$line"
  printf '%s\n' "$line" >>"$LOG" 2>/dev/null
}

write_status() {
  mkdir -p "$STATE_DIR" 2>/dev/null
  if [ -x "$STATUS_HELPER" ]; then
    "$STATUS_HELPER" "$@" || log "CẢNH BÁO: không ghi được trạng thái cập nhật"
  else
    log "CẢNH BÁO: thiếu $STATUS_HELPER"
  fi
}

# Một lần chạy tại một thời điểm: hai timer (hoặc timer + người bấm "Bảo trì") cùng lúc sẽ tranh
# khoá dpkg. `-n` để lần thứ hai thoát ngay thay vì xếp hàng — lần chạy kia đã làm việc đó rồi.
exec 9>"$LOCK" 2>/dev/null || true
if ! flock -n 9; then
  log "bỏ qua: một lần bảo trì khác đang chạy"
  exit 0
fi

log "=== bắt đầu (chế độ $MODE) ==="

if [ "$(id -u)" -ne 0 ]; then
  log "LỖI: phải chạy bằng root (unit hệ thống gọi bằng root)"
  write_status "error" 0 0 "phải chạy bằng root"
  exit 1
fi

# Cổng mạng: `apt-get update` khi mất mạng sẽ ghi đè danh sách gói bằng bản rỗng một cách im lặng.
# Kiểm ba thứ rẻ tiền: có route mặc định, phân giải được tên, và mở được TCP tới kho.
net_ok() {
  ip route get 1.1.1.1 >/dev/null 2>&1 || return 1
  getent hosts archive.ubuntu.com >/dev/null 2>&1 || return 1
  timeout 20 bash -c 'exec 3<>/dev/tcp/archive.ubuntu.com/80' >/dev/null 2>&1 || return 1
  return 0
}

if ! net_ok; then
  log "bỏ qua: chưa có mạng (route/DNS/TCP tới archive.ubuntu.com thất bại)"
  write_status "offline" 0 0 "chưa có mạng, lần chạy sau sẽ thử lại"
  exit 0
fi

# Không có cờ tương tác nào được phép chạm tới: timer không có terminal, nên một câu hỏi của dpkg
# hay của needrestart sẽ treo tiến trình cho tới khi bị kill ở TimeoutStartSec.
export DEBIAN_FRONTEND=noninteractive
export APT_LISTCHANGES_FRONTEND=none
export NEEDRESTART_MODE=l
APT_OPTS=(
  -y
  -o Dpkg::Options::=--force-confdef
  -o Dpkg::Options::=--force-confold
  -o DPkg::Lock::Timeout=600
)

log "apt-get update"
if ! apt-get update >>"$LOG" 2>&1; then
  log "LỖI: apt-get update thất bại"
  write_status "error" 0 0 "apt-get update thất bại, xem $LOG"
  exit 1
fi

PENDING_BEFORE=$(apt-get -s upgrade 2>/dev/null | grep -c '^Inst ' || true)
log "số gói chờ nâng cấp: ${PENDING_BEFORE:-0}"
PENDING_PKGS=$(apt-get -s upgrade 2>/dev/null | sed -n 's/^Inst \([^ ]*\) .*/\1/p' || true)

if [ "$MODE" = "check" ]; then
  reboot=0
  [ -e /var/run/reboot-required ] && reboot=1
  # shellcheck disable=SC2086 # danh sách gói phải tách thành nhiều tham số
  write_status "check" "${PENDING_BEFORE:-0}" "$reboot" "chế độ chỉ báo cáo" $PENDING_PKGS
  log "=== kết thúc (chỉ báo cáo) ==="
  exit 0
fi

if [ "${PENDING_BEFORE:-0}" -eq 0 ]; then
  log "không có gì để nâng cấp"
  reboot=0
  [ -e /var/run/reboot-required ] && reboot=1
  write_status "noop" 0 "$reboot" "đã là bản mới nhất"
  log "=== kết thúc ==="
  exit 0
fi

# Đầu ra của riêng lần chạy này ghi ra tệp tạm rồi mới nối vào $LOG: $LOG là tệp chỉ-thêm của mọi
# lần chạy, nên đếm `Setting up` trên $LOG sẽ cộng dồn từ nhiều tháng trước và báo sai số gói.
RUNLOG=$(mktemp /tmp/ntf-upgrade.XXXXXX)
trap 'rm -f "$RUNLOG"' EXIT

log "apt-get upgrade"
if ! apt-get "${APT_OPTS[@]}" upgrade >"$RUNLOG" 2>&1; then
  cat "$RUNLOG" >>"$LOG"
  log "LỖI: apt-get upgrade thất bại — KHÔNG khởi động lại kiosk"
  write_status "error" 0 0 "apt-get upgrade thất bại, xem $LOG"
  exit 1
fi
cat "$RUNLOG" >>"$LOG"

# `autoremove` chỉ sau khi upgrade thành công, và không `--purge`: một gói bị coi là "tự cài" nhưng
# thật ra cần cho kiosk (ví dụ driver màn hình cảm ứng) sẽ mất luôn nếu purge kèm cấu hình.
log "apt-get autoremove"
apt-get "${APT_OPTS[@]}" autoremove >>"$RUNLOG" 2>&1 || log "CẢNH BÁO: autoremove thất bại (bỏ qua)"
cat "$RUNLOG" >>"$LOG"

CHANGED=$(grep -c '^Setting up ' "$RUNLOG" 2>/dev/null || true)
PKGS=$(grep '^Setting up ' "$RUNLOG" 2>/dev/null | sed 's/^Setting up \([^ ]*\) .*/\1/' | sort -u || true)
REBOOT=0
[ -e /var/run/reboot-required ] && REBOOT=1
log "gói đã nâng cấp: ${CHANGED:-0}; cần khởi động lại máy: $REBOOT"

# Nâng cấp thư viện đồ hoạ/âm thanh/font mà tiến trình Electron đang giữ trong bộ nhớ thì bản mới chỉ
# có hiệu lực sau khi tiến trình chết đi. Khởi động lại kiosk ngay tại 03:00 là vô hại (máy đang khoá)
# và tránh được cảnh "đã cập nhật mà lỗi cũ vẫn còn" kéo dài tới lần bật máy sau.
if [ "$RESTART_KIOSK" -eq 1 ] && [ "${CHANGED:-0}" -gt 0 ]; then
  UID_KIOSK=$(id -u "$KIOSK_USER" 2>/dev/null || true)
  if [ -n "$UID_KIOSK" ] && [ -d "/run/user/$UID_KIOSK" ]; then
    log "khởi động lại $KIOSK_UNIT"
    if runuser -u "$KIOSK_USER" -- env XDG_RUNTIME_DIR="/run/user/$UID_KIOSK" \
      systemctl --user restart "$KIOSK_UNIT" >>"$LOG" 2>&1; then
      sleep 5
      state=$(runuser -u "$KIOSK_USER" -- env XDG_RUNTIME_DIR="/run/user/$UID_KIOSK" \
        systemctl --user is-active "$KIOSK_UNIT" 2>/dev/null || true)
      log "trạng thái sau khởi động lại: ${state:-không rõ}"
    else
      log "CẢNH BÁO: không khởi động lại được $KIOSK_UNIT"
    fi
  else
    log "bỏ qua khởi động lại: không thấy user manager của $KIOSK_USER"
  fi
fi

if [ "$REBOOT" -eq 1 ]; then
  # shellcheck disable=SC2086
  write_status "ok" "${CHANGED:-0}" 1 "đã cập nhật, cần khởi động lại máy" $PKGS
else
  # shellcheck disable=SC2086
  write_status "ok" "${CHANGED:-0}" 0 "đã cập nhật" $PKGS
fi
log "=== kết thúc ==="
