/* Local shell page: wallpaper and the load-failure card.
 *
 * Plain script on purpose (no bundler): the shell must stay readable and auditable.
 *
 * This page sits behind everything else. Every app — News included, which is a Google News page
 * opened from the dock — is a separate view drawn above it, so all that is left to paint here is the
 * wallpaper plus the two things that must show through when no app is up: a "Đang tải…" line and
 * the failure card with its retry/home buttons. */
(() => {
  'use strict';

  const api = window.ntf;
  if (!api) {
    document.body.dataset.fatal = '1';
    const banner = document.createElement('p');
    banner.className = 'fatal';
    banner.textContent = 'Không kết nối được tiến trình chính của NT Fitness Touch.';
    document.body.append(banner);
    return;
  }

  const $ = (id) => document.getElementById(id);
  const el = {
    body: document.body,
    placeholder: $('placeholder'),
    placeholderLabel: $('placeholder-label'),
  };

  let screen = 'home';

  /* ---------- Wallpaper ---------- */

  /*
   * Every wallpaper paints the whole window. This page spans the full window behind the
   * see-through bar and dock strips, so a preset or photo runs edge to edge. A remote site still
   * paints its own background: injecting CSS into a third-party page is out of scope.
   */
  function paintWallpaper(wallpaper, image) {
    const body = el.body;
    for (const id of ['studio', 'graphite', 'noir', 'ember', 'sage', 'ocean', 'sunset', 'plum', 'custom']) {
      body.classList.remove(`wallpaper--${id}`);
    }
    body.classList.add(`wallpaper--${wallpaper || 'studio'}`);
    body.classList.remove('wallpaper--image');
    if (wallpaper === 'custom' && image) {
      // setProperty with a file URL is the only way in: the page has no node access, and the path
      // arrived from the main process after it was validated.
      body.style.setProperty('--wallpaper-image', `url("file://${image.replace(/\\/g, '/')}")`);
      body.classList.add('wallpaper--image');
    } else {
      body.style.removeProperty('--wallpaper-image');
    }
  }

  /* ---------- Screens ---------- */

  /*
   * Two states only. 'home' is the bare wallpaper; 'service' means an app view is (or is about to
   * be) drawn above this page, so only the placeholder is worth keeping around.
   */
  function showScreen(next) {
    screen = next;
    el.body.dataset.screen = next;
    el.placeholder.hidden = next !== 'service';
  }

  /* ---------- Main process events ---------- */

  /*
   * Shell commands that need the Home page itself.
   *
   * When no content view is up, `ViewManager.reload()`/`back()`/`forward()`/`stop()` have nothing to
   * act on and fall back to `ntf:navigate`. Nothing used to listen, so tapping Reload on the top bar
   * while Home was showing did nothing at all — the same dead end as pressing "Thử lại" on the
   * failure card after going Home. Handling the event here closes that gap.
   */
  api.nav.onNavigate(({ action }) => {
    if (action === 'reload') location.reload();
  });

  api.nav.onState((state) => {
    if (state.failed) {
      showScreen('service');
      renderFailure(state.failed);
      return;
    }
    if (state.serviceId || state.webAppId) {
      showScreen('service');
      el.placeholderLabel.textContent = state.loading ? 'Đang tải…' : '';
      return;
    }
    if (screen === 'service') showScreen('home');
  });

  // The keyboard covers the bottom of this page (it is not inset — a band wedged between two views
  // is the one band the compositor skips), so keep the content clear of it by that exact height.
  api.nav.onKeyboard(({ open, height }) => {
    document.documentElement.style.setProperty('--kb-reserved', open ? String(height) + 'px' : '0px');
    document.body.classList.toggle('kb-open', Boolean(open));
  });

  function renderFailure(failure) {
    el.placeholder.hidden = false;
    el.placeholderLabel.replaceChildren();
    const wrap = document.createElement('div');
    wrap.className = 'failure';
    const heading = document.createElement('p');
    heading.className = 'failure__title';
    heading.textContent = 'Trang tạm thời không mở được';
    const detail = document.createElement('p');
    detail.className = 'failure__detail';
    detail.textContent = `${failure.description} (mã ${failure.code}). Mạng có thể đang chậm, hoặc dịch vụ đang chặn máy này.`;
    const actions = document.createElement('div');
    actions.className = 'failure__actions';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'ntf-choice';
    retry.textContent = '⟳  Thử lại';
    retry.addEventListener('click', () => api.nav.reload());
    const goHome = document.createElement('button');
    goHome.type = 'button';
    goHome.className = 'ntf-choice';
    goHome.textContent = '⌂  Về trang chủ';
    goHome.addEventListener('click', () => api.nav.goHome());
    actions.append(retry, goHome);
    wrap.append(heading, detail, actions);
    el.placeholderLabel.append(wrap);
  }

  /* ---------- Boot ---------- */

  (async () => {
    const settings = await api.nav.getSettings();
    paintWallpaper(settings.wallpaper, settings.wallpaperImage);
    showScreen('home');
    void api.nav.getState();
  })();
})();