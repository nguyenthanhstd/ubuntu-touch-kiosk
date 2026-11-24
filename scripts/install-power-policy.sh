#!/usr/bin/env bash
# install-power-policy.sh — cho phép menu Nguồn tắt máy và khởi động lại mà không hỏi mật khẩu.
#
# Vì sao cần: trên bản QA, `pkaction` trả `auth_admin_keep` cho `power-off`/`reboot`, tức là
# `systemctl poweroff` gọi từ ứng dụng sẽ **treo chờ xác thực** — mà panel không có bàn phím để gõ
# mật khẩu quản trị. Quy tắc polkit dưới đây chỉ mở đúng bốn hành động đó cho tiến trình kiosk của
# chính người dùng này, không mở gì khác:
#
#   * chỉ `login1.power-off*` và `login1.reboot*` — không mở `suspend`, không mở `set-wallpaper`;
#   * chỉ tiến trình của unit linger (đang hoạt động, không gắn phiên đăng nhập), nên một tiến trình
#     chạy qua SSH cũng không được hưởng;
#   * `polkit.Result.YES` **không** kèm `is_admin`, đúng như tài liệu polkit yêu cầu.
#
# Không có quy tắc nào cho "thoát ra console": hành động đó là `systemctl --user stop` trên unit của
# chính người dùng, không đi qua polkit, và đã được bảo vệ bằng mã PIN trong `main/pin-gate.ts`.
#
#   ./scripts/install-power-policy.sh            # chỉ báo cáo, không ghi gì
#   ./scripts/install-power-policy.sh --apply    # cài (cần sudo) rồi tự kiểm bằng pkcheck
#   ./scripts/install-power-policy.sh --remove   # gỡ
set -uo pipefail

APPLY=0
REMOVE=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --remove) REMOVE=1 ;;
    -h | --help)
      sed -n '2,22p' "$0"
      exit 0
      ;;
    *)
      echo "tham số lạ: $arg" >&2
      exit 2
      ;;
  esac
done

if [ "$(id -u)" -eq 0 ]; then
  echo "chạy bằng tài khoản thường (quy tắc mở quyền cho chính bạn, không cho root)" >&2
  exit 1
fi

RULE_NAME="49-ntfitness-kiosk-power.rules"
RULE_DIR="/etc/polkit-1/rules.d"
RULE_PATH="$RULE_DIR/$RULE_NAME"

# Over SSH there is no terminal, so `sudo` cannot prompt. Same contract as install-autostart.sh.
run_sudo() {
  if [ -n "${NTF_SUDO_PASS:-}" ]; then
    printf '%s\n' "$NTF_SUDO_PASS" | sudo -S -p '' "$@"
  else
    sudo -n "$@"
  fi
}

echo "=== Kiểm tra điều kiện ==="
if ! command -v pkaction >/dev/null 2>&1; then
  echo "  THIẾU pkaction — gói polkit chưa cài?" >&2
  exit 1
fi
echo "  polkit: $(pkaction --version 2>/dev/null | head -n 1)"

# Hai hành động thật sự cần mở. `pkaction` in ra id, nên hỏi thẳng nó thay vì đoán tên.
for action in org.freedesktop.login1.power-off org.freedesktop.login1.reboot; do
  if pkaction --action-id "$action" >/dev/null 2>&1; then
    echo "  $action: có"
  else
    echo "  $action: KHÔNG có — logind bản này không khai báo hành động đó" >&2
  fi
done

echo "  người dùng: $USER"
echo "  tệp đích:   $RULE_PATH"
if run_sudo test -f "$RULE_PATH" 2>/dev/null; then
  echo "  trạng thái: đã cài"
else
  echo "  trạng thái: chưa cài"
fi

if [ "$REMOVE" -eq 1 ]; then
  echo "=== Gỡ quy tắc ==="
  if ! run_sudo test -f "$RULE_PATH" 2>/dev/null; then
    echo "  không có gì để gỡ."
    exit 0
  fi
  if ! run_sudo rm -f "$RULE_PATH"; then
    echo "  KHÔNG gỡ được $RULE_PATH" >&2
    exit 1
  fi
  echo "  đã gỡ $RULE_PATH"
  echo "  nhớ: menu Nguồn sẽ hỏi mật khẩu quản trị trở lại, tức là nút Tắt máy sẽ báo lỗi trên panel."
  exit 0
fi

if [ "$APPLY" -ne 1 ]; then
  echo
  echo "Chưa ghi gì. Chạy lại với --apply để cài."
  exit 0
fi

