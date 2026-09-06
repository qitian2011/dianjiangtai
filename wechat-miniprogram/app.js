const cfg = require('./config');
const theme = require('./utils/theme.js');

App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('基础库过低，请使用 2.2.3 及以上版本以使用云能力');
      return;
    }
    if (cfg.CLOUD_ENV) {
      wx.cloud.init({ env: cfg.CLOUD_ENV, traceUser: true });
    } else {
      wx.cloud.init({ traceUser: true });
    }
    theme.init();   // 读取主题模式 + 注册系统主题监听（浅色/深色/跟随系统）
  }
});
