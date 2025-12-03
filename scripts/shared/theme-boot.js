(function bootstrapTheme() {
  var html = document.documentElement;
  var saved = null;
  try { saved = localStorage.getItem('xsync-theme'); } catch (_) {}
  html.setAttribute('data-theme', saved || 'light');
})();
