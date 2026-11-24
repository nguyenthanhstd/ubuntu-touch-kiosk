import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareFirefoxProfile } from '../dist/main/firefox-prefs.js';

function evalUserJs(content) {
  const prefs = {};
  vm.runInNewContext(content, { user_pref: (k, v) => { prefs[k] = v; } });
  return prefs;
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ntf-ff-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('missing baseDir returns foundBaseDir false without throwing', () => {
  const missing = join(tmpdir(), 'ntf-ff-definitely-missing-xyz');
  const res = prepareFirefoxProfile({ baseDir: missing });
  assert.equal(res.foundBaseDir, false);
  assert.deepEqual(res.profiles, []);
  assert.deepEqual(res.errors, []);
});

test('discovers profiles from profiles.ini (relative/absolute/Install) and *.default* scan deduplicated', () => {
  withTempDir((baseDir) => {
    const absProfile = join(baseDir, 'custom-abs');
    const relProfile = join(baseDir, 'd7fjoj72.default');
    const extraDefault = join(baseDir, 'abc.default-release');
    mkdirSync(absProfile);
    mkdirSync(relProfile);
    mkdirSync(extraDefault);
    writeFileSync(
      join(baseDir, 'profiles.ini'),
      [
        '[Profile0]',
        'IsRelative=1',
        'Path=d7fjoj72.default',
        '[Profile1]',
        'IsRelative=0',
        `Path=${absProfile}`,
        '[Install4F96D1932A9F858E]',
        'Default=d7fjoj72.default',
      ].join('\n'),
    );
    const res = prepareFirefoxProfile({ baseDir });
    assert.equal(res.foundBaseDir, true);
    assert.equal(res.profiles.length, 3);
    assert.equal(new Set(res.profiles).size, 3);
    assert.equal(res.errors.length, 0);
  });
});

test('creates user.js when absent and enforces both crash-restore prefs', () => {
  withTempDir((baseDir) => {
    const prof = join(baseDir, 'd7fjoj72.default');
    mkdirSync(prof);
    const res = prepareFirefoxProfile({ baseDir });
    const content = readFileSync(join(prof, 'user.js'), 'utf8');
    assert.equal(res.userJsUpdated.length, 1);
    assert.ok(content.includes('user_pref("browser.sessionstore.resume_from_crash", false);'));
    assert.ok(content.includes('user_pref("toolkit.startup.max_resumed_crashes", -1);'));
  });
});

test('preserves comments/unrelated prefs, overrides conflicting and duplicate lines, and is idempotent', () => {
  withTempDir((baseDir) => {
    const prof = join(baseDir, 'd7fjoj72.default');
    mkdirSync(prof);
    const userJsPath = join(prof, 'user.js');
    writeFileSync(
      userJsPath,
      [
        '// kiosk comment',
        'user_pref("browser.startup.homepage", "https://example.com");',
        'user_pref("browser.sessionstore.resume_from_crash", true);',
        "user_pref('browser.sessionstore.resume_from_crash', true);",
        '',
      ].join('\n'),
    );
    const first = prepareFirefoxProfile({ baseDir });
    assert.deepEqual(first.userJsUpdated, [userJsPath]);
    const afterFirst = readFileSync(userJsPath, 'utf8');
    assert.ok(afterFirst.includes('// kiosk comment'));
    assert.ok(afterFirst.includes('user_pref("browser.startup.homepage", "https://example.com");'));
    assert.equal(afterFirst.match(/resume_from_crash/g)?.length, 1);
    assert.ok(afterFirst.includes('user_pref("browser.sessionstore.resume_from_crash", false);'));
    assert.ok(afterFirst.includes('user_pref("toolkit.startup.max_resumed_crashes", -1);'));

    const second = prepareFirefoxProfile({ baseDir });
    assert.deepEqual(second.userJsUpdated, []);
    assert.equal(readFileSync(userJsPath, 'utf8'), afterFirst);
  });
});

test('clears sessionstore-backups files and sessionstore.jsonlz4 while keeping core profile files', () => {
  withTempDir((baseDir) => {
    const prof = join(baseDir, 'd7fjoj72.default');
    const backups = join(prof, 'sessionstore-backups');
    mkdirSync(backups, { recursive: true });
    for (const f of ['recovery.jsonlz4', 'recovery.baklz4', 'previous.jsonlz4', 'upgrade.jsonlz4-2026']) {
      writeFileSync(join(backups, f), 'stale');
    }
    writeFileSync(join(prof, 'sessionstore.jsonlz4'), 'stale');
    for (const keep of ['.parentlock', 'prefs.js', 'places.sqlite', 'cookies.sqlite', 'sessionCheckpoints.json']) {
      writeFileSync(join(prof, keep), 'keep');
    }

    const res = prepareFirefoxProfile({ baseDir });
    assert.equal(res.removedBackups.length, 5);
    assert.equal(existsSync(backups), true);
    assert.equal(existsSync(join(prof, 'sessionstore.jsonlz4')), false);
    assert.equal(existsSync(join(backups, 'recovery.jsonlz4')), false);
    for (const keep of ['.parentlock', 'prefs.js', 'places.sqlite', 'cookies.sqlite', 'sessionCheckpoints.json']) {
      assert.equal(existsSync(join(prof, keep)), true, `${keep} must be preserved`);
    }
  });
});

test('F7.2: ignores user_pref inside multi-line /* ... */ block comments and appends active prefs', () => {
  withTempDir((baseDir) => {
    const prof = join(baseDir, 'd7fjoj72.default');
    mkdirSync(prof);
    const userJsPath = join(prof, 'user.js');
    const commentBlock = '/*\nuser_pref("browser.sessionstore.resume_from_crash", true);\n*/';
    writeFileSync(userJsPath, `${commentBlock}\nuser_pref("browser.startup.homepage", "https://example.com");\n`);

    const first = prepareFirefoxProfile({ baseDir });
    assert.deepEqual(first.userJsUpdated, [userJsPath]);
    const out = readFileSync(userJsPath, 'utf8');
    assert.ok(out.includes(commentBlock), 'block comment must stay untouched');
    const prefs = evalUserJs(out);
    assert.equal(prefs['browser.sessionstore.resume_from_crash'], false);
    assert.equal(prefs['toolkit.startup.max_resumed_crashes'], -1);
    assert.equal(prefs['browser.startup.homepage'], 'https://example.com');

    const second = prepareFirefoxProfile({ baseDir });
    assert.deepEqual(second.userJsUpdated, []);
    assert.equal(readFileSync(userJsPath, 'utf8'), out);
  });
});

test('F7.3: preserves multi-line /* ... */ block comment and updates active user_pref below it', () => {
  withTempDir((baseDir) => {
    const prof = join(baseDir, 'd7fjoj72.default');
    mkdirSync(prof);
    const userJsPath = join(prof, 'user.js');
    const commentBlock = '/*\nuser_pref("browser.sessionstore.resume_from_crash", true);\n*/';
    writeFileSync(userJsPath, `${commentBlock}\nuser_pref("browser.sessionstore.resume_from_crash", true);\n`);

    const first = prepareFirefoxProfile({ baseDir });
    assert.deepEqual(first.userJsUpdated, [userJsPath]);
    const out = readFileSync(userJsPath, 'utf8');
    assert.ok(out.includes(commentBlock), 'block comment must stay untouched');
    const prefs = evalUserJs(out);
    assert.equal(prefs['browser.sessionstore.resume_from_crash'], false);
    assert.equal(prefs['toolkit.startup.max_resumed_crashes'], -1);

    const second = prepareFirefoxProfile({ baseDir });
    assert.deepEqual(second.userJsUpdated, []);
    assert.equal(readFileSync(userJsPath, 'utf8'), out);
  });
});

test('F7.4: rewrites only matched user_pref span when multiple statements share one line', () => {
  withTempDir((baseDir) => {
    const prof = join(baseDir, 'd7fjoj72.default');
    mkdirSync(prof);
    const userJsPath = join(prof, 'user.js');
    writeFileSync(
      userJsPath,
      'user_pref("browser.sessionstore.resume_from_crash", true); user_pref("browser.startup.homepage", "https://keep.me");\n',
    );

    const first = prepareFirefoxProfile({ baseDir });
    assert.deepEqual(first.userJsUpdated, [userJsPath]);
    const out = readFileSync(userJsPath, 'utf8');
    const prefs = evalUserJs(out);
    assert.equal(prefs['browser.sessionstore.resume_from_crash'], false);
    assert.equal(prefs['toolkit.startup.max_resumed_crashes'], -1);
    assert.equal(prefs['browser.startup.homepage'], 'https://keep.me');

    const second = prepareFirefoxProfile({ baseDir });
    assert.deepEqual(second.userJsUpdated, []);
    assert.equal(readFileSync(userJsPath, 'utf8'), out);
  });
});
