// 课表页（tab）— 对齐网页控制端「课表」区块
// 公告栏 / 备忘录（大屏作业栏）/ 节次与每节时间 / 今日答题统计 / 一周课表网格
const theme = require('../../utils/theme.js');
const { getStateWithDir, cmd } = require('../../utils/djt.js');
const { needConnect } = require('../../utils/ui.js');

const fmt = at => { const d = new Date(at); const p = n => (n < 10 ? '0' : '') + n; return p(d.getHours()) + ':' + p(d.getMinutes()); };
function todayLocal() {
  const d = new Date();
  const p = n => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
const DAYS = [1, 2, 3, 4, 5];
const DAY_LABEL = ['', '一', '二', '三', '四', '五'];
// 构建节次序列（含早读/晚托）—— 标签对齐 Ctrl：上午N节 / 下午N节 / 早读 / 晚托
function slotsOf(tt) {
  const out = [];
  const am = tt.am || 0, pm = tt.pm || 0;
  if (tt.pre) out.push({ key: 'pre', label: '早读', no: 0 });
  for (let i = 0; i < am; i++) out.push({ key: String(i), label: '上午' + (i + 1) + '节', no: i + 1 });
  for (let i = 0; i < pm; i++) out.push({ key: String(am + i), label: '下午' + (i + 1) + '节', no: am + i + 1 });
  if (tt.post) out.push({ key: 'post', label: '晚托', no: 0 });
  return out;
}

Page({
  data: {
    s: null,
    dirClasses: [],
    loading: true,
    errTxt: '',      // 连接失败原因（页面兜底显示，不再静默白屏）
    noticeText: '',
    memoText: '',
    dayNames: ['周一', '周二', '周三', '周四', '周五'],
    slots: [],        // 节次序列
    grid: [],         // [{key,label,row:[{day,val}]}]
    times: [],        // [{key,label,s,e}]
    todayStats: [],   // [{slot,answered,missed,total}]
    memosV: [],       // 备忘录预处理（带时间）
    today: ''
  },
  onShow() { theme.touch(this); this.load(); this._iv = setInterval(() => this.load(), 5000); },
  onHide() { if (this._iv) clearInterval(this._iv); this._iv = null; },
  onUnload() { if (this._iv) clearInterval(this._iv); this._iv = null; },
  async load() {
    try {
      const { s, classes } = await getStateWithDir();
      if (!s.locked && !this.data.noticeText) this.setData({ noticeText: (s.notice && s.notice.text) || '' });
      this.setData({ s, dirClasses: classes, loading: false, errTxt: '', today: todayLocal() });
      if (!s.locked && !this._editing) this.buildAll(s);
    } catch (e) {
      if (e.code === 'pin401') { needConnect('云端拒绝访问'); this.setData({ loading: false, errTxt: '云端拒绝访问：proxy 云函数未配置 PIN 环境变量或与云端口令不一致（部署问题），请联系部署者' }); return; }
      const map = { callfn: '云函数调用失败：请确认已开通云开发、config.js 的 CLOUD_ENV 已填、proxy 已「上传并部署」', server503: '云端未配置访问密码（PIN），请联系部署者设置' };
      this.setData({ loading: false, errTxt: map[e.code] || (e.message || '连接云端失败') });
    }
  },
  onRetry() { this.setData({ errTxt: '', loading: true }); this.load(); },
  goConnect() { wx.navigateTo({ url: '/pages/connect/connect' }); },
  onSwitch() {
    // 切班 = 重载页面：公告/备忘草稿与编辑态属于上一班，须清空
    this.setData({ noticeText: '', memoText: '' });
    this._editing = false;
    wx.showNavigationBarLoading();
    this.load().then(() => wx.hideNavigationBarLoading()).catch(() => wx.hideNavigationBarLoading());
  },
  onEditFocus() { this._editing = true; },
  buildAll(s) {
    const tt = s.tt || { am: 4, pm: 3 };
    const slots = slotsOf(tt);
    const grid = slots.map(sl => ({
      key: sl.key,
      label: sl.label,
      row: DAYS.map(day => ({ day, val: (tt.cells || {})[day + '_' + sl.key] || '' }))
    }));
    const times = slots.map(sl => {
      const t = (tt.times || {})[sl.key] || {};
      return { key: sl.key, label: sl.label, s: t.s || '', e: t.e || '' };
    });
    // 今日统计
    const stats = tt.stats || {};
    const tday = todayLocal();
    const labOf = key => { const f = slots.find(x => x.key === key); return f ? f.label : key; };
    const todayStats = Object.keys(stats)
      .filter(k => stats[k].date === tday)
      .map(k => ({ slot: stats[k].slot, label: labOf(stats[k].slot), answered: stats[k].answered, missed: stats[k].missed, total: stats[k].total }))
      .sort((a, b) => String(a.slot).localeCompare(String(b.slot), 'en', { numeric: true }));
    // 备忘录列表（带时间，Ctrl 同步显示）
    const memosV = (s.memos || []).map(m => Object.assign({}, m, { timeTxt: fmt(m.at) }));
    this.setData({ slots, grid, times, todayStats, memosV });
  },
  slotLabel(key) {
    const f = this.data.slots.find(x => x.key === key);
    return f ? f.label : key;
  },

  // —— 公告 ——
  onNotice(e) { this.setData({ noticeText: e.detail.value }); },
  onNoticeSave() { cmd('setNotice', { text: (this.data.noticeText || '').trim() }).then(() => this.load()).catch(err => wx.showToast({ title: err.message, icon: 'none' })); },
  onNoticeClear() {
    wx.showModal({ title: '清除公告', content: '确定清除当前公告？', success: r => {
      if (!r.confirm) return;
      cmd('setNotice', { text: '' }).then(() => { this.setData({ noticeText: '' }); this.load(); }).catch(err => wx.showToast({ title: err.message, icon: 'none' }));
    } });
  },

  // —— 备忘录 ——
  onMemo(e) { this.setData({ memoText: e.detail.value }); },
  onMemoAdd() {
    const v = (this.data.memoText || '').trim();
    if (!v) return;
    cmd('memoAdd', { text: v }).then(() => { this.setData({ memoText: '' }); this.load(); }).catch(err => wx.showToast({ title: err.message, icon: 'none' }));
  },
  onMemoToggle(e) {
    cmd('memoToggle', { id: e.currentTarget.dataset.id }).then(() => this.load()).catch(err => wx.showToast({ title: err.message, icon: 'none' }));
  },
  onMemoDel(e) {
    cmd('memoDel', { id: e.currentTarget.dataset.id }).then(() => this.load()).catch(err => wx.showToast({ title: err.message, icon: 'none' }));
  },
  onMemoClearDone() { cmd('memoClearDone').then(() => this.load()).catch(err => wx.showToast({ title: err.message, icon: 'none' })); },
  onShowMemos(e) { cmd('setShowMemos', { on: !!e.detail.value }).then(() => this.load()).catch(err => wx.showToast({ title: err.message, icon: 'none' })); },

  // —— 节次 ——
  async changeAm(delta) {
    const tt = this.data.s.tt;
    const am = Math.min(8, Math.max(1, (tt.am || 4) + delta));
    if (am === tt.am) return;
    try { await cmd('ttConfig', { am, pm: tt.pm || 3 }); this.load(); } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
  },
  async changePm(delta) {
    const tt = this.data.s.tt;
    const pm = Math.min(8, Math.max(1, (tt.pm || 3) + delta));
    if (pm === tt.pm) return;
    try { await cmd('ttConfig', { am: tt.am || 4, pm }); this.load(); } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
  },
  onAmMinus() { this.changeAm(-1); },
  onAmPlus() { this.changeAm(1); },
  onPmMinus() { this.changePm(-1); },
  onPmPlus() { this.changePm(1); },
  onPre(e) { cmd('ttExtra', { pre: e.detail.value ? 1 : 0 }).then(() => this.load()).catch(err => wx.showToast({ title: err.message, icon: 'none' })); },
  onPost(e) { cmd('ttExtra', { post: e.detail.value ? 1 : 0 }).then(() => this.load()).catch(err => wx.showToast({ title: err.message, icon: 'none' })); },
  onTtClear() {
    wx.showModal({ title: '清空课表', content: '清空本班整周课程？', success: r => {
      if (!r.confirm) return;
      cmd('ttClear').then(() => this.load()).catch(err => wx.showToast({ title: err.message, icon: 'none' }));
    } });
  },
  // 每节时间编辑：input 即时写回 data（受控组件），失焦才保存
  onTimeS(e) { this.syncTime(e, 's'); },
  onTimeE(e) { this.syncTime(e, 'e'); },
  onTimeSBlur(e) { this.saveTime(e); },
  onTimeEBlur(e) { this.saveTime(e); },
  syncTime(e, which) {
    const key = e.currentTarget.dataset.key;
    const idx = this.data.times.findIndex(x => x.key === key);
    if (idx < 0) return;
    this.setData({ ['times[' + idx + '].' + which]: e.detail.value });
  },
  saveTime(e) {
    this._editing = false;
    const key = e.currentTarget.dataset.key;
    const item = this.data.times.find(x => x.key === key);
    if (!item) return;
    const start = (item.s || '').trim();
    const end = (item.e || '').trim();
    cmd('ttTime', { slot: key, start, end }).catch(err => wx.showToast({ title: err.message, icon: 'none' }));
  },
  // 课表格编辑：input 即时写回，失焦保存（空格=清除）
  onCellInput(e) {
    const ri = Number(e.currentTarget.dataset.ri);
    const di = Number(e.currentTarget.dataset.di);
    this.setData({ ['grid[' + ri + '].row[' + di + '].val']: e.detail.value });
  },
  onCellBlur(e) {
    this._editing = false;
    const day = Number(e.currentTarget.dataset.day);
    const key = e.currentTarget.dataset.key;
    cmd('ttCell', { day, slot: key, course: (e.detail.value || '').trim() }).then(() => this.load()).catch(err => wx.showToast({ title: err.message, icon: 'none' }));
  },
  onStatsClear() {
    wx.showModal({ title: '清空今日统计', content: '确定清空本班答题统计？', success: r => {
      if (!r.confirm) return;
      cmd('ttStatsClear').then(() => this.load()).catch(err => wx.showToast({ title: err.message, icon: 'none' }));
    } });
  },
  fmtTime(at) { return fmt(at); },
  slotLabelIn(key) { return this.slotLabel(key); },
  dayLabel(d) { return DAY_LABEL[d]; }
});
