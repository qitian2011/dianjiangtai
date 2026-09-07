// 设置页（tab）— 对齐网页控制端「设置」区块（剔除桌面专属项：开机自启/主题/AI语音引擎由大屏端控制）
// 班级管理(新建/改名/删除) / 班级密码(设置·修改·移除) / 抽取动画时长 / 大屏课表显示 / 自动考试 / 播报方式 / 音量 / 连接信息
const theme = require('../../utils/theme.js');
const { getStateWithDir, cmd, getRoom, setRoom } = require('../../utils/djt.js');
const { needConnect } = require('../../utils/ui.js');

Page({
  data: {
    s: null,
    dirClasses: [],
    loading: true,
    errTxt: '',      // 连接失败原因（页面兜底显示，不再静默白屏）
    newName: '',
    renameText: '',
    volValue: 30,
    roomTxt: '',
    themeMode: 'system'   // 外观主题选中态（onShow 刷新为已存值）
  },
  onShow() {
    theme.touch(this);
    this.setData({ themeMode: theme.getMode() });
    this.load();
    this.setData({ roomTxt: this.roomLabel() });
    // 与 Ctrl SSE 实时同步对齐：设置页低频轮询，外部改的 音量/动画/开关 能回流显示
    this._iv = setInterval(() => this.load(), 6000);
  },
  onHide() { if (this._iv) clearInterval(this._iv); this._iv = null; },
  onUnload() { if (this._iv) clearInterval(this._iv); this._iv = null; },
  async load() {
    try {
      const { s, classes } = await getStateWithDir();
      this.setData({ s, dirClasses: classes, loading: false, errTxt: '', volValue: Math.round((s.volume !== undefined ? s.volume : 0.3) * 100), roomTxt: this.roomLabel() });
    } catch (e) {
      if (e.code === 'pin401') { needConnect('云端拒绝访问'); this.setData({ loading: false, errTxt: '云端拒绝访问：proxy 云函数未配置 PIN 环境变量或与云端口令不一致（部署问题），请联系部署者' }); return; }
      const map = { callfn: '云函数调用失败：请确认已开通云开发、config.js 的 CLOUD_ENV 已填、proxy 已「上传并部署」', server503: '云端未配置访问密码（PIN），请联系部署者设置' };
      this.setData({ loading: false, errTxt: map[e.code] || (e.message || '连接云端失败') });
    }
  },
  onRetry() { this.setData({ errTxt: '', loading: true }); this.load(); },
  onSwitch() {
    // 切班 = 重载页面
    this.setData({ newName: '', renameText: '' });
    wx.showNavigationBarLoading();
    this.load().then(() => wx.hideNavigationBarLoading()).catch(() => wx.hideNavigationBarLoading());
  },
  err(e) { wx.showToast({ title: (e && e.message) || '操作失败', icon: 'none' }); },

  // —— 外观主题（浅色 / 深色 / 跟随系统）——
  onTheme(e) {
    const m = (e.currentTarget.dataset && e.currentTarget.dataset.m) || 'system';  // light | dark | system
    theme.setMode(m);                    // 持久化 + 全页 themeClass + tabBar/窗口背景即时切换
    this.setData({ themeMode: theme.getMode() });   // 同步本页 chip 高亮
  },

  // —— 班级管理 ——
  onNewName(e) { this.setData({ newName: e.detail.value }); },
  onCreateClass() {
    const name = (this.data.newName || '').trim();
    if (!name) { wx.showToast({ title: '请输入班级名称', icon: 'none' }); return; }
    wx.showModal({
      title: '新班级「' + name + '」',
      editable: true,
      placeholderText: '可选：班级访问密码（留空=不加密）',
      success: r => {
        if (!r.confirm) return;
        cmd('addClass', { name, pass: String((r.content || '')).trim() }).then(() => {
          this.setData({ newName: '' });
          wx.showToast({ title: '已创建', icon: 'success' });
          this.load();
        }).catch(this.err);
      }
    });
  },
  onRenameText(e) { this.setData({ renameText: e.detail.value }); },
  onRename() {
    const s = this.data.s;
    const name = (this.data.renameText || '').trim();
    if (!name) { wx.showToast({ title: '请输入新名称', icon: 'none' }); return; }
    cmd('renameClass', { name }).then(() => { this.setData({ renameText: '' }); wx.showToast({ title: '已改名', icon: 'success' }); this.load(); }).catch(this.err);
  },
  onDeleteClass() {
    const s = this.data.s;
    if (!s) return;
    const needPass = !!s.locked;
    const ask = () => {
      if (!needPass) return doDel('');
      wx.showModal({
        title: '删除班级',
        content: '「' + s.className + '」已加密，删除需要输入它的班级访问密码',
        editable: true,
        placeholderText: '班级访问密码',
        success: rr => { if (rr.confirm) doDel(String((rr.content || '')).trim()); }
      });
    };
    const doDel = (pass) => {
      wx.showModal({
        title: '确认删除',
        content: '删除「' + s.className + '」？该班名单、课表、统计将一并删除，不可恢复！',
        confirmColor: '#C0392B',
        success: r => {
          if (!r.confirm) return;
          cmd('delClass', { index: s.currentClass, confirm: true, pass }).then(res => {
            if (res && !res.ok) { wx.showToast({ title: res.msg || '删除失败', icon: 'none' }); return; }
            setRoom('1');
            wx.showToast({ title: '已删除', icon: 'success' });
            setTimeout(() => this.load(), 300);
          }).catch(this.err);
        }
      });
    };
    ask();
  },

  // —— 班级密码 ——
  onSetPass() {
    const s = this.data.s;
    if (!s) return;
    if (s.locked) {
      // 已加密：先验旧密码再设新
      wx.showModal({
        title: '修改班级密码',
        editable: true,
        placeholderText: '当前班级访问密码',
        success: r1 => {
          if (!r1.confirm) return;
          const old = String((r1.content || '')).trim();
          wx.showModal({
            title: '新密码',
            editable: true,
            placeholderText: '留空=移除密码',
            success: r2 => {
              if (!r2.confirm) return;
              cmd('setClassPass', { old, pass: String((r2.content || '')).trim() }).then(() => { wx.showToast({ title: '已更新', icon: 'success' }); this.load(); }).catch(this.err);
            }
          });
        }
      });
    } else {
      wx.showModal({
        title: '设置班级密码',
        editable: true,
        placeholderText: '新密码（留空=不设）',
        success: r => {
          if (!r.confirm) return;
          cmd('setClassPass', { old: '', pass: String((r.content || '')).trim() }).then(() => { wx.showToast({ title: '已设置', icon: 'success' }); this.load(); }).catch(this.err);
        }
      });
    }
  },
  onClearPass() {
    wx.showModal({
      title: '移除班级密码',
      editable: true,
      placeholderText: '当前班级访问密码',
      success: r => {
        if (!r.confirm) return;
        cmd('setClassPass', { old: String((r.content || '')).trim(), pass: '' }).then(() => { wx.showToast({ title: '已移除', icon: 'success' }); this.load(); }).catch(this.err);
      }
    });
  },

  // —— 偏好 ——
  onAnim(e) { cmd('setAnim', { ms: Number(e.currentTarget.dataset.ms) }).then(() => this.load()).catch(this.err); },
  onShowTt(e) { cmd('setShowTt', { on: !!e.detail.value }).then(() => this.load()).catch(this.err); },
  onAutoExam(e) { cmd('setAutoExam', { on: !!e.detail.value }).then(() => this.load()).catch(this.err); },
  onVoice(e) { cmd('setVoiceMode', { mode: e.currentTarget.dataset.m }).then(() => this.load()).catch(this.err); },
  onVoling(e) { this.setData({ volValue: e.detail.value }); },   // 拖动过程即时显示百分比（Ctrl volText 同款）
  onVol(e) { cmd('setVolume', { value: Number(e.detail.value) / 100 }).then(() => this.load()).catch(this.err); },

  goConnect() { wx.navigateTo({ url: '/pages/connect/connect' }); },
  volPct(v) { return Math.round((v || 0) * 100) + '%'; },
  roomLabel() { const r = getRoom(); return r === '1' ? '未选定班级（默认）' : r; }
});
