import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Only directories that still hold files. `home` and `news` were emptied when the in-page news
// reader was replaced by a Google News service view and the home grid was removed, so copying them
// would only create two empty folders in dist.
const copies = [
  ['src/renderer/nav', 'dist/renderer/nav'],
  ['src/renderer/shell', 'dist/renderer/shell'],
  ['src/renderer/keyboard', 'dist/renderer/keyboard'],
  ['src/renderer/frame', 'dist/renderer/frame'],
  ['src/renderer/player', 'dist/renderer/player'],
  // Trang màn hình chờ. Tách thư mục riêng chứ không nhét vào `shell`: nó là cửa sổ khác, nạp bằng
  // `LockOverlay` và chỉ có một cầu nối (`ntfLock`), nên để chung với thanh trên sẽ khiến người đọc
  // tưởng nó dùng chung `ntfChrome`.
  ['src/renderer/lock', 'dist/renderer/lock'],
  // Đồng hồ chữ số dùng chung (`clock-digits.css` / `.ts`) cho thanh trên và màn hình chờ. Phải copy
  // thì `lock.js` mới import được `../shared/clock-digits.js` bằng đường dẫn tương đối.
  ['src/renderer/shared', 'dist/renderer/shared'],
  // Bốn thẻ nổi: mỗi thẻ là một cửa sổ riêng (`panel-window.ts`) với một cầu nối riêng, nên mỗi thẻ
  // một thư mục. Thiếu một dòng ở đây thì trang đó `did-fail-load` và thẻ mở ra trống trơn.
  ['src/renderer/settings', 'dist/renderer/settings'],
  ['src/renderer/volume-panel', 'dist/renderer/volume-panel'],
  ['src/renderer/zoom-panel', 'dist/renderer/zoom-panel'],
  ['src/renderer/power', 'dist/renderer/power'],
  ['src/shared', 'dist/shared'],
  ['assets', 'dist/assets'],
];

// Assets are only ever produced by this script, so one whose source is gone is stale and must go.
// Compiled output (.js/.map) lives in the same folders and is NOT prunable — it has no source twin
// under src/, so wiping the destination wholesale would delete the renderer bundles.
const PRUNABLE = new Set(['.css', '.html', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.woff2', '.ttf', '.bak']);

const extname = (p) => p.slice(p.lastIndexOf('.')).toLowerCase();

const listFiles = async (dir, base = dir) => {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else out.push(relative(base, full));
  }
  return out;
};

const pruneStale = async (from, to) => {
  const wanted = new Set(await listFiles(resolve(root, from)));
  let removed = 0;
  for (const file of await listFiles(resolve(root, to))) {
    if (wanted.has(file) || !PRUNABLE.has(extname(file))) continue;
    await rm(join(resolve(root, to), file), { force: true });
    removed += 1;
  }
  return removed;
};

for (const [from, to] of copies) {
  await mkdir(resolve(root, to), { recursive: true });
  await cp(resolve(root, from), resolve(root, to), { recursive: true });
  const removed = await pruneStale(from, to);
  if (removed > 0) console.log(`pruned ${removed} stale asset(s) from ${to}`);
}

// Folders that no longer have a source at all: renderer/home and renderer/news went away with the
// in-page home grid and the RSS reader. pruneStale only walks files, so an empty leftover folder
// would otherwise survive every build and still be shipped.
for (const orphan of ['dist/renderer/home', 'dist/renderer/news']) {
  if (existsSync(resolve(root, orphan))) {
    await rm(resolve(root, orphan), { recursive: true, force: true });
    console.log(`removed orphaned folder ${orphan}`);
  }
}

console.log(`copied ${copies.length} asset groups into dist/`);
