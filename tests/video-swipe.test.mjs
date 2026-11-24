import test from 'node:test';
import assert from 'node:assert/strict';
import { isVideoSwipeUrl } from '../dist/main/swipe-target.js';
import { SERVICES } from '../dist/shared/services.js';

test('TikTok luôn được nhận, kể cả tên miền con', () => {
  assert.equal(isVideoSwipeUrl('https://www.tiktok.com/@user/video/123'), true);
  assert.equal(isVideoSwipeUrl('https://tiktok.com/'), true);
  assert.equal(isVideoSwipeUrl('https://m.tiktok.com/'), true);
});

test('Facebook chỉ nhận trên đường dẫn reel', () => {
  assert.equal(isVideoSwipeUrl('https://www.facebook.com/reel/1234567890'), true);
  assert.equal(isVideoSwipeUrl('https://facebook.com/reel/'), true);
  assert.equal(isVideoSwipeUrl('https://m.facebook.com/reel/123'), true);
  assert.equal(isVideoSwipeUrl('https://www.facebook.com/'), false);
  assert.equal(isVideoSwipeUrl('https://www.facebook.com/watch/'), false);
  assert.equal(isVideoSwipeUrl('https://www.facebook.com/marketplace'), false);
});

test('tên miền giả dạng bị từ chối', () => {
  assert.equal(isVideoSwipeUrl('https://tiktok.com.evil.test/'), false);
  assert.equal(isVideoSwipeUrl('https://eviltiktok.com/'), false);
  assert.equal(isVideoSwipeUrl('https://facebook.com.evil.test/reel/1'), false);
  assert.equal(isVideoSwipeUrl('https://evil.test/https://tiktok.com/'), false);
});

test('giao thức không phải https bị từ chối', () => {
  assert.equal(isVideoSwipeUrl('http://www.tiktok.com/'), false);
  assert.equal(isVideoSwipeUrl('file:///home/kiosk/x.html'), false);
  assert.equal(isVideoSwipeUrl('javascript:alert(1)'), false);
});

test('URL hỏng không ném lỗi, chỉ trả false', () => {
  assert.equal(isVideoSwipeUrl(''), false);
  assert.equal(isVideoSwipeUrl('about:blank'), false);
  assert.equal(isVideoSwipeUrl('khong-phai-url'), false);
});

test('trang khác không bị ảnh hưởng', () => {
  assert.equal(isVideoSwipeUrl('https://www.google.com/search?q=x'), false);
  assert.equal(isVideoSwipeUrl('https://www.youtube.com/watch?v=x'), false);
  assert.equal(isVideoSwipeUrl('https://vnexpress.net/'), false);
});

test('ô TikTok mở bảng cuộn /foryou, không phải lưới /explore', () => {
  // Chỉ `/foryou` có khung `scroll-snap-type: y mandatory` để mỗi lần vuốt đổi một video.
  // `/explore` là lưới ảnh thu nhỏ: cuộn được nhưng `video.currentSrc` không đổi.
  assert.equal(SERVICES.tiktok.startUrl, 'https://www.tiktok.com/foryou');
  assert.equal(SERVICES.tiktok.startUrl.endsWith('/explore'), false);
  assert.equal(isVideoSwipeUrl(SERVICES.tiktok.startUrl), true);
});