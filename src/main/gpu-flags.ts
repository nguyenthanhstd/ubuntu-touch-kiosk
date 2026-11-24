import type { App } from 'electron';

/**
 * Chromium GPU & Wayland switch planner/applier for the kiosk main process.
 *
 * Defaults `NTF_GPU_MODE` to `'on'` so kiosk renderers keep GPU compositing enabled for smooth
 * touch scrolling (`PERF-01`), while preserving `'auto'` (software compositing + VA-API) and
 * `'off'` (`--disable-gpu` + `--disable-gpu-compositing`) plus optional Wayland backend overrides
 * (`NTF_GPU_GL`, `NTF_GPU_ANGLE`, `NTF_GPU_VULKAN`) for runtime soak/rollback without rebuilds.
 */

export type GpuMode = 'on' | 'auto' | 'off';
export type GpuGlBackend = 'egl' | 'angle' | 'desktop' | 'swiftshader';
export type GpuAngleBackend = 'gl' | 'gles' | 'vulkan' | 'swiftshader';
export type GpuSwitch = readonly [name: string, value?: string];

export interface GpuSwitchApp {
  readonly commandLine: Pick<App['commandLine'], 'appendSwitch'>;
}

export interface GpuModeInfo {
  readonly mode: GpuMode;
  readonly wayland: boolean;
  readonly gpuCompositing: boolean;
  readonly vaapi: boolean;
  readonly nvidiaVaapi: boolean | null;
  readonly gl: GpuGlBackend | null;
  readonly angle: GpuAngleBackend | null;
  readonly vulkan: boolean | null;
  readonly switches: readonly GpuSwitch[];
}

const VALID_MODES = new Set<GpuMode>(['on', 'auto', 'off']);
const VALID_GL = new Set<GpuGlBackend>(['egl', 'angle', 'desktop', 'swiftshader']);
const VALID_ANGLE = new Set<GpuAngleBackend>(['gl', 'gles', 'vulkan', 'swiftshader']);
/**
 * Feature names, read from Chromium `156.0.8078.100` (the build inside Electron 45.4.1). The
 * command-line name is the string literal, not the `k`-identifier: `kAcceleratedVideoDecodeLinux`
 * is declared as `BASE_FEATURE(kAcceleratedVideoDecodeLinux, "AcceleratedVideoDecoder", …)`, so
 * `AcceleratedVideoDecodeLinux` in `--enable-features` is silently ignored. `VaapiVideoDecoder` no
 * longer exists in that build at all; it is the name this file used to pass.
 */
const BASE_FEATURES: readonly string[] = [
  'AcceleratedVideoDecoder',
  'AcceleratedVideoDecodeLinuxGL',
  'VaapiIgnoreDriverChecks',
];
/**
 * `VaapiOnNvidiaGPUs` is the only guard `vaapi_wrapper` applies to an `nvidia-drm` render node: with
 * it off, Chromium logs "Should skip nVidia device" and never creates a decoder. It is added only
 * when the machine is actually set up for it, because Chromium ships it disabled for a reason
 * (crbug.com/1492880: the x64 proprietary driver can crash the GPU process).
 */
const NVIDIA_FEATURE = 'VaapiOnNvidiaGPUs';

function parseGpuMode(raw: string | undefined): GpuMode {
  const normalized = raw?.trim().toLowerCase() ?? '';
  return VALID_MODES.has(normalized as GpuMode) ? (normalized as GpuMode) : 'on';
}

function parseAllowlist<T extends string>(raw: string | undefined, valid: ReadonlySet<T>): T | null {
  const normalized = raw?.trim().toLowerCase() ?? '';
  return valid.has(normalized as T) ? (normalized as T) : null;
}

function parseBoolEnv(raw: string | undefined): boolean | null {
  const normalized = raw?.trim().toLowerCase() ?? '';
  if (normalized === '1' || normalized === 'true' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'off') return false;
  return null;
}

/** Computes Chromium command-line switches without mutating `app`, enabling pure unit tests. */
export function resolveGpuPlan(
  devMode: boolean,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): GpuModeInfo {
  const mode = parseGpuMode(env.NTF_GPU_MODE);
  if (devMode) {
    return {
      mode,
      wayland: false,
      gpuCompositing: true,
      vaapi: false,
      nvidiaVaapi: null,
      gl: null,
      angle: null,
      vulkan: null,
      switches: [],
    };
  }

  const switches: GpuSwitch[] = [];
  const isLinux = platform === 'linux';
  const wayland = isLinux;
  let gpuCompositing = true;

  if (isLinux) {
    switches.push(['ozone-platform', 'wayland']);
    if (mode === 'off') {
      switches.push(['disable-gpu'], ['disable-gpu-compositing']);
      gpuCompositing = false;
    } else if (mode === 'auto') {
      switches.push(['disable-gpu-compositing']);
      gpuCompositing = false;
    }
  }

  const allowBackendTuning = isLinux && mode !== 'off';
  const gl = allowBackendTuning ? parseAllowlist(env.NTF_GPU_GL, VALID_GL) : null;
  const angle = allowBackendTuning ? parseAllowlist(env.NTF_GPU_ANGLE, VALID_ANGLE) : null;
  const vulkan = allowBackendTuning ? parseBoolEnv(env.NTF_GPU_VULKAN) : null;

  if (gl) switches.push(['use-gl', gl]);
  if (angle) switches.push(['use-angle', angle]);

  const vaapi = mode !== 'off';
  const nvidiaVaapi = vaapi ? parseBoolEnv(env.NTF_GPU_NVIDIA) : null;
  if (vaapi) {
    const enabled = [...BASE_FEATURES];
    if (nvidiaVaapi === true) enabled.push(NVIDIA_FEATURE);
    if (vulkan === true) enabled.push('Vulkan');
    // Merge all enabled features into one switch so Chromium does not overwrite VA-API.
    switches.push(['enable-features', enabled.join(',')]);
    if (vulkan === false) switches.push(['disable-features', 'Vulkan']);
  }

  return { mode, wayland, gpuCompositing, vaapi, nvidiaVaapi, gl, angle, vulkan, switches };
}

/** Applies the resolved GPU/Wayland switches to Electron before `app.whenReady()`. */
export function applyGpuCommandLine(
  app: GpuSwitchApp,
  devMode: boolean,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): GpuModeInfo {
  const plan = resolveGpuPlan(devMode, env, platform);
  for (const [name, value] of plan.switches) {
    if (value === undefined) app.commandLine.appendSwitch(name);
    else app.commandLine.appendSwitch(name, value);
  }
  return plan;
}
