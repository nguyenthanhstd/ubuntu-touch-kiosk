import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL_LOCK_STATE,
  UNLOCK_ARM_MS,
  canUnlockAt,
  decide,
} from '../dist/main/lock-state.js';

/** Đi qua một chuỗi sự kiện, trả trạng thái cuối — để ca kiểm đọc như kịch bản. */
function run(...events) {
  return events.reduce((state, event) => decide(state, event), INITIAL_LOCK_STATE);
}

test('panel bắt đầu ở trạng thái dùng được', () => {
  assert.equal(INITIAL_LOCK_STATE.phase, 'awake');
  assert.equal(INITIAL_LOCK_STATE.lockedAt, 0);
});

test('hết giờ nhàn rỗi đưa panel vào màn hình chờ', () => {
  const state = run({ type: 'idle', at: 600_000 });
  assert.equal(state.phase, 'locked');
  assert.equal(state.lockedAt, 600_000);
  assert.equal(canUnlockAt(state, 600_000 + UNLOCK_ARM_MS), true);
});

test('nút Khóa ghi lại đúng mốc thời gian', () => {
  const state = run({ type: 'lock', at: 1000 });
  assert.equal(state.phase, 'locked');
  assert.equal(state.lockedAt, 1000);
});

test('chạm ngay sau khi khóa không mở khóa', () => {
  const locked = run({ type: 'lock', at: 1000 });
  // Đây là ngón tay còn đang đặt trên ô dock lúc khóa, không phải ý định mở khóa.
  assert.equal(canUnlockAt(locked, 1000), false);
  assert.equal(canUnlockAt(locked, 1000 + UNLOCK_ARM_MS - 1), false);
  assert.equal(decide(locked, { type: 'unlock', at: 1000 + UNLOCK_ARM_MS - 1 }).phase, 'locked');
});

test('chạm sau cửa sổ chống nhầm thì mở khóa', () => {
  const locked = run({ type: 'lock', at: 1000 });
  assert.equal(canUnlockAt(locked, 1000 + UNLOCK_ARM_MS), true);
  assert.deepEqual(decide(locked, { type: 'unlock', at: 1000 + UNLOCK_ARM_MS }), INITIAL_LOCK_STATE);
});

test('nhàn rỗi lặp lại khi đã khóa không gia hạn cửa sổ chống mở-khóa-nhầm', () => {
  const locked = run({ type: 'lock', at: 1000 });
  // Nếu `idle` đặt lại `lockedAt` thì mỗi nhịp bộ đếm sẽ chặn người dùng thật mở khóa mãi mãi.
  const again = decide(locked, { type: 'idle', at: 60_000 });
  assert.equal(again, locked);
  assert.equal(canUnlockAt(again, 1000 + UNLOCK_ARM_MS), true);
});

test('khóa hai lần liên tiếp giữ nguyên mốc ban đầu', () => {
  const locked = run({ type: 'lock', at: 1000 });
  assert.equal(decide(locked, { type: 'lock', at: 5000 }), locked);
});

test('mở khóa khi đang dùng được là vô hại', () => {
  assert.equal(decide(INITIAL_LOCK_STATE, { type: 'unlock', at: 9999 }), INITIAL_LOCK_STATE);
  assert.equal(canUnlockAt(INITIAL_LOCK_STATE, 9999), false);
});

test('thao tác khi đang khóa không tự đổi trạng thái', () => {
  const locked = run({ type: 'lock', at: 1000 });
  assert.equal(decide(locked, { type: 'activity', at: 2000 }), locked);
});

test('trạng thái không đổi thì trả về đúng object cũ (nơi gọi so tham chiếu)', () => {
  // Nhịp nhàn rỗi phát `activity` vài lần mỗi giây; trả object mới mỗi lần sẽ vẽ lại vô ích.
  assert.equal(decide(INITIAL_LOCK_STATE, { type: 'activity', at: 10 }), INITIAL_LOCK_STATE);
  const locked = run({ type: 'lock', at: 1000 });
  assert.equal(decide(locked, { type: 'activity', at: 2000 }), locked);
  assert.equal(decide(locked, { type: 'unlock', at: 1001 }), locked);
});

test('đi vòng khóa rồi mở khóa trở về đúng trạng thái ban đầu', () => {
  const locked = run({ type: 'lock', at: 1000 });
  const awake = decide(locked, { type: 'unlock', at: 60_000 });
  assert.deepEqual(awake, INITIAL_LOCK_STATE);
  // Mở khóa xong khóa lại được, và mốc mới là mốc mới chứ không dính mốc cũ.
  assert.deepEqual(decide(awake, { type: 'lock', at: 61_000 }), { phase: 'locked', lockedAt: 61_000 });
});
