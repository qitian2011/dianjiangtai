// 名单页（tab）— 对齐网页控制端「名单」区块
// 分组管理 / 粘贴导入新班 / 单个添加学生 / 学生列表（学号·权重内联改，删除） / 清零统计
const theme = require('../../utils/theme.js');
const { getStateWithDir, cmd, getRoom, setRoom } = require('../../utils/djt.js');
const { needConnect } = require('../../utils/ui.js');

Page({
  data: {
    s: null,
    dirClasses: [],
    loading: true,
    errTxt: '',      // 连接失败原因（页面兜底显示，不再静默白屏）
    selGroup: '',      // ''=全部
    shown: [],
    newGroup: '',
    importText: '',
    importName: '',
    addName: '', addSid: '', addGroup: '', addWeight: '1'
  },
  onShow() { theme.touch(this); this.load(); this._iv = setInterval(() => this.load(), 4000); },
  onHide() { if (this._iv) clearInterval(this._iv); this._iv = null; },
  onUnload() { if (this._iv) clearInterval(this._iv); this._iv = null; },
  async load() {
    try {
      const { s, classes } = await getStateWithDir();
      this.setData({ s, dirClasses: classes, loading: false, errTxt: '' });
      this.applyGroup();
    } catch (e) {
      if (e.code === 'pin401') { needConnect('云端拒绝访问'); this.setData({ loading: false, errTxt: '云端拒绝访问：proxy 云函数未配置 PIN 环境变量或与云端口令不一致（部署问题），请联系部署者' }); return; }
      const map = { callfn: '云函数调用失败：请确认已开通云开发、config.js 的 CLOUD_ENV 已填、proxy 已「上传并部署」', server503: '云端未配置访问密码（PIN），请联系部署者设置' };
      this.setData({ loading: false, errTxt: map[e.code] || (e.message || '连接云端失败') });
    }
  },
  onRetry() { this.setData({ errTxt: '', loading: true }); this.load(); },
  goConnect() { wx.navigateTo({ url: '/pages/connect/connect' }); },
  onSwitch() {
    // 切班 = 重载页面：清掉分组筛选等上一班残留
    this.setData({ selGroup: '', shown: [] });
    wx.showNavigationBarLoading();
    this.load().then(() => wx.hideNavigationBarLoading()).catch(() => wx.hideNavigationBarLoading());
  },
  applyGroup() {
    const s = this.data.s;
    if (!s) return;
    const g = this.data.selGroup;
    const abs = s.absentToday || [];
    // 行内标记今日请假（Ctrl stuList 同款：📌 红色=今日请假中）；也承载筛选
    const shown = (g ? (s.students || []).filter(x => x.group === g) : (s.students || []))
      .map(x => Object.assign({}, x, { abs: abs.indexOf(x.name) > -1 }));
    this.setData({ shown });
  },
  onGroup(e) { this.setData({ selGroup: e.currentTarget.dataset.g || '' }); this.applyGroup(); },
  onNewGroup(e) { this.setData({ newGroup: e.detail.value }); },
  onAddGroup() {
    const v = (this.data.newGroup || '').trim();
    if (!v) return;
    cmd('addGroup', { name: v }).then(() => {
      this.setData({ newGroup: '' });
      this.load();
    }).catch(err => wx.showToast({ title: err.message, icon: 'none' }));
  },
  onDelGroup(e) {
    const g = e.currentTarget.dataset.g;
    wx.showModal({ title: '删除分组', content: '删除组「' + g + '」？学生保留，仅失去分组。', success: r => {
      if (!r.confirm) return;
      cmd('delGroup', { name: g }).then(() => {
        if (this.data.selGroup === g) this.setData({ selGroup: '' });
        this.load();
      }).catch(err => wx.showToast({ title: err.message, icon: 'none' }));
    } });
  },

  // —— 导入新班 ——
  onImportText(e) { this.setData({ importText: e.detail.value }); },
  onImportName(e) { this.setData({ importName: e.detail.value }); },
  onImport() {
    const text = (this.data.importText || '').trim();
    const name = (this.data.importName || '').trim();
    if (!text) { wx.showToast({ title: '请粘贴名单内容', icon: 'none' }); return; }
    wx.showLoading({ title: '导入中', mask: true });
    cmd('importRoster', { className: name, text }).then(r => {
      wx.hideLoading();
      if (r && !r.ok) throw new Error(r.msg || '导入失败');
      this.setData({ importText: '', importName: '' });
      wx.showModal({ title: '导入成功', content: '班级「' + (name || '未命名班级') + '」已创建。是否切换到该班？', showCancel: true, cancelText: '留在本班', confirmText: '去使用',
        success: res => {
          if (!res.confirm) { this.load(); return; }
          // 切到新班：新班在目录末尾（一律走 rid 独立 DO）
          this.load().then(() => {
            const s2 = this.data.s;
            if (s2 && s2.allClasses && s2.allClasses.length) {
              const last = s2.allClasses[s2.allClasses.length - 1];
              const room = last.rid || '';
              if (room) { setRoom(room); wx.switchTab({ url: '/pages/roll/roll' }); }
            }
          });
        } });
    }).catch(err => { wx.hideLoading(); wx.showToast({ title: err.message || '导入失败', icon: 'none' }); });
  },

  // —— 单个添加 ——
  onAddName(e) { this.setData({ addName: e.detail.value }); },
  onAddSid(e) { this.setData({ addSid: e.detail.value }); },
  onAddGroupIn(e) { this.setData({ addGroup: e.detail.value }); },
  onAddWeight(e) { this.setData({ addWeight: e.detail.value }); },
  onAddStudent() {
    const name = (this.data.addName || '').trim();
    if (!name) { wx.showToast({ title: '姓名必填', icon: 'none' }); return; }
    cmd('addStudent', {
      name,
      sid: (this.data.addSid || '').trim(),
      group: (this.data.addGroup || '').trim(),
      weight: parseFloat(this.data.addWeight) || 1
    }).then(() => {
      this.setData({ addName: '', addSid: '', addGroup: '', addWeight: '1' });
      wx.showToast({ title: '已添加', icon: 'success' });
      this.load();
    }).catch(err => wx.showToast({ title: err.message, icon: 'none' }));
  },

  // —— 学生行编辑 ——
  onSidBlur(e) {
    const name = e.currentTarget.dataset.name;
    const sid = (e.detail.value || '').trim();
    const st = (this.data.s && this.data.s.students || []).find(x => x.name === name);
    if (!st || sid === (st.sid || '')) return;
    cmd('setSid', { name, sid }).catch(err => wx.showToast({ title: err.message, icon: 'none' }));
  },
  onWeightBlur(e) {
    const name = e.currentTarget.dataset.name;
    const raw = (e.detail.value || '').trim();
    const w = raw === '' ? NaN : Number(raw);
    if (!name || isNaN(w)) { if (raw !== '') wx.showToast({ title: '请输入数字（0=不点他，1=正常）', icon: 'none' }); return; }
    if (w < 0) { wx.showToast({ title: '权重不能为负数', icon: 'none' }); return; }
    const st = (this.data.s && this.data.s.students || []).find(x => x.name === name);
    if (st && st.weight === w) return;
    cmd('setWeight', { name, weight: w }).catch(err => wx.showToast({ title: err.message, icon: 'none' }));
  },
  onAbsentTap(e) {
    // 📌 快捷加入/取消今日请假（病假等当天不点他，次日自动恢复）—— Ctrl stuList 📌 同款
    const s = this.data.s;
    if (!s) return;
    const name = e.currentTarget.dataset.name;
    const cur = (s.absentToday || []).slice();
    const i = cur.indexOf(name);
    if (i > -1) cur.splice(i, 1); else cur.push(name);
    cmd('setAbsent', { names: cur }).then(() => this.load()).catch(err => wx.showToast({ title: err.message, icon: 'none' }));
  },
  onDelStudent(e) {
    const name = e.currentTarget.dataset.name;
    wx.showModal({ title: '删除学生', content: '删除「' + name + '」？', success: r => {
      if (!r.confirm) return;
      cmd('delStudent', { name }).then(() => this.load()).catch(err => wx.showToast({ title: err.message, icon: 'none' }));
    } });
  },
  onResetStats() {
    wx.showModal({ title: '清零统计', content: '清零所有学生的被点/答对/答错/未答统计？', success: r => {
      if (!r.confirm) return;
      cmd('resetStats').then(() => this.load()).catch(err => wx.showToast({ title: err.message, icon: 'none' }));
    } });
  }
});
