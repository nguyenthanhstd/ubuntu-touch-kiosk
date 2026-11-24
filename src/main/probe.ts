// Automated runtime probe. Drives the real prototype shell (real Chromium, real network, real
// session partitions) and prints assertions, so PASS/FAIL does not depend on someone eyeballing
// a screenshot.
//   npx electron dist/main/main.js --ntf-dev --ntf-probe
import { app } from 'electron';
import type { ViewManager } from './view-manager.js';

const results: Array<{ name: string; pass: boolean; detail: string }> = [];

function record(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} :: ${detail}`);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function evalJson(contents: Electron.WebContents, expression: string): Promise<unknown> {
  // Wrapping the expression directly (instead of embedding it as a string) keeps arbitrary
  // expressions valid: parentheses and quotes inside quoted literals cannot break the wrapper.
  const source = `(async () => { try { return JSON.stringify(await (${expression})); } catch (e) { return JSON.stringify({ error: String((e && e.message) || e) }); } })()`;
  const raw = (await contents.executeJavaScript(source, true)) as string;
  return JSON.parse(raw);
}

export async function runProbe(views: ViewManager): Promise<void> {
  try {
    await wait(1800);

    const legacy = (await evalJson(
      views.navContents,
      `({ home: !!document.querySelector('.home, .tile, #tiles, .wallpaper'), layer: !!document.querySelector('.wallpaper-layer') })`,
    )) as { home: boolean; layer: boolean };
    record('Trang Home chỉ còn hình nền, không còn khối nội dung', legacy.home === false && legacy.layer === true, JSON.stringify(legacy));

    const bar = (await evalJson(
      views.topContents,
      `(() => {
        const s = document.querySelector('.bar-surface');
        const r = s.getBoundingClientRect();
        const st = getComputedStyle(s);
        const c = document.querySelector('.clock').getBoundingClientRect();
        return {
          h: Math.round(r.height), w: Math.round(r.width),
          r4: [st.borderTopLeftRadius, st.borderTopRightRadius, st.borderBottomLeftRadius, st.borderBottomRightRadius].map(parseFloat),
          clockMid: (c.left + c.right) / 2, mid: window.innerWidth / 2,
        };
      })()`,
    )) as { h: number; w: number; r4: number[]; clockMid: number; mid: number };
    record(
      'Thanh trên bo cả 4 góc và đồng hồ nằm giữa',
      bar.w > 800 && bar.h === 44 && bar.r4.every((r) => r >= 18) && Math.abs(bar.clockMid - bar.mid) <= 2,
      JSON.stringify(bar),
    );

    const sizes = (await evalJson(
      views.dockContents,
      `[...document.querySelectorAll('.dock-item')].map(b => { const r = b.getBoundingClientRect(); return { id: b.dataset.key, w: Math.round(r.width), h: Math.round(r.height) }; })`,
    )) as Array<{ id: string; w: number; h: number }>;
    const tooSmall = sizes.filter((s) => s.w < 72 || s.h < 72);
    record(
      'Nút chính >= 72 CSS px',
      sizes.length >= 8 && tooSmall.length === 0,
      `${sizes.length} nút, ${tooSmall.length} nút nhỏ hơn 72px ${JSON.stringify(tooSmall)}`,
    );

    const bridge = (await evalJson(
      views.navContents,
      `({ hasApi: typeof window.ntf, require: typeof window.require, process: typeof window.process, module: typeof window.module, glob: typeof window.global })`,
    )) as Record<string, string>;
    record(
      'Không lộ require/process ra trang (contextIsolation)',
      bridge.hasApi === 'object' && bridge.require === 'undefined' && bridge.process === 'undefined' && bridge.glob === 'undefined',
      JSON.stringify(bridge),
    );

    const news = (await evalJson(
      views.navContents,
      `window.ntf.news.load('top').then(r => ({ status: r.status, n: r.items.length, src: (r.items[0]||{}).source || '', first: ((r.items[0]||{}).title || '').slice(0, 60) }))`,
    )) as { status: string; n: number; src: string; first: string };
    record('Google News RSS (Nổi bật) tải thật', news.status !== 'error' && news.n > 0, JSON.stringify(news));

    const nation = (await evalJson(
      views.navContents,
      `window.ntf.news.load('nation').then(r => ({ status: r.status, n: r.items.length }))`,
    )) as { status: string; n: number };
    record('RSS chuyên mục Việt Nam', nation.status !== 'error' && nation.n > 0, JSON.stringify(nation));

    const zoomed = (await evalJson(
      views.navContents,
      `window.ntf.nav.setUiZoom('large').then(s => s)`,
    )) as { uiZoom: string };
    record('Lưu cỡ chữ (uiZoom)', zoomed.uiZoom === 'large', JSON.stringify(zoomed));
    await views.navContents.executeJavaScript(`window.ntf.nav.setUiZoom('normal')`, true);

    const blocked = (await evalJson(
      views.navContents,
      `window.ntf.news.openArticle('file:///etc/shadow').then(ok => ok)`,
    )) as boolean;
    record('Chặn mở file:// nội bộ', blocked === false, `openArticle(file:///etc/shadow) => ${blocked}`);

    const jsUrl = (await evalJson(
      views.navContents,
      `window.ntf.news.openArticle('javascript:alert(1)').then(ok => ok)`,
    )) as boolean;
    record('Chặn giao thức javascript:', jsUrl === false, `=> ${jsUrl}`);

    await views.open('youtube');
    await wait(9000);
    const youtubeState = views.state();
    let youtubeInfo = '{"error":"no view"}';
    if (views.serviceContents) {
      youtubeInfo = (await views.serviceContents
        .executeJavaScript(
          `JSON.stringify({ title: document.title, videos: document.querySelectorAll('video').length, textLen: document.body.innerText.length })`,
          true,
        )
        .catch((error: Error) => JSON.stringify({ error: error.message }))) as string;
    }
    record(
      'YouTube tải được trong Electron',
      /youtube/i.test(youtubeState.title) && youtubeState.failed === null,
      `title="${youtubeState.title}" host="${youtubeState.currentHost}" ${youtubeInfo.slice(0, 220)}`,
    );

    const partition = views.serviceContents?.session.getStoragePath() ?? '';
    record('Session YouTube tách riêng', /ntf-youtube/i.test(partition), partition || '(empty)');

    const zoomApi = (await evalJson(
      views.navContents,
      `(window.ntf.nav.zoom(1), window.ntf.nav.getState()).then((s) => ({ zoom: s.zoom }))`,
    )) as { zoom: string | null };
    record('Zoom dịch vụ qua IPC', typeof zoomApi.zoom === 'string' && zoomApi.zoom.length > 0, JSON.stringify(zoomApi));
    await evalJson(views.navContents, `(window.ntf.nav.zoomReset(), 1)`);

    await views.stopMedia();
    views.goHome();
    await wait(800);
    record('Về Home hủy view dịch vụ', views.state().serviceId === null, JSON.stringify(views.state()));

    await views.open('tiktok');
    await wait(9000);
    const tiktokState = views.state();
    record(
      'TikTok: tải được hoặc có màn hình lỗi + thử lại',
      tiktokState.failed !== null || /tiktok/i.test(tiktokState.currentHost),
      `failed=${JSON.stringify(tiktokState.failed)} host="${tiktokState.currentHost}" title="${tiktokState.title}"`,
    );
    await views.stopMedia();
    views.goHome();
  } catch (error) {
    record('Probe chạy không lỗi', false, (error as Error).stack ?? String(error));
  } finally {
    const failed = results.filter((r) => !r.pass).length;
    console.log(`\n=== ${results.length - failed}/${results.length} kiểm tra PASS ===`);
    for (const r of results.filter((x) => !x.pass)) console.log(`   FAILED: ${r.name} :: ${r.detail}`);
    app.exit(failed === 0 ? 0 : 1);
  }
}
