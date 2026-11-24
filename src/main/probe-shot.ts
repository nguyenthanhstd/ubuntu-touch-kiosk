/**
 * Captures the real compositor output to a PNG so "does the kiosk actually draw?" can be answered
 * from pixels instead of from process state. The kmsgrab path is unavailable on nouveau (DUMB
 * buffers), so the only trustworthy source is Electron's own `capturePage`.
 */
import { app } from 'electron';
import { writeFileSync } from 'node:fs';
import { ViewManager } from './view-manager.js';
import type { ServiceId } from '../shared/services.js';

function summarise(png: Buffer): string {
  return `${png.length} bytes`;
}

export async function runShotProbe(views: ViewManager, outPath: string): Promise<void> {
  console.log('[shot] waiting for first paint…');
  await new Promise((r) => setTimeout(r, 6000));

  // `--ntf-probe-shot <dir> [service]` — opening a service exercises the real navigation path.
  const shotsAt = process.argv.indexOf('--ntf-probe-shot');
  const candidate = process.argv[shotsAt + 2] ?? '';
  const service = candidate.startsWith('--') ? '' : candidate;
  const wantsKeyboard = process.argv.includes('--ntf-keyboard');
  if (service) {
    console.log(`[shot] opening service: ${service}`);
    views.open(service as ServiceId);
    await new Promise((r) => setTimeout(r, 14000));
  }

  console.log(`[shot] active service: ${views.activeService ?? 'home'}`);
  if (wantsKeyboard) {
    await views.setKeyboardOpen(true);
    await new Promise((r) => setTimeout(r, 2500));
  }

  // Capture the composed window, not one view: the top bar, dock and keyboard are separate
  // WebContentsViews, and capturing a single view returns "surface not available" whenever the
  // compositor is not holding an offscreen surface for it.
  const win = views.browserWindow;
  const winShot = await win.webContents.capturePage();
  if (!winShot.isEmpty()) {
    writeFileSync(`${outPath}.window.png`, winShot.toPNG());
  }

  const lines: string[] = [];
  const composed = winShot.isEmpty() ? null : winShot;
  if (composed) {
    const s = composed.getSize();
    const px = composed.toBitmap();
    const seen = new Set<number>();
    let lit = 0;
    for (let i = 0; i + 2 < px.length; i += 4) {
      const r = px[i] ?? 0;
      const g = px[i + 1] ?? 0;
      const b = px[i + 2] ?? 0;
      seen.add((r << 16) | (g << 8) | b);
      if (r > 24 || g > 24 || b > 24) lit++;
    }
    const total = Math.floor(px.length / 4);
    lines.push(
      `window        ${s.width}x${s.height} colours=${seen.size} lit=${((lit / total) * 100).toFixed(1)}%`,
    );
  } else {
    lines.push('window        (capturePage rỗng — không xác nhận được pixel)');
  }

  // Per-view capture is best-effort: it fails when a view has no compositor surface, which is not
  // itself a rendering failure as long as the composed window capture has content.
  for (const [label, contents] of [
    ['top', views.topContents],
    ['dock', views.dockContents],
    ['nav', views.navContents],
  ] as const) {
    try {
      const shot = await contents.capturePage();
      if (shot.isEmpty()) {
        lines.push(`${label.padEnd(13)} (rỗng)`);
        continue;
      }
      writeFileSync(`${outPath}.${label}.png`, shot.toPNG());
      const s = shot.getSize();
      const px = shot.toBitmap();
      const seen = new Set<number>();
      for (let i = 0; i + 2 < px.length; i += 4) {
        seen.add(((px[i] ?? 0) << 16) | ((px[i + 1] ?? 0) << 8) | (px[i + 2] ?? 0));
      }
      lines.push(`${label.padEnd(13)} ${s.width}x${s.height} colours=${seen.size}`);
    } catch (e) {
      lines.push(`${label.padEnd(13)} capture failed: ${String((e as Error).message)}`);
    }
  }

  const kb = views.keyboardContents;
  if (kb && views.keyboardVisible) {
    try {
      const shot = await kb.capturePage();
      if (!shot.isEmpty()) {
        writeFileSync(`${outPath}.keyboard.png`, shot.toPNG());
        const s = shot.getSize();
        lines.push(`keyboard      ${s.width}x${s.height}`);
      } else {
        lines.push('keyboard      (rỗng)');
      }
    } catch (e) {
      lines.push(`keyboard      capture failed: ${String((e as Error).message)}`);
    }
  }

  const serviceContents = views.serviceContents;
  if (serviceContents) {
    const shot = await serviceContents.capturePage();
    const png = shot.toPNG();
    writeFileSync(`${outPath}.service.png`, png);
    const s = shot.getSize();
    lines.push(`service       ${s.width}x${s.height} empty=${shot.isEmpty()} ${summarise(png)}`);
  } else {
    lines.push('service       (không có view dịch vụ đang mở)');
  }

  console.log(`[shot] results\n  ${lines.join('\n  ')}`);
  console.log(`[shot] wrote ${outPath}.nav.png`);
  app.exit(0);}
