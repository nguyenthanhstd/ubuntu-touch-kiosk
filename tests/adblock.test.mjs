import test from 'node:test';
import assert from 'node:assert/strict';
import { ADBLOCK_EMPTY, parseAdblockStats } from '../dist/main/adblock.js';

/**
 * Tệp JSON này do root ghi, nhưng hình dạng của nó phụ thuộc API AdGuard — thứ có thể đổi khi nâng
 * cấp AdGuard. Một khoá đổi tên phải làm panel hiện "—", không được làm thẻ Cài đặt vỡ hay hiện `NaN`.
 */

test('đọc đúng tệp số liệu bình thường', () => {
  const stats = parseAdblockStats(
    JSON.stringify({
      ok: true,
      at: 1795492731,
      queries: 8,
      blocked: 2,
      percent: 25,
      topBlocked: [['doubleclick.net', 2]],
      topQueried: [['vnexpress.net', 2]],
      topClients: [['192.0.2.10', 6]],
      adminUrl: 'http://192.0.2.10:3000',
    }),
  );
  assert.equal(stats.ok, true);
  assert.equal(stats.blocked, 2);
  assert.equal(stats.percent, 25);
  assert.deepEqual(stats.topBlocked, [{ domain: 'doubleclick.net', count: 2 }]);
  assert.equal(stats.adminUrl, 'http://192.0.2.10:3000');
});

test('tệp rỗng nghĩa là chưa có số liệu, không phải 0 lượt chặn', () => {
  assert.deepEqual(parseAdblockStats('{}'), ADBLOCK_EMPTY);
});

test('khoá bị đổi tên thì trả về rỗng thay vì NaN', () => {
  // AdGuard đổi `num_blocked_filtering` thành `num_blocked` chẳng hạn — bộ thu thập ghi khoá cũ,
  // panel vẫn phải vẽ được.
  const stats = parseAdblockStats(JSON.stringify({ ok: true, at: 5, blocked: 'hai', queries: null }));
  assert.equal(stats.blocked, 0);
  assert.equal(stats.queries, 0);
  assert.equal(stats.at, 5);
});

test('số âm và số thực được chuẩn hoá', () => {
  const stats = parseAdblockStats(JSON.stringify({ ok: true, at: -3, queries: 10.7, blocked: 2.4, percent: 140 }));
  assert.equal(stats.at, 0);
  assert.equal(stats.queries, 11);
  assert.equal(stats.blocked, 2);
  // Tỉ lệ chặn không thể vượt 100 dù AdGuard trả gì.
  assert.equal(stats.percent, 100);
});

test('hàng danh sách sai hình dạng bị bỏ, không làm hỏng cả danh sách', () => {
  const stats = parseAdblockStats(
    JSON.stringify({
      ok: true,
      at: 1,
      topBlocked: [['ads.example', 4], 'rác', ['', 9], [null, 1], ['ok.example', 'x']],
    }),
  );
  assert.deepEqual(stats.topBlocked, [
    { domain: 'ads.example', count: 4 },
    { domain: 'ok.example', count: 0 },
  ]);
});

test('JSON hỏng thì để lỗi nổi lên cho nơi gọi bắt', () => {
  // readAdblockStats bắt lỗi này và trả ADBLOCK_EMPTY; ở đây kiểm rằng parse không tự nuốt lỗi,
  // nếu không thì một tệp cụt sẽ lặng lẽ thành "0 lượt chặn" mà không ai biết.
  assert.throws(() => parseAdblockStats('{"ok":'));
});

test('giá trị không phải object thì thành rỗng', () => {
  assert.deepEqual(parseAdblockStats('null'), ADBLOCK_EMPTY);
  assert.deepEqual(parseAdblockStats('[1,2]'), ADBLOCK_EMPTY);
  assert.deepEqual(parseAdblockStats('"chuỗi"'), ADBLOCK_EMPTY);
});