# Nội dung quy tắc. Một hàm JS duy nhất, đúng khuôn polkit 0.106+: trả `undefined` là "không có ý
# kiến" (rơi về quy tắc mặc định của hệ), trả `polkit.Result.YES` mới là quyết định.
#
# Bốn điều kiện, tất cả đều phải đúng — thiếu một cái là quy tắc phải mở rộng hơn mức cần. Bốn thuộc
# tính dưới đây là toàn bộ những gì polkit JS cho biết về subject; nó **không** cho biết loại phiên
# (wayland/x11/tty).
#
# Đã đo trên panel chứ không suy đoán, vì hai lần đầu đều sai:
#   * `subject.session` là **null** với kiosk. Unit chạy nhờ linger nên Electron nằm trong
#     `user@1000.service` (logind session type `manager`, không seat) — không phải phiên đăng nhập
#     nào cả. Đòi `session` khác null thì quy tắc không bao giờ khớp, `pkcheck` trả rc=2.
#   * `subject.local` là **false** với chính tiến trình đó, cùng lý do trên (không seat, không phiên).
#     Vì vậy `local` cũng không dùng được để phân biệt "tại máy" với "qua SSH".
# Cái còn lại phân biệt được đúng: `subject.active` là true cho kiosk và false cho shell SSH, còn
# `subject.session` thì ngược lại — có với SSH, null với kiosk. Dùng cả hai:
#   1. đúng bốn hành động (`power-off` gồm cả `-multiple-sessions`, `reboot` tương tự);
#   2. đúng người dùng của kiosk, không phải root hay một tài khoản khác;
#   3. subject đang hoạt động;
#   4. **không** gắn với phiên đăng nhập nào — đây là tiến trình của unit linger. Một shell SSH thì
#      có session, nên bị loại ở đây.
read -r -d '' RULE_BODY <<RULEEOF
// 49-ntfitness-kiosk-power.rules — do scripts/install-power-policy.sh sinh ra, đừng sửa tay.
//
// Menu Nguồn của kiosk cần tắt máy và khởi động lại, mà panel không có bàn phím để gõ mật khẩu quản
// trị. Quy tắc này mở đúng bốn hành động đó cho tiến trình kiosk của đúng người dùng này.
// Gỡ bằng: scripts/install-power-policy.sh --remove

polkit.addRule(function (action, subject) {
  var allowed = [
    'org.freedesktop.login1.power-off',
    'org.freedesktop.login1.power-off-multiple-sessions',
    'org.freedesktop.login1.reboot',
    'org.freedesktop.login1.reboot-multiple-sessions'
  ];
  // Trả undefined chứ không phải NO: quy tắc này chỉ nới quyền cho đúng bốn hành động, mọi hành
  // động khác phải rơi về quy tắc mặc định của hệ chứ không bị chặn.
  if (allowed.indexOf(action.id) === -1) return undefined;

  if (subject.user !== '$USER') return undefined;
  // Kiosk chạy bằng linger nên không có phiên đăng nhập và không phải subject "local". Loại shell
  // SSH bằng đúng hai dấu hiệu ngược lại: nó có session, và nó không phải tiến trình đang hoạt động.
  if (subject.active !== true) return undefined;
  if (subject.session) return undefined;

  return polkit.Result.YES;
});
RULEEOF

TMP_RULE=$(mktemp)
trap 'rm -f "$TMP_RULE"' EXIT
printf '%s\n' "$RULE_BODY" >"$TMP_RULE"

echo "=== Cài quy tắc ==="
if ! run_sudo install -D -m 0644 -o root -g root "$TMP_RULE" "$RULE_PATH"; then
  echo "  KHÔNG ghi được $RULE_PATH" >&2
  exit 1
fi
echo "  đã ghi $RULE_PATH"

# polkit tự nạp lại thư mục rules.d trong vòng vài trăm ms, nhưng gọi `reload` cho chắc — không phải
# bản polkit nào cũng theo dõi inotify.
run_sudo systemctl reload polkit.service 2>/dev/null || run_sudo systemctl try-restart polkit.service 2>/dev/null || true

echo "=== Kiểm tra kết quả ==="
if run_sudo test -f "$RULE_PATH"; then
  echo "  tệp: có ($(run_sudo stat -c %s "$RULE_PATH" 2>/dev/null || echo '?') byte)"
else
  echo "  tệp: KHÔNG có" >&2
  exit 1
fi

# Tệp có trên đĩa chưa nói gì về việc quy tắc có khớp hay không — lần đầu tôi viết sai điều kiện,
# tệp vẫn nằm đó mà `pkcheck` vẫn trả rc=2. Nên kiểm bằng chính polkit.
KIOSK_PID=$(pgrep -f 'dist/main/main.js' | head -n 1)
if [ -n "$KIOSK_PID" ]; then
  for action in org.freedesktop.login1.power-off org.freedesktop.login1.reboot; do
    if pkcheck --action-id "$action" --process "$KIOSK_PID" >/dev/null 2>&1; then
      echo "  $action: được phép cho kiosk (pid $KIOSK_PID)"
    else
      echo "  $action: CHƯA được phép cho kiosk (pid $KIOSK_PID) — quy tắc chưa khớp" >&2
      STATUS=1
    fi
  done
  # Chốt an toàn: shell SSH phải bị từ chối, nếu không thì quy tắc đang mở quá rộng.
  if pkcheck --action-id org.freedesktop.login1.power-off --process $$ >/dev/null 2>&1; then
    echo "  CẢNH BÁO: shell hiện tại (pid $$) cũng được phép — quy tắc mở quá rộng" >&2
    STATUS=1
  else
    echo "  shell hiện tại (pid $$): vẫn bị từ chối, đúng"
  fi
else
  echo "  chưa thấy tiến trình kiosk (dist/main/main.js) — bỏ qua pkcheck" >&2
fi
exit "${STATUS:-0}"
