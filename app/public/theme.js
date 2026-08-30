/* 主题管理：跟随系统 / 浅色 / 深色（三态）
   选择存 localStorage('csTheme')，同源多页面共享（大屏与控制端自动同步）
   用法：window.__setTheme('auto'|'light'|'dark')；window.__getTheme() */
(function () {
  function apply(t) {
    var el = document.documentElement;
    if (t === 'light' || t === 'dark') el.setAttribute('data-theme', t);
    else el.removeAttribute('data-theme'); // 跟随系统 → 交给 CSS prefers-color-scheme
  }
  function get() { try { return localStorage.getItem('csTheme') || 'auto'; } catch (e) { return 'auto'; } }
  function set(t) {
    t = (t === 'light' || t === 'dark') ? t : 'auto';
    try { localStorage.setItem('csTheme', t); } catch (e) {}
    apply(t);
    // 通知同源的其他页面（大屏/控制端）同步换肤
    try { localStorage.setItem('csThemeSync', String(Date.now())); } catch (e) {}
  }
  apply(get());
  // 其他标签页改主题 → 实时同步
  window.addEventListener('storage', function (e) {
    if (e.key === 'csTheme') apply(e.newValue);
  });
  // 跟随系统时：系统外观切换 → 实时响应
  if (window.matchMedia) {
    try {
      matchMedia('(prefers-color-scheme: light)').addEventListener('change', function () {
        if (get() === 'auto') apply('auto');
      });
    } catch (e) {}
  }
  window.__setTheme = set;
  window.__getTheme = get;
})();
