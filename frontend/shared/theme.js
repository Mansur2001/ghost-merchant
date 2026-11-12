// Shared light/dark theme controller for all three PWAs. Loaded synchronously in <head>
// (before paint) so there's no flash of the wrong theme. Only bg/text flip black↔white;
// gold trim is constant (see styles.css). Preference persists in localStorage across PWAs.
(function () {
  var KEY = 'gm_theme';
  var root = document.documentElement;

  function current() { return root.getAttribute('data-theme') || 'dark'; }
  function updateBtn() {
    var b = document.getElementById('themeToggle');
    if (!b) return;
    var t = current();
    b.textContent = t === 'light' ? '🌙' : '☀️';
    b.setAttribute('aria-label', 'Switch to ' + (t === 'light' ? 'dark' : 'light') + ' mode');
  }
  function apply(t) {
    root.setAttribute('data-theme', t);
    try { localStorage.setItem(KEY, t); } catch (e) { /* private mode */ }
    updateBtn();
  }
  function toggle() { apply(current() === 'light' ? 'dark' : 'light'); }

  // Resolve initial theme immediately (saved > OS preference > dark default).
  var saved;
  try { saved = localStorage.getItem(KEY); } catch (e) { saved = null; }
  var prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  root.setAttribute('data-theme', saved || (prefersLight ? 'light' : 'dark'));

  window.GmTheme = { toggle: toggle, apply: apply };
  document.addEventListener('DOMContentLoaded', function () {
    var b = document.getElementById('themeToggle');
    if (b) b.addEventListener('click', toggle);
    updateBtn();
  });
})();
