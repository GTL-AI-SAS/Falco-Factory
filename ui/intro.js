/** Play the brand film while Studio boots, with bounded waits and a skip path. */
export function createStudioIntro({ document, reducedMotion = false, timeoutMs = 8500 } = {}) {
  const overlay = document.getElementById('studioIntro');
  const app = document.getElementById('studioApp');
  const video = document.getElementById('introVideo');
  const status = document.getElementById('introStatus');
  const skip = document.getElementById('skipIntro');
  const film = document.getElementById('brandFilm');
  let ready = false;
  let finished = false;
  let active = false;
  let timer;
  let fadeTimer;
  let closing = false;
  let previousFocus;
  let serial = 0;

  function finishDismiss() {
    if (!active) return;
    active = false;
    closing = false;
    clearTimeout(fadeTimer);
    overlay.hidden = true;
    overlay.classList.remove('is-leaving');
    app.inert = false;
    app.removeAttribute('aria-hidden');
    document.body.classList.remove('intro-active');
    const target = previousFocus?.isConnected ? previousFocus : document.querySelector('.workspace');
    if (target) { if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1'); target.focus({ preventScroll: true }); }
  }
  function dismiss() {
    if (!active || closing) return;
    closing = true;
    ++serial;
    clearTimeout(timer);
    video.pause();
    if (reducedMotion) { finishDismiss(); return; }
    overlay.classList.add('is-leaving');
    fadeTimer = setTimeout(finishDismiss, 420);
  }
  function maybeDismiss() { if (ready && finished) dismiss(); }
  function start({ replay = false } = {}) {
    clearTimeout(timer);
    clearTimeout(fadeTimer);
    previousFocus = replay ? document.activeElement : null;
    active = true;
    closing = false;
    const requestId = ++serial;
    finished = reducedMotion && !replay;
    overlay.hidden = false;
    overlay.classList.remove('is-leaving');
    video.classList.remove('is-ready');
    app.inert = true;
    app.setAttribute('aria-hidden', 'true');
    document.body.classList.add('intro-active');
    status.textContent = ready ? 'Your workspace is ready' : 'Preparing your workspace…';
    skip.textContent = replay ? 'Back to Studio →' : 'Skip intro →';
    film.pause();
    timer = setTimeout(dismiss, timeoutMs);
    if (finished) { maybeDismiss(); return; }
    skip.focus({ preventScroll: true });
    video.muted = true;
    video.defaultPlaybackRate = 1.25;
    video.playbackRate = 1.25;
    video.src = video.dataset.src;
    video.currentTime = 0;
    video.play().catch(() => { if (active && serial === requestId) { finished = true; maybeDismiss(); } });
  }
  video.addEventListener('playing', () => {
    const requestId = serial;
    const reveal = () => { if (active && !closing && serial === requestId) video.classList.add('is-ready'); };
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(reveal);
    else requestAnimationFrame(reveal);
  });
  video.addEventListener('ended', () => { finished = true; maybeDismiss(); });
  video.addEventListener('error', () => { finished = true; maybeDismiss(); });
  overlay.addEventListener('transitionend', event => {
    if (closing && event.target === overlay && event.propertyName === 'opacity') finishDismiss();
  });
  skip.addEventListener('click', dismiss);
  overlay.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); dismiss(); } });
  document.getElementById('replayIntro').addEventListener('click', () => start({ replay: true }));
  const panel = film.closest('details');
  panel.addEventListener('toggle', () => { if (!panel.open) film.pause(); });
  film.addEventListener('play', () => { if (active) film.pause(); });
  return {
    start,
    ready() {
      ready = true;
      status.textContent = 'Your workspace is ready';
      film.src = video.dataset.src;
      film.preload = 'metadata';
      maybeDismiss();
    }
  };
}
