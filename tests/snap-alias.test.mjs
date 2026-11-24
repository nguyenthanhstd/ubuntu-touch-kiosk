import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesExternalPrefix, resolveSnapBinary, snapNameOf } from '../dist/main/snap-alias.js';

const FIREFOX = '/snap/firefox/';
const CHROMIUM = '/snap/chromium/';
const FREETUBE = '/opt/FreeTube/freetube';

test('snapNameOf reads only a bare /snap/bin/<name> shim', () => {
  assert.equal(snapNameOf('/snap/bin/firefox'), 'firefox');
  assert.equal(snapNameOf('/snap/bin/chromium/'), 'chromium');
  assert.equal(snapNameOf('/snap/bin/'), null);
  assert.equal(snapNameOf('/snap/bin'), null);
  assert.equal(snapNameOf('/snap/firefox/6063/firefox'), null);
  assert.equal(snapNameOf('/usr/bin/firefox'), null);
  assert.equal(snapNameOf('firefox'), null);
});

test('resolveSnapBinary maps the shim to the resolved path /proc reports', () => {
  assert.equal(resolveSnapBinary('/snap/bin/firefox'), '/snap/firefox/');
  assert.equal(resolveSnapBinary('/snap/bin/chromium'), '/snap/chromium/');
});

test('resolveSnapBinary leaves non-snap binaries untouched', () => {
  assert.equal(resolveSnapBinary('/usr/bin/firefox'), '/usr/bin/firefox');
  assert.equal(resolveSnapBinary(FREETUBE), FREETUBE);
  assert.equal(resolveSnapBinary('/snap/firefox/6063/firefox'), '/snap/firefox/6063/firefox');
});

test('QA09-03: the dock shim matches its EXTERNAL_PROCS prefix', () => {
  assert.equal(matchesExternalPrefix('/snap/bin/firefox', FIREFOX), true);
  assert.equal(matchesExternalPrefix('/snap/bin/chromium', CHROMIUM), true);
});

test('resolved cmdline paths keep matching (regression: /proc reporting)', () => {
  assert.equal(matchesExternalPrefix('/snap/firefox/6063/usr/lib/firefox/firefox', FIREFOX), true);
  assert.equal(matchesExternalPrefix('/snap/chromium/3100/chrome', CHROMIUM), true);
  assert.equal(matchesExternalPrefix(FREETUBE, FREETUBE), true);
});

test('unknown paths still return no match', () => {
  assert.equal(matchesExternalPrefix('/usr/bin/gedit', FIREFOX), false);
  assert.equal(matchesExternalPrefix('/snap/bin/gedit', FIREFOX), false);
  assert.equal(matchesExternalPrefix('/usr/bin/firefox', FIREFOX), false);
  assert.equal(matchesExternalPrefix('', FIREFOX), false);
});

test('a firefox shim does not match the chromium prefix and vice versa', () => {
  assert.equal(matchesExternalPrefix('/snap/bin/firefox', CHROMIUM), false);
  assert.equal(matchesExternalPrefix('/snap/bin/chromium', FIREFOX), false);
});
