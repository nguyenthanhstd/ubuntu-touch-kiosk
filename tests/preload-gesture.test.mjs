import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { installGestures } = require('../dist/main/preload-gesture.cjs');

function setupEnv(innerHeight = 1600) {
  const listeners = new Map();
  const sent = [];
  const win = {
    innerHeight,
    addEventListener(type, fn, opts) {
      const list = listeners.get(type) ?? [];
      list.push({ fn, opts });
      listeners.set(type, list);
    },
  };
  globalThis.window = win;
  globalThis.PointerEvent = class PointerEvent {};
  const origSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  installGestures((channel, payload) => sent.push([channel, payload]));
  globalThis.setInterval = origSetInterval;

  const emit = (type, ev) => {
    for (const { fn } of listeners.get(type) ?? []) fn(ev);
  };
  const ptr = (type, pointerId, clientX, clientY, timeStamp = 100) =>
    emit(type, { pointerId, pointerType: 'touch', button: 0, clientX, clientY, timeStamp, target: win });
  const touch = (type, touches, cancelable = true, timeStamp = 100, changedTouches = touches) => {
    const ev = {
      touches,
      changedTouches,
      cancelable,
      defaultPrevented: false,
      timeStamp,
      preventDefault() {
        if (this.cancelable) this.defaultPrevented = true;
      },
    };
    emit(type, ev);
    return ev;
  };
  return { sent, ptr, touch, listeners };
}

test('ID mismatch (pointerId=2 vs touchId=0) prevents touchmove default', () => {
  const { ptr, touch } = setupEnv();
  ptr('pointerdown', 2, 8, 700, 10);
  touch('touchstart', [{ identifier: 0, clientX: 8, clientY: 700 }], false, 11);
  const mv = touch('touchmove', [{ identifier: 0, clientX: 40, clientY: 700 }], true, 20);
  assert.equal(mv.defaultPrevented, true);
});

test('touchstart-before-pointerdown ordering captures touchId without clobbering', () => {
  const { sent, ptr, touch } = setupEnv();
  touch('touchstart', [{ identifier: 0, clientX: 8, clientY: 700 }], false, 10);
  ptr('pointerdown', 5, 8, 700, 11);
  const mv = touch('touchmove', [{ identifier: 0, clientX: 40, clientY: 700 }], true, 20);
  assert.equal(mv.defaultPrevented, true);
  ptr('pointermove', 5, 40, 700, 21);
  ptr('pointermove', 5, 160, 700, 30);
  ptr('pointerup', 5, 220, 700, 40);
  assert.deepEqual(sent.map(([c]) => c), ['gesture:tap', 'gesture:back:begin', 'gesture:back:progress', 'gesture:back:fire']);
});

test('ID mismatch without touchstart still prevents via single-touch fallback', () => {
  const { ptr, touch } = setupEnv();
  ptr('pointerdown', 3, 8, 700, 10);
  const mv = touch('touchmove', [{ identifier: 0, clientX: 40, clientY: 700 }], true, 20);
  assert.equal(mv.defaultPrevented, true);
});

test('full left-edge Back swipe skips preventDefault in slop and fires at 220px', () => {
  const { sent, ptr, touch } = setupEnv();
  ptr('pointerdown', 2, 8, 700, 10);
  touch('touchstart', [{ identifier: 0, clientX: 8, clientY: 700 }], false, 11);
  assert.equal(touch('touchmove', [{ identifier: 0, clientX: 14, clientY: 700 }], true, 15).defaultPrevented, false);
  ptr('pointermove', 2, 14, 700, 16);
  for (const x of [40, 80, 140, 220]) {
    assert.equal(touch('touchmove', [{ identifier: 0, clientX: x, clientY: 700 }], true, x).defaultPrevented, true);
    ptr('pointermove', 2, x, 700, x + 1);
  }
  ptr('pointerup', 2, 220, 700, 230);
  assert.deepEqual(sent.map(([c]) => c), ['gesture:tap', 'gesture:back:begin', 'gesture:back:progress', 'gesture:back:fire']);
});

test('left-edge vertical scroll never calls preventDefault in either event order', () => {
  for (const touchFirst of [false, true]) {
    const { sent, ptr, touch } = setupEnv();
    ptr('pointerdown', 2, 10, 700, 10);
    touch('touchstart', [{ identifier: 0, clientX: 10, clientY: 700 }], false, 11);
    for (const [x, y, t] of [[12, 720, 20], [12, 760, 30]]) {
      if (touchFirst) {
        assert.equal(touch('touchmove', [{ identifier: 0, clientX: x, clientY: y }], true, t).defaultPrevented, false);
        ptr('pointermove', 2, x, y, t + 1);
      } else {
        ptr('pointermove', 2, x, y, t);
        assert.equal(touch('touchmove', [{ identifier: 0, clientX: x, clientY: y }], true, t + 1).defaultPrevented, false);
      }
    }
    ptr('pointerup', 2, 12, 760, 40);
    assert.deepEqual(sent.map(([c]) => c), ['gesture:tap']);
  }
});

