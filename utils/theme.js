// 主题工具：浅色 / 深色 / 跟随系统
// 用法：
//   const theme = require('../../utils/theme.js')
//   theme.init();                 // app.js onLaunch 调一次：注册系统主题监听
//   各页 onShow 首行: theme.touch(this)   // 同步页面根容器 class + tabBar 配色
//   设置页切换: theme.setMode('dark'|'light'|'system')
// 色板定义在 app.wxss：page{} 为浅色默认，.theme-dark 覆盖为深色（CSS 变量穿透组件边界）。

const MODE_KEY = 'djt_theme_mode';          // 'light' | 'dark' | 'system'

// tabBar 双态配色（图标 PNG 灰/蓝与之一致协调）
const TAB = {
  light: { color: '#8A93A8', selectedColor: '#2E8BE0', backgroundColor: '#FFFFFF', borderStyle: 'white' },
  dark:  { color: '#8A93A8', selectedColor: '#6BB6F5', backgroundColor: '#1E222D', borderStyle: 'black' }
};
const BG = { light: '#F2F4FA', dark: '#12151D' };

let cur = 'light';      // 解析后的实际主题（light|dark）

function getMode() {
  try {
    const m = wx.getStorageSync(MODE_KEY);
    return (m === 'light' || m === 'dark') ? m : 'system';
  } catch (e) { return 'system'; }
}

function systemTheme() {
  try {
    // 兼容：新基础库推荐 wx.getAppBaseInfo，但 theme 字段在 getSystemInfo 亦可用
    const info = wx.getSystemInfoSync();
    return (info && info.theme === 'dark') ? 'dark' : 'light';
  } catch (e) { return 'light'; }
}

function applyChrome() {
  const c = cur;
  const t = TAB[c] || TAB.light;
  try {
    wx.setTabBarStyle({
      color: t.color, selectedColor: t.selectedColor,
      backgroundColor: t.backgroundColor, borderStyle: t.borderStyle
    });
  } catch (e) { /* 非 tabBar 页或时机未到，忽略 */ }
  try {
    wx.setBackgroundColor({ backgroundColor: BG[c], backgroundColorTop: BG[c], backgroundColorBottom: BG[c] });
  } catch (e) { /* 忽略 */ }
}

function refresh() {
  const mode = getMode();
  cur = mode === 'system' ? systemTheme() : mode;
  applyChrome();
}

function themeClassOf() { return cur === 'dark' ? 'theme-dark' : ''; }

// 页面 onShow 调用：刷新解析 + 写 themeClass 到页面 data + 同步 chrome
function touch(page) {
  refresh();
  if (page && page.setData) page.setData({ themeClass: themeClassOf() });
}

// app onLaunch 调用
function init() {
  refresh();
  if (wx.onThemeChange) {
    wx.onThemeChange((res) => {
      if (getMode() !== 'system') return;      // 手动模式忽略系统变化
      cur = (res && res.theme === 'dark') ? 'dark' : 'light';
      applyChrome();
      // 已打开的页面实时换肤
      const pages = getCurrentPages();
      pages.forEach(p => { if (p && p.setData) p.setData({ themeClass: themeClassOf() }); });
    });
  }
}

// 设置页切换：存储 + 立即生效
function setMode(mode) {
  const m = (mode === 'light' || mode === 'dark') ? mode : 'system';
  try { wx.setStorageSync(MODE_KEY, m); } catch (e) {}
  refresh();
  // 通知已打开页面
  const pages = getCurrentPages();
  pages.forEach(p => { if (p && p.setData) p.setData({ themeClass: themeClassOf() }); });
}

module.exports = { init, touch, setMode, getMode, resolve: () => cur, themeClassOf };
