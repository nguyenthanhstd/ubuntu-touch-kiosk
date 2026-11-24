import test from 'node:test';
import assert from 'node:assert/strict';
import { applyGpuCommandLine, resolveGpuPlan } from '../dist/main/gpu-flags.js';

/**
 * The exact `--enable-features` value Chromium resolves for this build. Kept here instead of
 * importing `gpu-flags` internals so a silent rename in the module fails a test.
 */
const BASE_FEATURES = 'AcceleratedVideoDecoder,AcceleratedVideoDecodeLinuxGL,VaapiIgnoreDriverChecks';

function makeApp() {
  const calls = [];
  const app = {
    commandLine: {
      appendSwitch(name, value) {
        calls.push(value === undefined ? [name] : [name, value]);
      },
    },
  };
  return { app, calls };
}

test('default Linux mode defaults to on with GPU compositing and VA-API', () => {
  const { app, calls } = makeApp();
  const info = applyGpuCommandLine(app, false, {}, 'linux');
  assert.equal(info.mode, 'on');
  assert.equal(info.wayland, true);
  assert.equal(info.gpuCompositing, true);
  assert.equal(info.vaapi, true);
  assert.deepEqual(calls, [
    ['ozone-platform', 'wayland'],
    ['enable-features', BASE_FEATURES],
  ]);
  assert.equal(calls.some(([k]) => k === 'disable-gpu' || k === 'disable-gpu-compositing'), false);
});

test('explicit on normalizes whitespace and casing', () => {
  const { app, calls } = makeApp();
  const info = applyGpuCommandLine(app, false, { NTF_GPU_MODE: ' ON ' }, 'linux');
  assert.equal(info.mode, 'on');
  assert.equal(info.gpuCompositing, true);
  assert.deepEqual(calls, [
    ['ozone-platform', 'wayland'],
    ['enable-features', BASE_FEATURES],
  ]);
});

test('auto fallback disables gpu compositing while keeping VA-API', () => {
  const { app, calls } = makeApp();
  const info = applyGpuCommandLine(app, false, { NTF_GPU_MODE: 'auto' }, 'linux');
  assert.equal(info.mode, 'auto');
  assert.equal(info.gpuCompositing, false);
  assert.equal(info.vaapi, true);
  assert.deepEqual(calls, [
    ['ozone-platform', 'wayland'],
    ['disable-gpu-compositing'],
    ['enable-features', BASE_FEATURES],
  ]);
});

test('off mode disables gpu and compositing without VA-API or backend switches', () => {
  const { app, calls } = makeApp();
  const info = applyGpuCommandLine(
    app,
    false,
    { NTF_GPU_MODE: 'off', NTF_GPU_GL: 'angle', NTF_GPU_ANGLE: 'gles', NTF_GPU_VULKAN: 'on' },
    'linux',
  );
  assert.equal(info.mode, 'off');
  assert.equal(info.gpuCompositing, false);
  assert.equal(info.vaapi, false);
  assert.equal(info.gl, null);
  assert.equal(info.angle, null);
  assert.equal(info.vulkan, null);
  assert.deepEqual(calls, [
    ['ozone-platform', 'wayland'],
    ['disable-gpu'],
    ['disable-gpu-compositing'],
  ]);
});

test('unknown NTF_GPU_MODE safely falls back to on', () => {
  const info = resolveGpuPlan(false, { NTF_GPU_MODE: 'bogus' }, 'linux');
  assert.equal(info.mode, 'on');
  assert.equal(info.gpuCompositing, true);
  assert.equal(info.switches.some(([k]) => k === 'disable-gpu-compositing'), false);
});

test('devMode appends zero switches regardless of env or platform', () => {
  const { app, calls } = makeApp();
  const info = applyGpuCommandLine(
    app,
    true,
    { NTF_GPU_MODE: 'off', NTF_GPU_GL: 'egl', NTF_GPU_VULKAN: 'on' },
    'linux',
  );
  assert.equal(calls.length, 0);
  assert.equal(info.wayland, false);
  assert.equal(info.vaapi, false);
  assert.deepEqual(info.switches, []);
});

