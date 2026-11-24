#!/usr/bin/env bash
# ntf-adblock-status.sh — ghi số liệu AdGuard Home ra một tệp JSON công khai để app đọc.
#
# Chạy bằng root qua systemd timer (scripts/install-adguard-status.sh). Vì sao phải đi đường
# vòng này thay vì để app tự gọi API:
#   /control/stats trả 401 nếu không đăng nhập, và mật khẩu AdGuard nằm ở tệp chỉ root đọc
#   được. Nhét mật khẩu đó vào tiến trình Electron của người dùng kiosk là mở một đường
#   ghi vào cấu hình DNS của cả nhà từ một cửa sổ duyệt web. Ở đây tiến trình root đọc bí mật,
#   còn app chỉ thấy một tệp JSON toàn đọc.
set -uo pipefail

CFG=${NTF_AGH_CFG:-/root/ntf-adguard-admin.txt}
OUT=${NTF_ADBLOCK_STATUS:-/var/lib/ntf/adblock-status.json}

# Địa chỉ UI quản trị nằm trong chính cấu hình AdGuard, nên đọc từ đó thay vì chép IP vào ba nơi.
# Dòng cần tìm: `  address: 192.168.1.100:3000`.
AGH_CFG=${NTF_AGH_CONFIG:-/var/lib/AdGuardHome/AdGuardHome.yaml}
ADMIN_URL=""
if [ -r "$AGH_CFG" ]; then
  ADDR=$(sed -n 's/^[[:space:]]*address:[[:space:]]*//p' "$AGH_CFG" | head -1)
  case "$ADDR" in
    *:*) ADMIN_URL="http://${ADDR}" ;;
  esac
fi
URL=${NTF_AGH_URL:-${ADMIN_URL:-http://192.168.1.100:3000}}

# Tệp bí mật có dạng: dòng `password: xxx`. Không in ra log trong mọi trường hợp.
[ -r "$CFG" ] || {
  echo "không đọc được $CFG — cài AdGuard trước" >&2
  exit 1
}
PW=$(sed -n 's/^password: //p' "$CFG" | head -1)
[ -n "$PW" ] || {
  echo "không tìm thấy mật khẩu trong $CFG" >&2
  exit 1
}

mkdir -p "$(dirname "$OUT")" || exit 1
TMP=$(mktemp "${OUT}.XXXXXX") || exit 1
trap 'rm -f "$TMP"' EXIT

RAW=$(curl -fsS --max-time 8 -u "admin:$PW" "$URL/control/stats" 2>/dev/null)

if [ -z "$RAW" ]; then
  # Giữ nguyên số liệu cũ nhưng đánh dấu mất kết nối, để panel hiện "—" thay vì 0.
  printf '{"ok":false,"at":%s,"adminUrl":"%s"}\n' "$(date +%s)" "$ADMIN_URL" >"$TMP"
else
  NTF_RAW="$RAW" NTF_AT=$(date +%s) NTF_ADMIN_URL="$ADMIN_URL" python3 - "$TMP" <<'PY' || exit 1
import json, os, sys
d = json.loads(os.environ["NTF_RAW"])

def top(key, limit=5):
    # AdGuard trả [{"domain": count}, ...] — đổi thành [[domain, count], ...] cho gọn.
    out = []
    for item in d.get(key) or []:
        for name, count in item.items():
            out.append([name, int(count)])
    out.sort(key=lambda pair: pair[1], reverse=True)
    return out[:limit]

queries = int(d.get("num_dns_queries") or 0)
blocked = int(d.get("num_blocked_filtering") or 0)
payload = {
    "ok": True,
    "at": int(os.environ["NTF_AT"]),
    "queries": queries,
    "blocked": blocked,
    # Tính ở đây chứ không ở renderer: một phép chia cho 0 trong renderer làm hỏng cả thẻ.
    "percent": round(blocked * 100.0 / queries, 1) if queries else 0.0,
    "topBlocked": top("top_blocked_domains"),
    "topQueried": top("top_queried_domains"),
    "topClients": top("top_clients"),
    "adminUrl": os.environ.get("NTF_ADMIN_URL") or "",
}
with open(sys.argv[1], "w", encoding="utf-8") as fh:
    json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    fh.write("\n")
PY
fi

# os.replace qua python để không bao giờ có tệp JSON cụt giữa hai lần ghi.
python3 - "$TMP" "$OUT" <<'PY' || exit 1
import os, sys
os.chmod(sys.argv[1], 0o644)
os.replace(sys.argv[1], sys.argv[2])
PY
