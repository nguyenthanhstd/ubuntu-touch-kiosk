import { readdirSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import type { SystemStatus } from '../shared/chrome.js';
import { clockParts } from '../shared/clock.js';

/**
 * Read-only system facts for the top bar. Everything here comes from /proc and /sys when possible,
 * because the kiosk runs unprivileged and a shell call per second would show up in the logs.
 * Network names still need `nmcli`, so it is called at most once every five seconds and its failure
 * is not an error — an offline kiosk must still draw a clock.
 */

// Đồng hồ nằm ở `src/shared/clock.ts` để màn hình chờ định dạng y hệt thanh trên. Trước đây mỗi nơi
// tự định dạng theo cách riêng và hai mặt đồng hồ lệch nhau bảy giờ khi máy chạy TZ khác UTC+7.

function readFirstLine(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').split('\n')[0]?.trim() ?? null;
  } catch {
    return null;
  }
}

function readNumber(path: string): number | null {
  const line = readFirstLine(path);
  if (line === null) return null;
  const value = Number.parseFloat(line);
  return Number.isFinite(value) ? value : null;
}

/** Highest zone temperature in °C, or -1 when the machine exposes none. */
function cpuTemperature(): number {
  let hottest = -1;
  const consider = (path: string): void => {
    let raw: number | null = null;
    try {
      raw = readNumber(path);
    } catch {
      raw = null;
    }
    if (raw !== null) hottest = Math.max(hottest, Math.round(raw / 1000));
  };
  for (const zone of ['x86_pkg_temp', 'acpitz', 'thermal_zone0']) {
    consider(`/sys/class/thermal/${zone}/temp`);
  }
  if (hottest >= 0) return hottest;
  try {
    for (const entry of readdirSync('/sys/class/thermal')) {
      if (entry.startsWith('thermal_zone')) consider(`/sys/class/thermal/${entry}/temp`);
    }
  } catch {
    /* no thermal class at all */
  }
  return hottest;
}

interface MemInfo {
  total: number;
  available: number;
}

function memInfo(): MemInfo {
  try {
    const text = readFileSync('/proc/meminfo', 'utf8');
    const get = (key: string): number => {
      const match = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text);
      return match?.[1] ? Number.parseInt(match[1], 10) : 0;
    };
    return { total: get('MemTotal'), available: get('MemAvailable') };
  } catch {
    return { total: 0, available: 0 };
  }
}

interface NetworkInfo {
  interface: string;
  signal: number;
  wired: boolean;
}

/**
 * Resolves the interface actually carrying traffic, not just the first wireless one. `nmcli -t`
 * output is colon separated, SSIDs may contain colons, so only the leading fields are parsed.
 *
 * This box has no NetworkManager client, so `nmcli` exits 127 and the top bar used to sit on
 * "Ngoại tuyến" while the network was fine. The fallback reads sysfs, which needs no extra package.
 */
function queryNetwork(): Promise<NetworkInfo> {
  return new Promise((resolve) => {
    execFile(
      'nmcli',
      ['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device', 'status'],
      { timeout: 2500 },
      (error, stdout) => {
        if (error || !stdout) {
          resolve(queryNetworkSysfs());
          return;
        }
        const connected = stdout
          .split('\n')
          .map((line) => line.split(':'))
          .filter((parts) => parts[2] === 'connected');
        const wired = connected.find((parts) => parts[1] === 'ethernet');
        const wifi = connected.find((parts) => parts[1] === 'wifi');
        const chosen = wired ?? wifi;
        if (!chosen) {
          resolve(queryNetworkSysfs());
          return;
        }
        if (wired) {
          resolve({ interface: chosen[0] ?? 'eth0', signal: 100, wired: true });
          return;
        }
        execFile(
          'nmcli',
          ['-t', '-f', 'IN-USE,SIGNAL', 'device', 'wifi', 'list'],
          { timeout: 2500 },
          (wifiError, wifiOut) => {
            let signal = -1;
            if (!wifiError && wifiOut) {
              for (const line of wifiOut.split('\n')) {
                if (!line.startsWith('*')) continue;
                const parts = line.split(':');
                const parsed = Number.parseInt(parts[1] ?? '', 10);
                if (Number.isFinite(parsed)) signal = parsed;
                break;
              }
            }
            resolve({ interface: chosen[0] ?? 'wlan0', signal, wired: false });
          },
        );
      },
    );
  });
}

function readSysfs(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * nmcli-free fallback: an ethernet interface with `carrier` 1 and `operstate` up is "online",
 * and a wireless one additionally reports its link quality (0–70) out of 70.
 */
function queryNetworkSysfs(): NetworkInfo {
  try {
    const interfaces = readdirSync('/sys/class/net');
    const up = interfaces.filter((name) => {
      if (name === 'lo') return false;
      return readSysfs(`/sys/class/net/${name}/operstate`) === 'up' && readSysfs(`/sys/class/net/${name}/carrier`) === '1';
    });
    const wired = up.find((name) => !name.startsWith('wlan') && !name.startsWith('wl'));
    if (wired) return { interface: wired, signal: 100, wired: true };
    const wifi = up.find((name) => name.startsWith('wlan') || name.startsWith('wl'));
    if (wifi) {
      const quality = Number.parseInt(readSysfs(`/sys/class/net/${wifi}/wireless/link`), 10);
      const signal = Number.isFinite(quality) ? Math.round((quality / 70) * 100) : -1;
      return { interface: wifi, signal, wired: false };
    }
    return { interface: '', signal: -1, wired: false };
  } catch {
    return { interface: '', signal: -1, wired: false };
  }
}

export class SystemMonitor {
  private network: NetworkInfo = { interface: '', signal: -1, wired: false };
  private networkFetchedAt = 0;
  private timer: NodeJS.Timeout | null = null;

  /**
   * @param onTick called with a fully populated status; the caller decides who receives it.
   * @param intervalMs one second keeps the minute change invisible to the visitor.
   */
  start(onTick: (status: SystemStatus) => void, intervalMs = 1000): void {
    this.stop();
    const tick = async (): Promise<void> => {
      const now = Date.now();
      if (now - this.networkFetchedAt > 5000) {
        this.networkFetchedAt = now;
        this.network = await queryNetwork();
      }
      onTick(this.snapshot());
    };
    void tick();
    this.timer = setInterval(() => void tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): SystemStatus {
    const clock = clockParts(new Date());
    const mem = memInfo();
    const load = readNumber('/proc/loadavg');
    return {
      time: clock.time,
      seconds: clock.seconds,
      date: clock.date,
      network: this.network.interface,
      signal: this.network.signal,
      wired: this.network.wired,
      cpuLoad: load === null ? -1 : Math.round(load * 10) / 10,
      cpuTemp: cpuTemperature(),
      memUsedPercent: mem.total > 0 ? Math.round(((mem.total - mem.available) / mem.total) * 100) : -1,
    };
  }
}
