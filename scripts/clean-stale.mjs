import { rmSync, existsSync } from 'node:fs';
for (const stale of ['dist/main/preload-nav.js', 'dist/main/preload-nav.js.map']) {
  if (existsSync(stale)) rmSync(stale);
}
