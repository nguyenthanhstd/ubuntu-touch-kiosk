import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolveAppIds } from './compositor.js';

/**
 * Wayland foreign-toplevel minimized-state probe for external apps (`QA09-04`).
 *
 * Uses `/usr/bin/wlrctl toplevel find` (matching `compositor.ts` env & fail-open behavior when
 * `wlrctl` is unavailable) so `frontExternalApp()` skips minimized background apps before any
 * single-group short-circuit or `lastActiveId`/`startedAt` fallback.
 */

const WLRCTL = '/usr/bin/wlrctl';
const WLRCTL_TIMEOUT_MS = 1500;

let wlrctlAvailable: boolean | null = null;

export interface ToplevelStateDeps {
  readonly runWlrctl?: (args: readonly string[]) => Promise<boolean>;
  readonly resolveIds?: (known: readonly string[]) => Promise<readonly string[]>;
}

function hasWlrctl(): boolean {
  if (wlrctlAvailable === null) wlrctlAvailable = existsSync(WLRCTL);
  return wlrctlAvailable;
}

function wlrEnv(): NodeJS.ProcessEnv {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  return {
    ...process.env,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || 'wayland-0',
  };
}

function defaultRunWlrctl(args: readonly string[]): Promise<boolean> {
  if (!hasWlrctl()) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(WLRCTL, [...args], { env: wlrEnv(), timeout: WLRCTL_TIMEOUT_MS }, (error) => {
      resolve(!error);
    });
  });
}

/**
 * Returns `true` only when at least one candidate `app_id` matches a `state:minimized` toplevel
 * AND no candidate `app_id` matches a `state:unminimized` toplevel (multi-window apps stay visible).
 */
export async function isExternalMinimized(
  appIds: readonly string[],
  deps?: ToplevelStateDeps,
): Promise<boolean> {
  if (appIds.length === 0) return false;
  const resolveIds = deps?.resolveIds ?? resolveAppIds;
  const runWlrctl = deps?.runWlrctl ?? defaultRunWlrctl;

  const resolved = [...new Set(await resolveIds(appIds))];
  if (resolved.length === 0) return false;

  let anyMinimized = false;
  for (const appId of resolved) {
    if (await runWlrctl(['toplevel', 'find', `app_id:${appId}`, 'state:minimized'])) {
      anyMinimized = true;
      break;
    }
  }
  if (!anyMinimized) return false;

  for (const appId of resolved) {
    if (await runWlrctl(['toplevel', 'find', `app_id:${appId}`, 'state:unminimized'])) {
      return false;
    }
  }
  return true;
}
