import test from 'node:test';
import assert from 'node:assert/strict';
import { isExternalMinimized } from '../dist/main/toplevel-state.js';
import { frontExternalApp, noteActiveExternal } from '../dist/main/external-apps.js';

const group = (id, label, startedAt) => ({ id, label, pids: [100], startedAt });

test('isExternalMinimized returns false on empty appIds or missing wlrctl', async () => {
  assert.equal(await isExternalMinimized([]), false);
  assert.equal(await isExternalMinimized(['freetube'], { resolveIds: async (ids) => ids }), false);
});

test('isExternalMinimized returns true for single minimized window', async () => {
  const calls = [];
  const res = await isExternalMinimized(['freetube'], {
    resolveIds: async (ids) => ids,
    runWlrctl: async (args) => {
      calls.push(args);
      return args.includes('state:minimized');
    },
  });
  assert.equal(res, true);
  assert.equal(calls.length, 2);
});

test('isExternalMinimized returns false immediately when state:minimized does not match', async () => {
  const calls = [];
  const res = await isExternalMinimized(['freetube'], {
    resolveIds: async (ids) => ids,
    runWlrctl: async (args) => {
      calls.push(args);
      return false;
    },
  });
  assert.equal(res, false);
  assert.deepEqual(calls, [['toplevel', 'find', 'app_id:freetube', 'state:minimized']]);
});

test('isExternalMinimized returns false for multi-window app with one visible window', async () => {
  const sameId = await isExternalMinimized(['firefox_firefox'], {
    resolveIds: async (ids) => ids,
    runWlrctl: async () => true,
  });
  assert.equal(sameId, false);

  const multiId = await isExternalMinimized(['firefox_firefox', 'Navigator'], {
    resolveIds: async (ids) => ids,
    runWlrctl: async (args) =>
      (args.includes('app_id:firefox_firefox') && args.includes('state:minimized')) ||
      (args.includes('app_id:Navigator') && args.includes('state:unminimized')),
  });
  assert.equal(multiId, false);
});

test('isExternalMinimized iterates candidate appIds until a minimized match is found', async () => {
  const res = await isExternalMinimized(['freetube', 'FreeTube'], {
    resolveIds: async (ids) => ids,
    runWlrctl: async (args) => args.includes('app_id:FreeTube') && args.includes('state:minimized'),
  });
  assert.equal(res, true);
});

test('QA09-04: single minimized app returns null instead of short-circuiting', async () => {
  const res = await frontExternalApp({
    scanGroups: () => [group('freetube', 'FreeTube', 100)],
    appIdsFor: () => ['freetube'],
    isMinimized: async () => true,
    activeGroup: async () => null,
  });
  assert.equal(res, null);
});

test('single visible app returns that app', async () => {
  const ft = group('freetube', 'FreeTube', 100);
  const res = await frontExternalApp({
    scanGroups: () => [ft],
    appIdsFor: () => ['freetube'],
    isMinimized: async () => false,
    activeGroup: async () => null,
  });
  assert.equal(res?.id, 'freetube');
});

test('two minimized apps return null even when lastActiveId is set', async () => {
  noteActiveExternal('freetube');
  const res = await frontExternalApp({
    scanGroups: () => [group('freetube', 'FreeTube', 100), group('firefox', 'Firefox', 200)],
    appIdsFor: (id) => [id],
    isMinimized: async () => true,
    activeGroup: async () => null,
  });
  assert.equal(res, null);
});

test('one minimized and one visible picks visible app even if minimized is newer and lastActive', async () => {
  noteActiveExternal('freetube');
  const res = await frontExternalApp({
    scanGroups: () => [group('freetube', 'FreeTube', 999), group('firefox', 'Firefox', 100)],
    appIdsFor: (id) => [id],
    isMinimized: async (ids) => ids[0] === 'freetube',
    activeGroup: async () => null,
  });
  assert.equal(res?.id, 'firefox');
});

test('two visible apps prefer activeGroup and fall back only among unminimized groups', async () => {
  const ft = group('freetube', 'FreeTube', 100);
  const ff = group('firefox', 'Firefox', 200);
  const activeRes = await frontExternalApp({
    scanGroups: () => [ft, ff],
    appIdsFor: (id) => [id],
    isMinimized: async () => false,
    activeGroup: async () => ft,
  });
  assert.equal(activeRes?.id, 'freetube');

  noteActiveExternal('freetube');
  const fallbackRes = await frontExternalApp({
    scanGroups: () => [ft, ff],
    appIdsFor: (id) => [id],
    isMinimized: async () => false,
    activeGroup: async () => null,
  });
  assert.equal(fallbackRes?.id, 'freetube');
});
