import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { installGestures } from './preload-gesture.cjs';
import type { AppSettings, NavAction, NavApi, NavState, NewsApi, NewsFeedResult } from '../shared/ipc.js';
import type { ServiceId } from '../shared/services.js';

/**
 * The only bridge between the local shell page and the main process. No Node API, no module
 * loader, no arbitrary `invoke` passthrough: every capability below is a named channel.
 */
const navApi: NavApi = {
  getState: () => ipcRenderer.invoke('nav:state') as Promise<NavState>,
  onState: (callback) => {
    const listener = (_event: IpcRendererEvent, state: NavState) => callback(state);
    ipcRenderer.on('ntf:state', listener);
    return () => ipcRenderer.removeListener('ntf:state', listener);
  },
  onNavigate: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: NavAction) => callback(payload);
    ipcRenderer.on('ntf:navigate', listener);
    return () => ipcRenderer.removeListener('ntf:navigate', listener);
  },
  onKeyboard: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: { open: boolean; height: number }) => callback(payload);
    ipcRenderer.on('ntf:keyboard', listener);
    return () => ipcRenderer.removeListener('ntf:keyboard', listener);
  },
  goHome: () => ipcRenderer.send('nav:home'),
  back: () => ipcRenderer.send('nav:back'),
  forward: () => ipcRenderer.send('nav:forward'),
  reload: () => ipcRenderer.send('nav:reload'),
  stop: () => ipcRenderer.send('nav:stop'),
  zoom: (delta) => ipcRenderer.send('nav:zoom', delta),
  zoomReset: () => ipcRenderer.send('nav:zoom-reset'),
  openService: (id: ServiceId) => ipcRenderer.send('nav:open', id),
  toggleKeyboard: (show: boolean) => ipcRenderer.send('nav:keyboard', show),
  setNewsFront: (open: boolean) => ipcRenderer.send('nav:news-front', open),
  getSettings: () => ipcRenderer.invoke('nav:settings') as Promise<AppSettings>,
  setUiZoom: (level) => ipcRenderer.invoke('nav:ui-zoom', level) as Promise<AppSettings>,
  setWallpaper: (id) => ipcRenderer.invoke('nav:set-wallpaper', id) as Promise<AppSettings>,
  clearWallpaper: () => ipcRenderer.invoke('nav:clear-wallpaper') as Promise<AppSettings>,
};

const newsApi: NewsApi = {
  load: (feedId: string) => ipcRenderer.invoke('news:load', feedId) as Promise<NewsFeedResult>,
  openArticle: (link: string) => ipcRenderer.invoke('news:open', link) as Promise<boolean>,
};

contextBridge.exposeInMainWorld('ntf', { nav: navApi, news: newsApi });

// Edge gestures (left = Back) plus tap reporting for auto-keyboard, recognized here in the
// renderer because main-process input-event never sees touch on Cage/Wayland.
installGestures((channel, payload) => ipcRenderer.send(channel, payload));
