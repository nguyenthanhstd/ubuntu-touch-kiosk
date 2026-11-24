import { ipcRenderer } from 'electron';
import { installGestures } from './preload-gesture.cjs';
import { installVideoSwipe } from './preload-video-swipe.cjs';

/**
 * Preload for remote service and web-app views (Google, TikTok, YouTube, Facebook, Instagram,
 * Tin tức, probe pages).
 *
 * Those views get NO bridge on purpose: a hostile third-party page must not reach any kiosk
 * capability. But they still must report presses and edge swipes, because on this stack
 * (Cage/Wayland, Electron 45) the main-process `input-event` never delivers touch. So this entry
 * installs the recognizer and nothing else — it exposes no API to the page.
 *
 * Why a separate file: `preload-gesture.cjs` only *exports* `installGestures`, so handing it to a
 * view as the preload loads the module and installs nothing. `window.__ntfGestures` stayed
 * `undefined` on every remote page, which silently killed R04 (auto-keyboard on Google/Tin tức)
 * and R11 (tap-anywhere dismiss) there while the local nav/dock views kept working.
 *
 * SANDBOX LAW: tsc emits `require('./preload-gesture.cjs')`, which a sandboxed preload cannot
 * resolve. `scripts/fix-preload.mjs` inlines the module body into this file after tsc, the same
 * way it does for preload-nav.cjs and preload-dock.cjs.
 */
const send = (channel: string, payload: unknown): void => ipcRenderer.send(channel, payload);
installGestures(send);
// Video swipe asks main for permission and main answers on `swipe:scroll`, so the scroll is only
// applied after main has checked the sender and the real page URL.
const onScroll = installVideoSwipe(send);
ipcRenderer.on('swipe:scroll', (_event, payload: unknown) => onScroll(payload));
