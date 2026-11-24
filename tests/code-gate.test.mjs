import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE_LOCKOUT_MS,
  CODE_MAX_LEN,
  CODE_MIN_LEN,
  CodeAttempts,
  MAX_CODE_ATTEMPTS,
  codeIsValid,
} from '../dist/main/code-gate.js';
import { CodeGuard } from '../dist/main/code-guard.js';

test('mã đúng độ dài và toàn chữ số được chấp nhận', () => {
  assert.equal(codeIsValid('4242'), true);
  assert.equal(codeIsValid('0'.repeat(CODE_MIN_LEN)), true);
  assert.equal(codeIsValid('9'.repeat(CODE_MAX_LEN)), true);
});

test('mã sai độ dài bị từ chối', () => {
  assert.equal(codeIsValid('1'.repeat(CODE_MIN_LEN - 1)), false);
  assert.equal(codeIsValid('1'.repeat(CODE_MAX_LEN + 1)), false);
});

test('mã có ký tự không phải chữ số bị từ chối', () => {
  // `Number()` nhận cả ba giá trị dưới đây, nên đây là ca phân biệt hai cách kiểm.
  for (const bad of ['12 1', ' 4242', '4242 ', '42e4', '12.1', 'abcd', '-424', '+424', '', '\n4242']) {
    assert.equal(codeIsValid(bad), false, `phải từ chối ${JSON.stringify(bad)}`);
  }
});

test('giá trị không phải chuỗi bị từ chối', () => {
  for (const bad of [4242, null, undefined, {}, [], true, NaN]) {
    assert.equal(codeIsValid(bad), false);
  }
});

test('bộ đếm chưa chặn trước ngưỡng', () => {
  const attempts = new CodeAttempts(() => 1000);
  for (let i = 1; i < MAX_CODE_ATTEMPTS; i += 1) {
    assert.equal(attempts.recordFailure(), 0, `lần sai thứ ${i} chưa được chặn`);
    assert.equal(attempts.blockedFor(), 0);
  }
});

test('lần sai thứ MAX_CODE_ATTEMPTS thì chặn đúng CODE_LOCKOUT_MS', () => {
  const attempts = new CodeAttempts(() => 1000);
  for (let i = 1; i < MAX_CODE_ATTEMPTS; i += 1) attempts.recordFailure();
  assert.equal(attempts.recordFailure(), CODE_LOCKOUT_MS);
  assert.equal(attempts.blockedFor(), CODE_LOCKOUT_MS);
});

test('hết hạn chặn thì cho thử lại, và số lần sai đã được xoá', () => {
  let now = 1000;
  const attempts = new CodeAttempts(() => now);
  for (let i = 0; i < MAX_CODE_ATTEMPTS; i += 1) attempts.recordFailure();

  now += CODE_LOCKOUT_MS - 1;
  assert.equal(attempts.blockedFor(), 1);

  now += 1;
  assert.equal(attempts.blockedFor(), 0);
  // Nếu bộ đếm không xoá thì lần sai kế tiếp sẽ chặn ngay, và người đúng mã không bao giờ vào được.
  assert.equal(attempts.recordFailure(), 0);
  assert.equal(attempts.blockedFor(), 0);
});

test('nhập đúng xoá sạch cả bộ đếm lẫn hạn chặn', () => {
  const attempts = new CodeAttempts(() => 1000);
  for (let i = 1; i < MAX_CODE_ATTEMPTS; i += 1) attempts.recordFailure();
  attempts.recordSuccess();
  assert.equal(attempts.blockedFor(), 0);
  for (let i = 1; i < MAX_CODE_ATTEMPTS; i += 1) {
    assert.equal(attempts.recordFailure(), 0);
  }
  assert.equal(attempts.recordFailure(), CODE_LOCKOUT_MS);
});

test('cửa kiểm: mã đúng trả ok', async () => {
  const guard = new CodeGuard(async (code) => code === '4242', () => 1000);
  assert.deepEqual(await guard.check('4242'), { ok: true });
});

