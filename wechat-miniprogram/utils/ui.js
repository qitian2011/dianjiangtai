// UI 级公共行为
// 连接异常（401 云端拒绝 / 部署未配置）时引导到连接页查看详情；已在连接页则不重复跳转（防轮询堆栈）
function needConnect(title) {
  const pages = getCurrentPages();
  const cur = pages[pages.length - 1];
  if (cur && cur.route === 'pages/connect/connect') return;
  wx.showToast({ title: title || '连接失败', icon: 'none' });
  wx.navigateTo({ url: '/pages/connect/connect' });
}

module.exports = { needConnect };
