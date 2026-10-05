/* Convoy landing page: reveal-on-scroll. External file because the server's
   CSP (script-src 'self') forbids inline scripts. Motion is transform/opacity
   only and is skipped entirely under prefers-reduced-motion (the CSS never
   hides .rv there, so nothing depends on this running). */
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var els = Array.prototype.slice.call(document.querySelectorAll('.rv'));
  if (!els.length) return;
  if (reduce || !('IntersectionObserver' in window)) {
    els.forEach(function (el) { el.classList.add('in'); });
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.classList.add('in');
      io.unobserve(e.target);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
  els.forEach(function (el) { io.observe(el); });
})();
