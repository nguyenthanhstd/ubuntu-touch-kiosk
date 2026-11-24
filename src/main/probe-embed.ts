// Third playback experiment: is the silent <video> in the YouTube embed caused by the embed
// document, or by the way the player is reached?
//
// The isolated test proved this machine decodes H.264 1080p and 1440p (readyState=4, frames
// counted). The embed, reached by a top-level navigation to youtube.com/embed/<id>, keeps
// readyState=0/networkState=0 forever. Two candidate causes remain:
//   (a) YouTube refuses to start playback without a parent/host page (Error 153 family), or
//   (b) something on this box stops googlevideo media from arriving.
// The local host page with an iframe separates them: same network, same GPU, different parent.
//   electron dist/main/main.js --ntf-dev --ntf-probe-embed
import { app } from 'electron';
import { readFileSync } from 'node:fs';
import * as nodeHttp from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ViewManager } from './view-manager.js';

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
function record(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} :: ${detail}`);
}
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RENDERER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'renderer');
const VIDEO_IDS = ['aqz-KE-bpKQ', 'jNQXAC9IVRw'];

interface MediaFact {
  videos: number;
  playing: number;
  width: number;
  height: number;
  readyState: number;
  networkState: number;
  error: string | null;
  notes: string[];
}

/**
 * Reads every <video> in every frame through the DevTools protocol. Executing JS directly in a
 * child frame tore down the compositor on this machine, and `awaitPromise` did the same, so this
 * uses isolated worlds and synchronous expressions only.
 */
async function readMedia(views: ViewManager): Promise<MediaFact> {
  const fact: MediaFact = { videos: 0, playing: 0, width: 0, height: 0, readyState: 0, networkState: 0, error: null, notes: [] };
  const contents = views.serviceContents;
  if (!contents || contents.isDestroyed()) return fact;
  const debug = contents.debugger;
  let attached = false;
  try {
    debug.attach('1.3');
    attached = true;
  } catch {
    /* already attached */
  }
  try {
    const tree = (await debug.sendCommand('Page.getFrameTree')) as {
      frameTree: { frame: { id: string; url: string }; childFrames?: unknown[] };
    };
    const frames: Array<{ id: string; url: string }> = [];
    const walk = (node: unknown): void => {
      const n = node as { frame: { id: string; url: string }; childFrames?: unknown[] };
      frames.push(n.frame);
      for (const child of n.childFrames ?? []) walk(child);
    };
    walk(tree.frameTree);

    for (const frame of frames) {
      const world = (await debug.sendCommand('Page.createIsolatedWorld', {
        frameId: frame.id,
        worldName: 'ntf-embed',
      })) as { executionContextId: number };
      const evaluated = (await debug.sendCommand('Runtime.evaluate', {
        expression: `(() => { const vs = [...document.querySelectorAll('video')];
          const v = vs[0];
          return JSON.stringify(v ? { n: vs.length, w: v.videoWidth, h: v.videoHeight, rs: v.readyState,
            ns: v.networkState, err: v.error ? v.error.code : null, t: Number(v.currentTime.toFixed(2)),
            paused: v.paused, dur: Number.isFinite(v.duration) ? Number(v.duration.toFixed(1)) : -1,
            src: String(v.currentSrc).slice(0, 60) } : { n: 0 }); })()`,
        contextId: world.executionContextId,
        returnByValue: true,
      })) as { result?: { value?: string } };
      const parsed = JSON.parse(evaluated.result?.value ?? '{"n":0}') as {
        n: number; w?: number; h?: number; rs?: number; ns?: number; err?: number | null; t?: number; paused?: boolean; dur?: number; src?: string;
      };
      if (parsed.n > 0) {
        fact.videos += parsed.n;
        fact.width = Math.max(fact.width, parsed.w ?? 0);
        fact.height = Math.max(fact.height, parsed.h ?? 0);
        fact.readyState = parsed.rs ?? 0;
        fact.networkState = parsed.ns ?? 0;
        fact.error = parsed.err === null || parsed.err === undefined ? null : String(parsed.err);
        if ((parsed.t ?? 0) > 0 && parsed.paused === false) fact.playing += 1;
        fact.notes.push(
          `${frame.url.slice(0, 58)} → w=${parsed.w} h=${parsed.h} rs=${parsed.rs} ns=${parsed.ns} err=${parsed.err} t=${parsed.t} dur=${parsed.dur} src=${parsed.src}`,
        );

        // A muted, gesture-free play() is allowed by the autoplay policy, so a video that still
        // refuses points at the media pipeline or the producer, not at the interaction gate.
        await debug.sendCommand('Runtime.evaluate', {
          expression: `(() => { const v = document.querySelector('video'); if (v) { v.muted = true; v.play().catch(() => {}); } })()`,
          contextId: world.executionContextId,
          returnByValue: true,
        });
      }
    }
  } catch (error) {
    fact.notes.push(`CDP: ${(error as Error).message.slice(0, 80)}`);
  } finally {
    if (attached && debug.isAttached()) debug.detach();
  }
  return fact;
}

/**
 * Lists the frames of the service view. A host page that embeds YouTube should show at least two
 * frames; one frame means the iframe never committed, which is a different failure from "the
 * player started and stayed empty".
 */
async function frameInfo(views: ViewManager): Promise<string> {
  const contents = views.serviceContents;
  if (!contents || contents.isDestroyed()) return 'no-view';
  const debug = contents.debugger;
  let attached = false;
  try {
    debug.attach('1.3');
    attached = true;
  } catch {
    /* already attached */
  }
  try {
    const tree = (await debug.sendCommand('Page.getFrameTree')) as { frameTree: unknown };
    const urls: string[] = [];
    const walk = (node: unknown): void => {
      const n = node as { frame: { url: string }; childFrames?: unknown[] };
      urls.push(n.frame.url.slice(0, 70));
      for (const child of n.childFrames ?? []) walk(child);
    };
    walk(tree.frameTree);
    return urls.join(' | ');
  } catch (error) {
    return `CDP: ${(error as Error).message.slice(0, 60)}`;
  } finally {
    if (attached && debug.isAttached()) debug.detach();
  }
}
 
function createLoopbackHost(): import('node:http').Server {
  const http = nodeHttp;
  const pageDir = join(RENDERER_DIR, 'player');
  return http.createServer((req, res) => {
    const name = ((req.url ?? '/').split('?')[0] ?? '/').replace(/^\/+/, '') || 'index.html';
    try {
      const body = readFileSync(join(pageDir, name));
      res.writeHead(200, {
        'Content-Type': name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
}

export async function runEmbedProbe(views: ViewManager): Promise<void> {
  const server = createLoopbackHost();
  try {
    await wait(1500);

    // A local page is not a valid parent for the YouTube player (it refuses with "Error 153"), so
    // the experiment needs a page served over http. A loopback server gives the same bytes without
    // pulling in a second machine or a public host.
    const server = createLoopbackHost();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
    const hostBase = `http://127.0.0.1:${port}/index.html`;

    // The embed never leaves networkState=0, which means it never even requests media. Before
    // blaming YouTube or the GPU, prove the app's renderer can reach the player script and the
    // embed document it depends on. This runs in the same view the iframe would use.
    await views.open('youtube');
    await wait(4000);
    const netContents = views.serviceContents;
    const embedPageError = netContents
      ? await netContents
          .executeJavaScript(
            `fetch('https://www.youtube.com/embed/aqz-KE-bpKQ').then(async r => {
               const t = await r.text();
               const m = t.match(/Video player configuration error[^<]{0,80}/);
               return m ? m[0] : 'không thấy lỗi cấu hình trong HTML';
             }).catch(e => 'fetch lỗi: ' + e.message)`,
            true,
          )
          .catch((e: Error) => `js lỗi: ${e.message}`)
      : 'no-view';
    console.log(`      html: ${embedPageError}`);
    const fetchReport = netContents
      ? await netContents
          .executeJavaScript(
            `(async () => {
               const urls = ['https://www.youtube.com/embed/aqz-KE-bpKQ?autoplay=1&mute=1',
                             'https://www.youtube.com/iframe_api',
                             'https://www.youtube.com/player_api'];
               const out = [];
               for (const u of urls) {
                 try {
                   const r = await fetch(u, { mode: 'cors', credentials: 'include' });
                   const t = await r.text();
                   out.push({ u: u.replace('https://www.youtube.com', ''), status: r.status, len: t.length });
                 } catch (e) { out.push({ u: u.replace('https://www.youtube.com', ''), err: String(e).slice(0, 60) }); }
               }
               return JSON.stringify(out);
             })()`,
            true,
          )
          .catch((e: Error) => JSON.stringify([{ err: e.message }]))
      : '[]';
    console.log(`      mạng: ${fetchReport}`);
    const netRows = JSON.parse(fetchReport) as Array<{ u?: string; status?: number; len?: number; err?: string }>;
    record(
      'Renderer tải được iframe_api của YouTube',
      netRows.some((r) => (r.u ?? '').includes('iframe_api') && (r.status === 200 || r.status === 204)),
      netRows.map((r) => `${r.u ?? '?'}=${r.status ?? r.err}`).join(' '),
    );

    for (const id of VIDEO_IDS) {
      const candidates: Array<[string, string]> = [
        ['127.0.0.1 + youtube.com', `${hostBase}?v=${id}`],
        ['127.0.0.1 + youtube-nocookie.com', `${hostBase}?v=${id}&nocookie=1`],
      ];
      for (const [origin, url] of candidates) {
        await views.mountProbeUrl(url);
        await wait(3000);
        await wait(12000);
        await readMedia(views);
        await wait(8000);
        const second = await readMedia(views);

        for (const note of second.notes) console.log(`        ${note}`);
        if (second.notes.length === 0) {
          const frames = await frameInfo(views);
          console.log(`        frame: ${frames}`);
        }
        record(
          `Host page cục bộ + iframe ${origin} (${id})`,
          second.playing > 0 && second.width > 0,
          `playing=${second.playing} khung=${second.width}x${second.height} ready=${second.readyState} net=${second.networkState} lỗi=${second.error ?? '-'}`,
        );
      }
    }

    // Iframe không commit được trong môi trường này (chỉ thấy frame host), nên phép thử quyết định
    // là nạp thẳng trang embed làm main frame — chỗ duy nhất còn nói được YouTube có phát hay không.
    const direct: Array<[string, string]> = [
      ['youtube.com', `https://www.youtube.com/embed/${VIDEO_IDS[0]}?autoplay=1&mute=1`],
      ['youtube-nocookie.com', `https://www.youtube-nocookie.com/embed/${VIDEO_IDS[0]}?autoplay=1&mute=1`],
    ];
    for (const [origin, url] of direct) {
      await views.mountProbeUrl(url);
      await wait(3000);
      await wait(12000);
      await readMedia(views);
      await wait(8000);
      const second = await readMedia(views);
      for (const note of second.notes) console.log(`        ${note}`);
      console.log(`        frame: ${await frameInfo(views)}`);
      record(
        `Main frame embed ${origin} (${VIDEO_IDS[0]})`,
        second.playing > 0 && second.width > 0,
        `playing=${second.playing} khung=${second.width}x${second.height} ready=${second.readyState} net=${second.networkState} lỗi=${second.error ?? '-'}`,
      );
    }
  } catch (error) {
    record('Probe embed chạy không lỗi', false, (error as Error).stack ?? String(error));
  } finally {
    server.close();
    const failed = results.filter((r) => !r.pass).length;
    console.log(`\n=== ${results.length - failed}/${results.length} kiểm tra embed PASS ===`);
    app.exit(0);
  }
}
