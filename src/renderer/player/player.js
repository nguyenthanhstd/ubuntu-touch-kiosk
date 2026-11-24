// Curated video player. Reads ?v=<id> and points the embed at that video.
// Runs in the service view's own partition with contextIsolation on and no Node access.
const DEFAULT_ID = 'aqz-KE-bpKQ';
const SAFE_ID = /^[A-Za-z0-9_-]{6,20}$/;

const params = new URLSearchParams(window.location.search);
const raw = params.get('v') ?? '';
const videoId = SAFE_ID.test(raw) ? raw : DEFAULT_ID;

const frame = document.getElementById('player');
if (frame) {
  const host = params.get('nocookie') === '1' ? 'www.youtube-nocookie.com' : 'www.youtube.com';
  frame.src = `https://${host}/embed/${videoId}?autoplay=1&mute=1&rel=0&playsinline=1&enablejsapi=1`;
}
