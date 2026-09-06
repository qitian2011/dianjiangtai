// 传呼页（tab）— 对齐网页控制端「传呼」区块
// 选人（可多选，姓名/学号搜索）→ 去处 → 留言 → 发送；当前传呼可 已到/撤回
const theme = require('../../utils/theme.js');
const { getStateWithDir, cmd } = require('../../utils/djt.js');
const { needConnect } = require('../../utils/ui.js');

const fmt = at => { const d = new Date(at); const p = n => (n < 10 ? '0' : '') + n; return p(d.getHours()) + ':' + p(d.getMinutes()); };
// 姓名·学号 成对展示（有学号显示 学号，区分同名；无学号只显姓名）—— 对齐 Ctrl 端
const fmtNames = (p) => {
  const ns = (p && p.names) || [];
  const ss = (p && p.sids) || [];
  return ns.map((n, i) => (ss[i] ? n + '·' + ss[i] : n)).join('、');
};

Page({
  data: {
    s: null,
    dirClasses: [],
    loading: true,
    errTxt: '',      // 连接失败原因（页面兜底显示，不再静默白屏）
    pageLogV: [],        // 记录预处理 namesTxt
    pageNamesTxt: '',    // 当前传呼学生名串（姓名·学号）
    pageSentTxt: '',     // 当前传呼发出时间
    kw: '',
    shown: [],          // 搜索后的候选学生 [{name,sid,group}]
    selected: [],       // 已选 [{name,sid}]
    selPlace: '',       // 选中的去处
    newPlace: '',
    from: '',
    note: ''
  },
  onShow() { theme.touch(this); this.load(); this._iv = setInterval(() => this.load(), 3000); },
  onHide() { if (this._iv) clearInterval(this._iv); this._iv = null; },
  onUnload() { if (this._iv) clearInterval(this._iv); this._iv = null; },
  async load() {
    try {
      const { s, classes } = await getStateWithDir();
      // 记录倒序展示（Ctrl 端 slice().reverse()：最新在前）；显示 姓名·学号
      const pageLogV = (s.pageLog || []).slice().reverse().map(p => Object.assign({}, p, { namesTxt: fmtNames(p), timeTxt: fmt(p.sentAt) }));
      this.setData({
        s, dirClasses: classes, loading: false, errTxt: '', pageLogV,
        pageNamesTxt: (s.page && !s.page.retracted) ? fmtNames(s.page) : '',
        pageSentTxt: (s.page && s.page.sentAt) ? fmt(s.page.sentAt) : ''
      });
      if (!s.locked) this.applyFilter();
    } catch (e) {
      if (e.code === 'pin401') { needConnect('云端拒绝访问'); this.setData({ loading: false, errTxt: '云端拒绝访问：proxy 云函数未配置 PIN 环境变量或与云端口令不一致（部署问题），请联系部署者' }); return; }
      const map = { callfn: '云函数调用失败：请确认已开通云开发、config.js 的 CLOUD_ENV 已填、proxy 已「上传并部署」', server503: '云端未配置访问密码（PIN），请联系部署者设置' };
      this.setData({ loading: false, errTxt: map[e.code] || (e.message || '连接云端失败') });
    }
  },
  onRetry() { this.setData({ errTxt: '', loading: true }); this.load(); },
  goConnect() { wx.navigateTo({ url: '/pages/connect/connect' }); },
  onSwitch() {
    // 切班 = 重载页面：清掉上一班的选择/搜索/传呼草稿
    this.setData({ selected: [], kw: '', shown: [], selPlace: '', newPlace: '', from: '', note: '', pageLogV: [], pageNamesTxt: '' });
    wx.showNavigationBarLoading();
    this.load().then(() => wx.hideNavigationBarLoading()).catch(() => wx.hideNavigationBarLoading());
  },
  applyFilter() {
    const s = this.data.s;
    if (!s) return;
    const kw = (this.data.kw || '').trim().toLowerCase();
    const sel = this.data.selected;
    let shown = s.students || [];
    if (kw) shown = shown.filter(x => (x.name || '').toLowerCase().includes(kw) || String(x.sid || '').includes(kw));
    // WXML 不能调用 selHas(index)：把「是否已选」预处理成 item.sel
    shown = shown.map(x => Object.assign({}, x, { sel: !!sel.find(y => y.name === x.name) }));
    this.setData({ shown });
  },
  onKw(e) { this.setData({ kw: e.detail.value }); this.applyFilter(); },

  onPick(e) {
    const i = Number(e.currentTarget.dataset.i);
    const x = this.data.shown[i];
    if (!x) return;
    const sel = this.data.selected;
    if (sel.some(y => y.name === x.name)) return;
    sel.push({ name: x.name, sid: x.sid || '' });
    this.setData({ selected: sel });
    this.applyFilter();   // 刷新 sel 标记
  },
  onUnpick(e) {
    const i = Number(e.currentTarget.dataset.i);
    const sel = this.data.selected.slice();
    sel.splice(i, 1);
    this.setData({ selected: sel });
    this.applyFilter();   // 刷新 sel 标记
  },
  onClearSel() { this.setData({ selected: [] }); },
  selHas(i) {
    const x = this.data.shown[i];
    return !!x && this.data.selected.some(y => y.name === x.name);
  },

  onPlace(e) { this.setData({ selPlace: e.currentTarget.dataset.p || '' }); },
  onNewPlace(e) { this.setData({ newPlace: e.detail.value }); },
  onAddPlace() {
    const v = (this.data.newPlace || '').trim();
    if (!v) return;
    cmd('addPlace', { name: v }).then(() => {
      this.setData({ newPlace: '', selPlace: v });
      this.load();
    }).catch(err => wx.showToast({ title: err.message, icon: 'none' }));
  },
  onFrom(e) { this.setData({ from: e.detail.value }); },
  onNote(e) { this.setData({ note: e.detail.value }); },

  onSend() {
    const s = this.data.s;
    if (!s || s.locked) return;
    const sel = this.data.selected;
    if (!sel.length) { wx.showToast({ title: '请先选择学生', icon: 'none' }); return; }
    if (!this.data.selPlace) { wx.showToast({ title: '请选择或添加去处', icon: 'none' }); return; }
    cmd('page', {
      names: sel.map(x => x.name),
      sids: sel.map(x => x.sid),
      place: this.data.selPlace,
      from: (this.data.from || '').trim(),
      note: (this.data.note || '').trim()
    }).then(r => {
      if (r && !r.ok) throw new Error(r.msg || '发送失败');
      this.setData({ selected: [], from: '', note: '' });
      wx.showToast({ title: '传呼已发送', icon: 'success' });
      this.load();
    }).catch(err => wx.showToast({ title: err.message || '发送失败', icon: 'none' }));
  },

  onConfirm() { cmd('pageConfirm').then(() => this.load()).catch(err => wx.showToast({ title: err.message, icon: 'none' })); },
  onRetract() {
    wx.showModal({ title: '撤回传呼', content: '撤回后大屏将移除该传呼。', success: r => {
      if (!r.confirm) return;
      cmd('pageRetract').then(() => this.load()).catch(err => wx.showToast({ title: err.message, icon: 'none' }));
    } });
  },

  fmtTime(at) { return fmt(at); },
  isActive(p) { return p && !p.retracted; },
  confirmed(p) { return !!(p && p.confirmed); }
});
