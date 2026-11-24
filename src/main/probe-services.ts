// Service probe. Answers the Phase 2 §C/§D questions that a static fetch cannot: does each site
// really load and play inside Electron on the kiosk, and does it demand a login?
//   electron dist/main/main.js --ntf-dev --ntf-probe-services
import { app, screen } from 'electron';
import type { ViewManager } from './view-manager.js';
import type { ServiceId } from '../shared/services.js';

const results: Array<{ name: string; pass: boolean; detail: string }> = [];

function record(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} :: ${detail}`);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PageFacts {
  title: string;
  textLen: number;
  videos: number;
  loginWords: string[];
  preview: string;
}

const INSPECT = `(() => {
  const text = ((document.body && document.body.innerText) || '').toLowerCase();
  const words = ['log in', 'sign in', 'đăng nhập', 'sign up', 'create new account'];
  return JSON.stringify({
    title: document.title,
    textLen: text.length,
    videos: document.querySelectorAll('video').length,
    loginWords: words.filter((w) => text.includes(w)),
    preview: text.slice(0, 130).replace(/\\s+/g, ' '),
  });
})()`;

async function inspect(contents: Electron.WebContents | null): Promise<PageFacts | null> {
  if (!contents) return null;
  const raw = (await contents
    .executeJavaScript(INSPECT, true)
    .catch((error: Error) => JSON.stringify({ title: `«error: ${error.message}»`, textLen: 0, videos: 0, loginWords: [], preview: '' }))) as string;
  return JSON.parse(raw) as PageFacts;
}

/** Counts video elements that are actually playing right now. */
const PLAYING = `(() => {
  const vs = [...document.querySelectorAll('video')];
  return JSON.stringify({
    total: vs.length,
    playing: vs.filter((v) => !v.paused && v.currentTime > 0 && v.readyState >= 2).length,
    width: vs.length ? vs[0].videoWidth : 0,
    height: vs.length ? vs[0].videoHeight : 0,
  });
})()`;

export async function runServiceProbe(views: ViewManager): Promise<void> {
  try {
    await wait(2000);

    const display = screen.getPrimaryDisplay();
    record(
      'Cửa sổ phủ đúng panel 2560x1600',
      display.size.width === 2560 && display.size.height === 1600,
      `bounds=${display.size.width}x${display.size.height} scale=${display.scaleFactor}`,
    );

    const targets: ServiceId[] = ['instagram', 'facebook', 'youtube', 'tiktok'];
    for (const service of targets) {
      await views.open(service);
      await wait(11000);
      const state = views.state();
      const facts = await inspect(views.serviceContents);
      record(
        `${service}: trang tải được trên máy thật`,
        state.failed === null && facts !== null && facts.textLen > 0,
        `host=${state.currentHost} title="${(facts?.title ?? '').slice(0, 44)}" text=${facts?.textLen ?? 0} video=${facts?.videos ?? 0} login=${JSON.stringify(facts?.loginWords ?? [])}`,
      );
      if (facts) console.log(`      ${service} nội dung: ${facts.preview}`);

      const needsLogin = (facts?.loginWords.length ?? 0) > 0;
      record(
        `${service}: nêu rõ có bắt đăng nhập hay không`,
        true,
        needsLogin ? `BẮT ĐĂNG NHẬP (${facts?.loginWords.join(', ')})` : 'không thấy dấu hiệu bắt đăng nhập',
      );

      if (views.serviceContents) {
        const play = JSON.parse(
          (await views.serviceContents
            .executeJavaScript(PLAYING, true)
            .catch(() => '{"total":0,"playing":0,"width":0,"height":0}')) as string,
        ) as { total: number; playing: number; width: number; height: number };
        record(
          `${service}: video có tự phát`,
          play.playing > 0,
          `${play.playing}/${play.total} đang phát, khung ${play.width}x${play.height}`,
        );
      }

      await views.stopMedia();
      views.goHome();
      await wait(700);
    }
  } catch (error) {
    record('Probe dịch vụ chạy không lỗi', false, (error as Error).stack ?? String(error));
  } finally {
    const failed = results.filter((r) => !r.pass).length;
    console.log(`\n=== ${results.length - failed}/${results.length} kiểm tra dịch vụ PASS ===`);
    for (const r of results.filter((x) => !x.pass)) console.log(`   FAILED: ${r.name} :: ${r.detail}`);
    app.exit(0);
  }
}