test('leftward move from left edge and non-edge touch never call preventDefault', () => {
  const { sent, ptr, touch } = setupEnv();
  ptr('pointerdown', 2, 30, 700, 10);
  assert.equal(touch('touchmove', [{ identifier: 0, clientX: 10, clientY: 700 }], true, 20).defaultPrevented, false);
  ptr('pointerup', 2, 10, 700, 30);
  ptr('pointerdown', 3, 500, 700, 40);
  assert.equal(touch('touchmove', [{ identifier: 0, clientX: 650, clientY: 700 }], true, 50).defaultPrevented, false);
  ptr('pointerup', 3, 650, 700, 60);
  assert.deepEqual(sent.map(([c]) => c), ['gesture:tap', 'gesture:tap']);
});

test('dock home upward swipe prevents default and fires; horizontal dock drag resets', () => {
  const { sent, ptr, touch } = setupEnv(96);
  ptr('pointerdown', 2, 42, 82, 10);
  touch('touchstart', [{ identifier: 0, clientX: 42, clientY: 82 }], false, 11);
  assert.equal(touch('touchmove', [{ identifier: 0, clientX: 42, clientY: 66 }], true, 20).defaultPrevented, true);
  ptr('pointermove', 2, 42, 66, 21);
  assert.equal(touch('touchmove', [{ identifier: 0, clientX: 42, clientY: 10 }], true, 30).defaultPrevented, true);
  ptr('pointermove', 2, 42, 10, 31);
  ptr('pointerup', 2, 42, 10, 40);
  assert.deepEqual(sent.map(([c]) => c), ['gesture:tap', 'gesture:home:begin', 'gesture:home:progress', 'gesture:home:fire']);

  const dockHoriz = setupEnv(96);
  dockHoriz.ptr('pointerdown', 4, 42, 82, 10);
  assert.equal(dockHoriz.touch('touchmove', [{ identifier: 0, clientX: 60, clientY: 80 }], true, 20).defaultPrevented, false);
  assert.deepEqual(dockHoriz.sent.map(([c]) => c), ['gesture:tap']);
});

test('multi-touch cancels cleanly during pending and active without preventDefault', () => {
  const p = setupEnv();
  p.ptr('pointerdown', 2, 8, 700, 10);
  const mv1 = p.touch('touchmove', [{ identifier: 0, clientX: 10, clientY: 700 }, { identifier: 1, clientX: 100, clientY: 700 }], true, 20);
  assert.equal(mv1.defaultPrevented, false);
  assert.deepEqual(p.sent.map(([c]) => c), ['gesture:tap']);

  const a = setupEnv();
  a.ptr('pointerdown', 2, 8, 700, 10);
  a.ptr('pointermove', 2, 40, 700, 20);
  const mv2 = a.touch('touchmove', [{ identifier: 0, clientX: 50, clientY: 700 }, { identifier: 1, clientX: 200, clientY: 700 }], true, 30);
  assert.equal(mv2.defaultPrevented, false);
  a.ptr('pointerup', 2, 220, 700, 40);
  assert.deepEqual(a.sent.map(([c]) => c), ['gesture:tap', 'gesture:back:begin', 'gesture:back:cancel']);
});

test('non-cancelable touchmove is guarded and built preloads inline NTF_GESTURES', () => {
  const { ptr, touch } = setupEnv();
  ptr('pointerdown', 2, 8, 700, 10);
  assert.equal(touch('touchmove', [{ identifier: 0, clientX: 40, clientY: 700 }], false, 20).defaultPrevented, false);
  for (const name of ['preload-nav.cjs', 'preload-dock.cjs', 'preload-service.cjs']) {
    const code = readFileSync(new URL(`../dist/main/${name}`, import.meta.url), 'utf8');
    assert.ok(code.includes('NTF_GESTURES'), `${name} missing NTF_GESTURES`);
    assert.ok(code.includes('installGestures: NTF_GESTURES.installGestures'), `${name} missing inlined NTF_GESTURES binding`);
    assert.equal(
      /const\s+\w+\s*=\s*require\(['"]\.\/preload-gesture\.cjs['"]\)/.test(code),
      false,
      `${name} still requires preload-gesture.cjs`,
    );
  }
});
