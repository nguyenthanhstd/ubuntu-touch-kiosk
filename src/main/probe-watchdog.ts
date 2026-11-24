// Proves the media watchdog works end to end: open the curated embed, which on this network never
// receives media (googlevideo returns 403), and confirm the application raises the visitor-facing
// error screen instead of leaving a black rectangle.
//   electron dist/main/main.js --ntf-dev --ntf-probe-watchdog
import { app } from 'electron';
import type { ViewManager } from './view-manager.js';

const VIDEO_ID = 'aqz-KE-bpKQ';
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function runWatchdogProbe(views: ViewManager): Promise<void> {
  let passed = 0;
  let total = 0;
  const record = (name: string, ok: boolean, detail: string): void => {
    total += 1;
    if (ok) passed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} :: ${detail}`);
  };

  try {
    await wait(3000);

    // The curated embed on this network: media never arrives, so after ~30 s the watchdog must
    // surface the ordinary error screen with a retry affordance.
    await views.openCurated(VIDEO_ID);
    const seen: string[] = [];
    for (let i = 0; i < 9; i += 1) {
      await wait(5000);
      const state = views.state();
      seen.push(`${i * 5 + 5}s:${state.failed ? `failed(${state.failed.code})` : 'ok'}`);
      if (state.failed?.code === -4) break;
    }
    const state = views.state();
    record(
      'Watchdog báo lỗi khi embed không có media',
      state.failed?.code === -4,
      `failed=${JSON.stringify(state.failed)} diễn biến=${seen.join(' ')}`,
    );

    // Leave the screen in the state a visitor would get, so the operator can look at it.
    console.log('      giữ màn hình lỗi trên panel; dừng bằng scripts/stop.sh');
    app.exit(passed === total ? 0 : 1);
  } catch (error) {
    console.log(`ERROR ${(error as Error).message}`);
    app.exit(1);
  }
}
