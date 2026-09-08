// 点名答题页（tab）— 对齐网页控制端「点名答题」区块
// 轮询快照（小程序无 SSE）；点名后高频轮询取 lastPick；结果可 请回答(计时)/跳过/答对答错未答
const theme = require('../../utils/theme.js');
const { getState, getStateWithDir, cmd } = require('../../utils/djt.js');
const { needConnect } = require('../../utils/ui.js');

const sleep = ms => new Promise(rs => setTimeout(rs, ms));
const fmt = at => { const d = new Date(at); const p = n => (n < 10 ? '0' : '') + n; return p(d.getHours()) + ':' + p(d.getMinutes()); };
const TAG = { right: ['✓ 答对', 'tag-right'], wrong: ['✗ 答错', 'tag-wrong'], none: ['未答', 'tag-none'], skip: ['跳过', 'tag-skip'] };

Page({
  data: {
    s: null,
    dirClasses: [],
    loading: true,
    errTxt: '',      // 连接失败原因（页面兜底显示，不再静默白屏）
    groupSel: '',
    countSel: 1,
    noRepeat: true,
    counts: [1, 2, 3, 4],
    rolling: false,
    editingAbsent: false,
    editingStudents: [],   // [{name,abs}] 请假编辑用
    absentDraft: [],
    absentTxt: '',
    absentCount: 0,
    lessonLogV: [],        // lessonLog 预处理（namesTxt）
    leftTxt: ''
  },
  onShow() { theme.touch(this); this.load(); this._iv = setInterval(() => this.load(), 4000); this._tk = setInterval(() => this.tick(), 500); },
  onHide() { this.stopTimers(); },
  onUnload() { this.stopTimers(); },
  stopTimers() { if (this._iv) clearInterval(this._iv); if (this._tk) clearInterval(this._tk); this._iv = this._tk = null; },

  async load() {
    try {
      const { s, classes } = await getStateWithDir();
      const editingStudents = (s.students || []).map(x => ({ name: x.name, abs: (s.absentToday || []).indexOf(x.name) > -1 }));
      const lessonLogV = (s.lessonLog || []).map(l => {
        const t = TAG[l.result] || ['', ''];
        return Object.assign({}, l, {
          namesTxt: (l.names || []).join('、'),
          resultTxt: t[0],
          resultTag: t[1],
          timeTxt: fmt(l.at)
        });
      });
      this.setData({
        s, dirClasses: classes, loading: false, errTxt: '',
        editingStudents, absentDraft: (s.absentToday || []).slice(),
        absentTxt: (s.absentToday || []).join('、'),
        absentCount: (s.absentToday || []).length, lessonLogV
      });
      if (this._polling) this.checkPollResult(s);
    } catch (e) {
      if (e.code === 'pin401') { needConnect('云端拒绝访问'); this.setData({ loading: false, errTxt: '云端拒绝访问：proxy 云函数未配置 PIN 环境变量或与云端口令不一致（部署问题），请联系部署者' }); return; }
      const map = { callfn: '云函数调用失败：请确认已开通云开发、config.js 的 CLOUD_ENV 已填、proxy 已「上传并部署」', server503: '云端未配置访问密码（PIN），请联系部署者设置' };
      this.setData({ loading: false, errTxt: map[e.code] || (e.message || '连接云端失败') });
    }
  },
  onRetry() { this.setData({ errTxt: '', loading: true }); this.load(); },
  goConnect() { wx.navigateTo({ url: '/pages/connect/connect' }); },
  onSwitch() {
    // 切班 = 重载页面（Ctrl 切班即整页跳转）：清掉可能残留的上一班中间态
    this.setData({ rolling: false, editingAbsent: false, leftTxt: '' });
    wx.showNavigationBarLoading();
    this.load().then(() => wx.hideNavigationBarLoading()).catch(() => wx.hideNavigationBarLoading());
  },

  // —— 抽取范围 ——
  onGroup(e) { this.setData({ groupSel: e.currentTarget.dataset.g || '' }); },
  onCount(e) { this.setData({ countSel: Number(e.currentTarget.dataset.n) }); },
  onNoRepeat(e) { this.setData({ noRepeat: !!e.detail.value }); },
  onExam(e) {
    const on = !!e.detail.value;
    cmd('examMode', { on }).then(() => this.setData({ 's.examMode': on })).catch(err => wx.showToast({ title: err.message, icon: 'none' }));
  },
  onResetRound() {
    wx.showModal({ title: '重置本轮', content: '清空本轮已点记录，已点过的学生可再次被点。', success: r => {
      if (!r.confirm) return;
      cmd('resetRound').then(() => this.load()).catch(err => wx.showToast({ title: err.message, icon: 'none' }));
    } });
  },

  // —— 点名 ——
  async onRoll() {
    const s = this.data.s;
    if (!s || s.locked) return;
    if (this.data.rolling) { wx.showToast({ title: '点名动画进行中', icon: 'none' }); return; }
    if (s.answering) { wx.showToast({ title: '答题进行中，先标记结果', icon: 'none' }); return; }
    this.setData({ rolling: true });
    try {
      const r = await cmd('roll', { group: this.data.groupSel || null, count: this.data.countSel, noRepeat: this.data.noRepeat });
      if (!r || !r.ok) throw new Error((r && r.msg) || '点名失败');
      await this.waitResult(0);
    } catch (e) {
      this.setData({ rolling: false });
      wx.showToast({ title: e.message || '点名失败', icon: 'none' });
    }
  },
  async waitResult(baseAt) {
    this._polling = true;
    for (let i = 0; i < 50; i++) {
      await sleep(400);
      try {
        const s = await getState();
        if (s.lastPick && s.lastPick.at > baseAt) { this.setData({ s, rolling: false }); this._polling = false; return; }
      } catch (e) { /* 继续等 */ }
    }
    this.setData({ rolling: false });
    this._polling = false;
  },
  checkPollResult(s) {
    // skip 后自动补抽也走这里：lastPick 更新即结束动画态
    if (s.lastPick && this._pollBase && s.lastPick.at > this._pollBase) { this._polling = false; this.setData({ rolling: false }); }
  },

  // —— 结果操作 ——
  onAsk() {
    const s = this.data.s;
    if (!s || !s.lastPick) { wx.showToast({ title: '请先点名', icon: 'none' }); return; }
    wx.showActionSheet({
      itemList: ['30秒', '1分钟', '2分钟', '不限时'],
      success: res => {
        const duration = [30, 60, 120, 0][res.tapIndex];
        cmd('answerStart', { duration }).then(() => this.load()).catch(err => wx.showToast({ title: err.message, icon: 'none' }));
      }
    });
  },
  onSkip() {
    const s = this.data.s;
    if (!s || !s.lastPick) return;
    this.setData({ rolling: true });
    this._pollBase = 0;
    cmd('skip', {}).then(async () => {
      await this.waitResult(0);
      this.load();
    }).catch(e => { this.setData({ rolling: false }); wx.showToast({ title: e.message, icon: 'none' }); });
  },
  onMark(e) {
    cmd('mark', { result: e.currentTarget.dataset.m }).then(() => this.load()).catch(err => wx.showToast({ title: err.message, icon: 'none' }));
  },
  tick() {
    const s = this.data.s;
    if (!s || !s.answering) { if (this.data.leftTxt !== '') this.setData({ leftTxt: '' }); return; }
    if (s.answering.duration === 0) { if (this.data.leftTxt !== '不限时') this.setData({ leftTxt: '不限时' }); return; }
    const left = Math.max(0, Math.ceil((s.answering.deadline - Date.now()) / 1000));
    this.setData({ leftTxt: left > 0 ? left + ' 秒' : '时间到' });
  },

  // —— 今日请假 ——
  onAbsentEdit() {
    const s = this.data.s;
    if (!s) return;
    this.setData({ editingAbsent: true });
  },
  onAbsentChk(e) { this.setData({ absentDraft: e.detail.value }); },
  onAbsentCancel() { this.setData({ editingAbsent: false }); },
  onAbsentSave() {
    cmd('setAbsent', { names: this.data.absentDraft }).then(() => {
      this.setData({ editingAbsent: false });
      this.load();
    }).catch(err => wx.showToast({ title: err.message, icon: 'none' }));
  },
  onAbsentClear() {
    wx.showModal({ title: '清空今日请假', content: '确定清空吗？', success: r => {
      if (!r.confirm) return;
      cmd('clearAbsent').then(() => this.load()).catch(err => wx.showToast({ title: err.message, icon: 'none' }));
    } });
  },

  // —— 展示辅助（WXML 直接调用） ——
  fmtTime(at) { return fmt(at); },
  tagInfo(result) { return TAG[result] || ['', '']; }
});