test('cửa kiểm: mã sai trả câu "Sai mã" và không gọi lại lần hai', async () => {
  let calls = 0;
  const guard = new CodeGuard(async (code) => {
    calls += 1;
    return code === '4242';
  }, () => 1000);
  assert.deepEqual(await guard.check('9999'), { ok: false, message: 'Sai mã' });
  assert.equal(calls, 1);
});

test('cửa kiểm: chặn sau ngưỡng và câu chặn có số giây', async () => {
  let now = 1000;
  const guard = new CodeGuard(async () => false, () => now);
  for (let i = 1; i < MAX_CODE_ATTEMPTS; i += 1) {
    const verdict = await guard.check('9999');
    assert.equal(verdict.ok, false);
    assert.equal(verdict.message, 'Sai mã');
  }
  const last = await guard.check('9999');
  assert.equal(last.ok, false);
  assert.match(last.message, /Sai mã quá nhiều lần, thử lại sau 30 giây/);

  // Trong thời gian bị chặn thì không được gọi tới sudo, kể cả với mã đúng. Hàm kiểm phải trả `false`
  // cho mã sai: một hàm luôn trả `true` sẽ xoá bộ đếm sau mỗi lần "sai", nên guard không bao giờ chặn.
  let called = 0;
  const counting = new CodeGuard(async (code) => {
    called += 1;
    return code === '4242';
  }, () => now);
  for (let i = 0; i < MAX_CODE_ATTEMPTS; i += 1) await counting.check('0000');
  called = 0;
  const duringBlock = await counting.check('4242');
  assert.equal(duringBlock.ok, false);
  assert.equal(called, 0, 'đang bị chặn thì mã đúng cũng không được kiểm');

  now += CODE_LOCKOUT_MS;
  assert.deepEqual(await counting.check('4242'), { ok: true });
});

test('cửa kiểm: hàm kiểm ném lỗi thì coi như sai, không ném ra ngoài', async () => {
  const guard = new CodeGuard(async () => {
    throw new Error('không spawn được sudo');
  }, () => 1000);
  const verdict = await guard.check('4242');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.message, 'Sai mã');
});
test('mã sai liên tiếp đủ ngưỡng thì lần sau bị chặn, dù đúng mã', async () => {
  // Ca hồi quy này bắt đúng một lỗi thật đã gặp trên panel: `power.ts` xoá con trỏ hành động sau lần
  // sai đầu tiên, nên lần gõ lại rơi vào nhánh "không rõ cần làm gì" và bộ đếm không bao giờ tới ngưỡng
  // chặn. Ở đây gọi thẳng cửa kiểm nhiều lần liên tiếp — mỗi lần sai phải được đếm.
  let calls = 0;
  const guard = new CodeGuard(async (code) => {
    calls += 1;
    return code === '4242';
  });
  for (let i = 0; i < MAX_CODE_ATTEMPTS; i += 1) {
    const verdict = await guard.check('9999');
    assert.equal(verdict.ok, false, `lần sai ${i + 1} phải bị từ chối`);
  }
  assert.equal(calls, MAX_CODE_ATTEMPTS, 'mỗi lần sai phải thực sự gọi phép kiểm');
  const blocked = await guard.check('4242');
  assert.equal(blocked.ok, false, 'đang bị chặn thì mã đúng cũng không qua cửa');
  assert.match(blocked.message, /thử lại sau \d+ giây/);
  assert.equal(calls, MAX_CODE_ATTEMPTS, 'bị chặn thì không được gọi phép kiểm nữa');
});

test('mã đúng xoá sạch số lần sai trước đó', async () => {
  const guard = new CodeGuard(async (code) => code === '4242');
  for (let i = 0; i < MAX_CODE_ATTEMPTS - 1; i += 1) await guard.check('9999');
  assert.equal((await guard.check('4242')).ok, true);
  // Sau khi qua cửa, ngưỡng phải được đặt lại — nếu không thì một người dùng đúng mã vẫn bị chặn oan
  // ở lần sai kế tiếp.
  for (let i = 0; i < MAX_CODE_ATTEMPTS - 1; i += 1) {
    assert.equal((await guard.check('9999')).ok, false);
  }
  assert.equal((await guard.check('4242')).ok, true);
});
