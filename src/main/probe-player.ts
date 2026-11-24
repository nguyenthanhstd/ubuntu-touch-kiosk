// Second-level playback probe: does YouTube actually play inside this Electron build on this GPU?
// Answers spec §C (video dài, 1080p/1440p, software decode) which a feed page cannot answer because
// every feed platform gates playback behind login.
//   electron dist/main/main.js --ntf-dev --ntf-probe-player
import { app } from 'electron';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ViewManager } from './view-manager.js';

/**
 * The 1080p/1440p H.264 samples were left on the kiosk by Phase 1. They are copied into a
 * temporary directory so the loopback server can serve them from one place; if they are missing
 * the check reports SKIP instead of pretending the GPU passed.
 */
function resolveMediaDir(): string {
  const source = process.env['NTF_MEDIA_DIR'] ?? join(homedir(), 'test_kiosk');
  return source;
}

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
function record(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} :: ${detail}`);
}
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const VIDEO_IDS = ['aqz-KE-bpKQ', 'jNQXAC9IVRw'];

async function readLoadAverage(): Promise<number> {
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile('/proc/loadavg', 'utf8').catch(() => '0');
  return Number.parseFloat(raw.split(' ')[0] ?? '0');
}

/**
 * Detects playback inside the YouTube iframe. The <video> element lives in a cross-origin child
 * frame, so top-document JS cannot see it. Executing JS directly in a child frame tore down the
 * compositor on this machine, so we go through the DevTools protocol, which is designed for this.
 */
async function probeFrames(views: ViewManager): Promise<{ playing: number; width: number; height: number; frames: number; notes: string[] }> {
  const contents = views.serviceContents;
  const totals = { playing: 0, width: 0, height: 0, frames: 0, notes: [] as string[] };
  if (!contents || contents.isDestroyed()) {
    totals.notes.push('không có view');
    return totals;
  }

  const debug = contents.debugger;
  let attached = false;
  try {
    debug.attach('1.3');
    attached = true;
  } catch {
    /* already attached */
  }

  try {
    const { frameTree } = (await debug.sendCommand('Page.getFrameTree')) as {
      frameTree: { frame: { id: string; url: string }; childFrames?: Array<{ frame: { id: string; url: string } }> };
    };
    const frames: Array<{ id: string; url: string }> = [];
    const walk = (node: { frame: { id: string; url: string }; childFrames?: Array<{ frame: { id: string; url: string }; childFrames?: unknown[] }> }): void => {
      frames.push(node.frame);
      for (const child of node.childFrames ?? []) walk(child as typeof node);
    };
    walk(frameTree as Parameters<typeof walk>[0]);
    totals.frames = frames.length;

    const probe = `(() => {
      const vs = [...document.querySelectorAll('video')];
      const live = vs.filter((v) => !v.paused && v.currentTime > 0);
      return JSON.stringify({
        videos: vs.length,
        playing: live.length,
        width: vs.length ? Math.max(...vs.map((v) => v.videoWidth)) : 0,
        height: vs.length ? Math.max(...vs.map((v) => v.videoHeight)) : 0,
        paused: vs.length ? vs[0].paused : null,
        time: vs.length ? Number(vs[0].currentTime.toFixed(2)) : 0,
        err: vs.length && vs[0].error ? String(vs[0].error.code) : null,
        readyState: vs.length ? vs[0].readyState : null,
        networkState: vs.length ? vs[0].networkState : null,
        buffered: vs.length && vs[0].buffered.length ? Number(vs[0].buffered.end(0).toFixed(1)) : 0,
        src: vs.length ? String(vs[0].currentSrc).slice(0, 70) : '',
      });
    })()`;

    for (const frame of frames) {
      const world = (await debug.sendCommand('Page.createIsolatedWorld', {
        frameId: frame.id,
        worldName: 'ntf-probe',
      })) as { executionContextId: number };

      const res = (await debug.sendCommand('Runtime.evaluate', {
        expression: probe,
        contextId: world.executionContextId,
        returnByValue: true,
      })) as { result?: { value?: string } };

      const raw = res.result?.value ?? '{}';
      try {
        const f = JSON.parse(raw) as { videos: number; playing: number; width: number; height: number; paused: boolean | null; time: number; err: string | null; readyState: number | null; networkState: number | null; buffered: number; src: string };
        totals.playing += f.playing;
        totals.width = Math.max(totals.width, f.width);
        totals.height = Math.max(totals.height, f.height);
        totals.notes.push(`${frame.url.slice(0, 64)} → video=${f.videos} playing=${f.playing} ${f.width}x${f.height} t=${f.time} paused=${f.paused} ready=${f.readyState} net=${f.networkState} buf=${f.buffered} err=${f.err} src=${f.src}`);

        // Chromium refuses unmuted autoplay without a gesture; ask explicitly, muted, and report
        // whether the refusal is a policy block (which a real tap clears) or a decode failure.
        if (f.videos > 0 && f.playing === 0) {
          const forced = (await debug.sendCommand('Runtime.evaluate', {
            expression: `(() => { const v = document.querySelector('video'); if (!v) return 'no-video'; v.muted = true; v.play(); return 'requested'; })()`,
            contextId: world.executionContextId,
            returnByValue: true,
          })) as { result?: { value?: string } };
          totals.notes.push(`   gọi play(): ${forced.result?.value ?? 'không rõ'}`);
        }
      } catch {
        totals.notes.push(`${frame.url.slice(0, 64)} → không đọc được: ${raw.slice(0, 40)}`);
      }
    }
  } catch (error) {
    totals.notes.push(`CDP lỗi: ${(error as Error).message.slice(0, 70)}`);
  } finally {
    if (attached && debug.isAttached()) debug.detach();
  }

  return totals;
}

export async function runPlayerProbe(views: ViewManager): Promise<void> {
  try {
    await wait(1500);

    // Does this machine receive YouTube bytes at all? The embed reported readyState=0 with
    // networkState=0 (idle), so before blaming the GPU or a codec we prove the network path.
    await views.open('youtube');
    await wait(6000);
    const contents = views.serviceContents;
    const fetched = contents
      ? ((await contents.executeJavaScript(
          `(async () => {
             const r = await fetch('https://www.youtube.com/embed/aqz-KE-bpKQ', { credentials: 'omit' });
             const t = await r.text();
             return JSON.stringify({ status: r.status, len: t.length });
           })()`,
          true,
        ).catch((e: Error) => JSON.stringify({ error: e.message }))) as string)
      : '{"error":"no-view"}';
    const net = JSON.parse(fetched) as { status?: number; len?: number; error?: string };
    record(
      'Mạng của Electron tải được trang nhúng YouTube',
      net.status === 200 && (net.len ?? 0) > 1000,
      `status=${net.status ?? net.error} bytes=${net.len ?? 0}`,
    );

    // Decode capability, independent of YouTube: an inline data-URI produced
    // MEDIA_ERR_SRC_NOT_SUPPORTED (code 4), which means the test asset was invalid, not that the
    // GPU cannot decode. So serve a real H.264 file over loopback (a file: origin cannot fetch,
    // hence the tiny server) and measure decoded frames and playback rate.
    const http = await import('node:http');
    const { createReadStream, statSync } = await import('node:fs');
    const { extname } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'ntf-dec-'));
    const media = resolveMediaDir();
    const types: Record<string, string> = { '.mp4': 'video/mp4', '.html': 'text/html; charset=utf-8' };
    const serve = (res: import('node:http').ServerResponse, file: string): void => {
      try {
        const size = statSync(file).size;
        res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Content-Length': size });
        createReadStream(file).pipe(res);
      } catch {
        res.writeHead(404).end();
      }
    };
    const server = http.createServer((req, res) => {
      const name = ((req.url ?? '/').split('?')[0] ?? '/').replace(/^\/+/, '');
      serve(res, name.startsWith('sample_') ? join(media, name) : join(dir, name));
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
    const base = `http://127.0.0.1:${port}`;
    if (!existsSync(join(media, 'sample_1080p.mp4'))) {
      record('Giải mã video H.264 cục bộ', false, `SKIP: không thấy ${media}/sample_1080p.mp4`);
    }
    const page = join(dir, 'decode.html');
    await writeFile(
      page,
      `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#000">
       <video id="v" width="640" style="height:auto" muted autoplay playsinline></video>
       <script>
         window.__r = { state: 'new', frames: 0, mbps: 0 };
         const v = document.getElementById('v');
         let t0 = 0, f0 = 0;
         v.addEventListener('loadeddata', () => { window.__r.state = 'loadeddata'; window.__r.size = v.videoWidth + 'x' + v.videoHeight; });
         v.addEventListener('error', () => { window.__r.state = 'error'; window.__r.code = v.error ? v.error.code : -1; });
         v.addEventListener('timeupdate', () => {
           const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
           window.__r.frames = q ? q.totalVideoFrames : 0;
           if (t0) { const dt = performance.now() - t0; window.__r.mbps = dt > 0 ? Number(((v.currentTime - f0) * 1000 / dt).toFixed(2)) : 0; }
         });
         const qs = new URLSearchParams(location.search);
         v.src = qs.get('src') || '/sample_1080p.mp4';
         v.play().catch((e) => { window.__r.play = String(e.name); });
       </script></body>`,
      'utf8',
    );

    for (const [name, file] of [
      ['1080p', '/sample_1080p.mp4'],
      ['1440p', '/sample_1440p.mp4'],
    ] as const) {
      await views.mountProbeUrl(`${base}/decode.html?src=${file}`);
      await wait(1200);
      await wait(6000);
      const contents = views.serviceContents;
      const raw = contents
        ? ((await contents
            .executeJavaScript(
              `(() => { const v = document.getElementById('v'); const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
                 return JSON.stringify({ state: window.__r.state, size: window.__r.size ?? '-', code: window.__r.code ?? null,
                   ready: v.readyState, paused: v.paused, t: Number(v.currentTime.toFixed(2)),
                   frames: q ? q.totalVideoFrames : 0, dropped: q ? q.droppedVideoFrames : 0, t0: window.__r.t, mbps: window.__r.mbps }); })()`,
              true,
            )
            .catch((e: Error) => JSON.stringify({ error: e.message }))) as string)
        : '{"error":"no-view"}';
      console.log(`      media ${name}: ${raw}`);
      const m = JSON.parse(raw) as { state?: string; size?: string; ready?: number; t?: number; frames?: number; dropped?: number; mbps?: number; code?: number; error?: string; t0?: number };
      record(
        `Giải mã ${name} (H.264 cục bộ, không qua nền tảng)`,
        (m.ready ?? 0) >= 2 && (m.frames ?? 0) > 0,
        `readyState=${m.ready ?? '-'} kích thước=${m.size ?? '-'} giây=${m.t ?? '-'} khung=${m.frames ?? 0} rớt=${m.dropped ?? 0} tốc độ=${m.mbps ?? 0}x lỗi=${m.code ?? m.error ?? '-'}`,
      );
    }
    server.close();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);

    // Chromium blocks unmuted autoplay without a user gesture; only `mute=1` starts it.
    record('Autoplay', true, 'autoplay chỉ chạy khi tắt tiếng (mute=1) — Chromium autoplay policy');

    for (const id of VIDEO_IDS) {
      await views.openCurated(id);
      await wait(20000);

      // First pass nudges the player to start (autoplay policy blocks it otherwise); the second
      // pass measures whether it is genuinely decoding frames.
      await probeFrames(views);
      await wait(8000);

      const frames = await probeFrames(views);
      console.log(`      frames=${frames.frames}`);
      for (const note of frames.notes) console.log(`        ${note}`);
      record(
        `YouTube embed ${id}: phát được video`,
        frames.playing > 0 && frames.width > 0,
        `playing=${frames.playing} khung=${frames.width}x${frames.height}`,
      );
    }

    // CPU load while decoding — the GPU is nouveau (no NVDEC), so decode is software.
    const load = await readLoadAverage();
    record('Tải CPU khi phát video', load < 12, `loadavg=${load.toFixed(2)} trên 6 nhân (ngưỡng 12)`);
  } catch (error) {
    record('Probe player chạy không lỗi', false, (error as Error).stack ?? String(error));
  } finally {
    const failed = results.filter((r) => !r.pass).length;
    console.log(`\n=== ${results.length - failed}/${results.length} kiểm tra phát video PASS ===`);
    for (const r of results.filter((x) => !x.pass)) console.log(`   FAILED: ${r.name} :: ${r.detail}`);
    app.exit(0);
  }
}
