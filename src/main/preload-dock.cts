import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { installGestures } from './preload-gesture.cjs';
import type { ChromeApi } from '../shared/ipc.js';
import type { DockAction, DockState, GestureEvent, SystemStatus } from '../shared/chrome.js';

/**
 * Bridge for the dock. The dock is the only page allowed to press dock items, so `press` lives
 * here and not in preload-chrome.cts. The main process re-validates every action against
 * DOCK_ORDER before doing anything with it, so a compromised dock cannot open an arbitrary service.
 */
const chrome: ChromeApi = {
  press: (action: DockAction) => ipcRenderer.send('chrome:press', action),
  onDock: (callback) => {
    const listener = (_event: IpcRendererEvent, state: DockState) => callback(state);
    ipcRenderer.on('ntf:dock', listener);
    return () => ipcRenderer.removeListener('ntf:dock', listener);
  },
  onGesture: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: GestureEvent) => callback(payload);
    ipcRenderer.on('ntf:gesture', listener);
    return () => ipcRenderer.removeListener('ntf:gesture', listener);
  },
  onClock: (callback) => {
    const listener = (_event: IpcRendererEvent, status: SystemStatus) => callback(status);
    ipcRenderer.on('ntf:clock', listener);
    return () => ipcRenderer.removeListener('ntf:clock', listener);
  },
  getClock: () => ipcRenderer.invoke('chrome:clock') as Promise<SystemStatus>,
  key: (data: string) => ipcRenderer.send('chrome:key', { kind: 'text', data }),
  keyBackspace: () => ipcRenderer.send('chrome:key', { kind: 'backspace' }),
  keyEnter: () => ipcRenderer.send('chrome:key', { kind: 'enter' }),
  keySpace: () => ipcRenderer.send('chrome:key', { kind: 'space' }),
  getKeyboardScale: () => ipcRenderer.invoke('chrome:keyboard-scale') as Promise<number>,
  setKeyboardScale: (scale: number) => ipcRenderer.invoke('chrome:set-keyboard-scale', scale) as Promise<number>,
  back: () => ipcRenderer.send('chrome:nav', 'back'),
  reload: () => ipcRenderer.send('chrome:nav', 'reload'),
};

contextBridge.exposeInMainWorld('ntfDock', chrome);

// The dock owns the bottom 96 px band, so Home (bottom edge) is recognized here; Back stays on
// the nav and service views. Same renderer-side reason as preload-nav.
installGestures((channel, payload) => ipcRenderer.send(channel, payload));