test('non-Linux omits ozone/gl/angle while keeping VA-API parity', () => {
  const info = resolveGpuPlan(false, { NTF_GPU_MODE: 'on', NTF_GPU_GL: 'egl', NTF_GPU_ANGLE: 'gl' }, 'win32');
  assert.equal(info.wayland, false);
  assert.equal(info.vaapi, true);
  assert.deepEqual(info.switches, [['enable-features', BASE_FEATURES]]);
});

test('Wayland GL/ANGLE/Vulkan toggles merge Vulkan into single enable-features switch', () => {
  const { app, calls } = makeApp();
  const info = applyGpuCommandLine(
    app,
    false,
    { NTF_GPU_GL: 'angle', NTF_GPU_ANGLE: 'gles', NTF_GPU_VULKAN: 'on' },
    'linux',
  );
  assert.equal(info.gl, 'angle');
  assert.equal(info.angle, 'gles');
  assert.equal(info.vulkan, true);
  const featureCalls = calls.filter(([k]) => k === 'enable-features');
  assert.equal(featureCalls.length, 1);
  assert.deepEqual(calls, [
    ['ozone-platform', 'wayland'],
    ['use-gl', 'angle'],
    ['use-angle', 'gles'],
    ['enable-features', `${BASE_FEATURES},Vulkan`],
  ]);
});

test('invalid GL/ANGLE allowlist values are ignored and NTF_GPU_VULKAN=off emits disable-features', () => {
  const info = resolveGpuPlan(
    false,
    { NTF_GPU_GL: 'invalid', NTF_GPU_ANGLE: 'bad', NTF_GPU_VULKAN: 'off' },
    'linux',
  );
  assert.equal(info.gl, null);
  assert.equal(info.angle, null);
  assert.equal(info.vulkan, false);
  assert.deepEqual(info.switches, [
    ['ozone-platform', 'wayland'],
    ['enable-features', BASE_FEATURES],
    ['disable-features', 'Vulkan'],
  ]);
});

test('enable-features never repeats a dead or misspelled Chromium feature name', () => {
  const info = resolveGpuPlan(false, {}, 'linux');
  const enabled = info.switches.find(([k]) => k === 'enable-features')[1];
  // `VaapiVideoDecoder` was removed from Chromium before 156; `AcceleratedVideoDecodeLinux` is the
  // C++ identifier while the string layer resolves is `AcceleratedVideoDecoder`. Both would be a
  // silent no-op, so pin the resolved list instead of trusting the source.
  assert.equal(enabled.includes('VaapiVideoDecoder'), false);
  assert.equal(enabled.includes('AcceleratedVideoDecodeLinux,'), false);
  assert.equal(enabled, BASE_FEATURES);
});

test('NTF_GPU_NVIDIA adds VaapiOnNvidiaGPUs only when explicitly enabled', () => {
  const off = resolveGpuPlan(false, {}, 'linux');
  assert.equal(off.nvidiaVaapi, null);
  assert.equal(off.switches[1][1].includes('VaapiOnNvidiaGPUs'), false);

  const on = resolveGpuPlan(false, { NTF_GPU_NVIDIA: 'on', NTF_GPU_VULKAN: 'on' }, 'linux');
  assert.equal(on.nvidiaVaapi, true);
  assert.deepEqual(on.switches, [
    ['ozone-platform', 'wayland'],
    ['enable-features', `${BASE_FEATURES},VaapiOnNvidiaGPUs,Vulkan`],
  ]);

  const stillOff = resolveGpuPlan(false, { NTF_GPU_MODE: 'off', NTF_GPU_NVIDIA: 'on' }, 'linux');
  assert.equal(stillOff.nvidiaVaapi, null);
  assert.equal(stillOff.switches.some(([k]) => k === 'enable-features'), false);
});
