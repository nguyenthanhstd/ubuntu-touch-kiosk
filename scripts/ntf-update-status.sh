#!/usr/bin/env bash
# ntf-update-status.sh — ghi /var/lib/ntf/update-status.json, tệp mà giao diện kiosk đọc.
#
# Tách khỏi ntf-maintenance.sh vì hai lý do: script bảo trì cần dưới 200 dòng, và một chỗ duy nhất
# sinh JSON nghĩa là chỉ có một chỗ có thể sinh JSON hỏng.
#
#   ntf-update-status.sh <result> <upgradedCount> <rebootRequired 0|1> <note> [danh sách gói...]
#
# result: check | noop | ok | offline | error   (giao diện dịch sang tiếng Việt)
#
# Ghi qua python3 vì tên gói và câu lỗi có thể chứa nháy; tự viết bộ thoát chuỗi bằng bash là cách
# chắc chắn nhất để sinh ra JSON không đọc được.
set -uo pipefail

STATUS="${NTF_UPDATE_STATUS:-/var/lib/ntf/update-status.json}"

if [ "$#" -lt 4 ]; then
  echo "dùng: $0 <result> <upgradedCount> <rebootRequired 0|1> <note> [pkg...]" >&2
  exit 2
fi

mkdir -p "$(dirname "$STATUS")" 2>/dev/null || true

python3 - "$STATUS" "$@" <<'PY'
import json, os, sys, time

path = sys.argv[1]
result, changed, reboot, note = sys.argv[2:6]
packages = [p for p in sys.argv[6:] if p]

doc = {
    "lastRun": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    "lastRunEpoch": int(time.time()),
    "result": result,
    "upgradedCount": int(changed or 0),
    "rebootRequired": reboot == "1",
    "note": note,
    "packages": packages,
}

tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as fh:
    json.dump(doc, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
os.replace(tmp, path)
os.chmod(path, 0o644)
PY
