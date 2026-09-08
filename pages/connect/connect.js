// 连接与班级管理页：打开即自动连接云端（无全局密码门槛，PIN 由 proxy 云函数注入），
// 仅保留：班级列表切换、带锁班级的「班级访问密码」解锁（班级密码 ≠ 云端密码，班级密码仍保留）。
// 2026-09-06：班级一律按 rid 独立 DO 访问（去掉「目录首班=主实例 room'1'」旧映射），
// 与网页端/大屏同实例，点名/传呼/解锁才互通。
const theme = require('../../utils/theme.js');
const { getRoom, setRoom, getStateOf, cmdOf, resolveRoom } = require('../../utils/djt.js');

const UNLOCK_PREFIX = 'djUnlock:';
function unlockKey(rid) { return UNLOCK_PREFIX + rid; }

Page({
  data: {
    stage: 'boot',        // boot|lock|ready
    classes: [],
    curIdx: -1,
    curName: '',
    msg: '',              // 连接失败原因（boot 卡内展示，替代原密码输入卡）
    busy: false,
    pass: '',
    unlockName: ''
  },
  onLoad() {
    // 兼容旧版本：清理已废弃的本地云端密码残留（PIN 已上移到 proxy 云函数）
    wx.removeStorageSync('djt_mp_pin');
  },
  onShow() {
    theme.touch(this);
    this.bootstrap();
  },
  onPassInput(e) { this.setData({ pass: e.detail.value }); },
  async bootstrap() {
    if (this._busy) return;
    this._busy = true;
    this.setData({ busy: true, stage: 'boot', msg: '', pass: '' });
    try {
      // 默认房 '1' → 自动落到目录首班的 rid 独立 DO（防在主实例副本上工作而收不到响应）
      const room = await resolveRoom();
      const [s, dir] = await Promise.all([
        getStateOf(room),
        room !== '1' ? getStateOf('1').catch(() => null) : Promise.resolve(null)
      ]);
      const classes = (dir && dir.allClasses && dir.allClasses.length) ? dir.allClasses : (s.allClasses || []);
      // 注意：allClasses 中 c.i 恒等于数组下标（主实例 map 生成），故 findIndex 即高亮下标
      let curIdx = room === '1' ? 0 : classes.findIndex(c => c.rid === room);
      if (curIdx < 0) curIdx = classes.length ? 0 : -1;
      if (s.locked) {
        this.setData({
          stage: 'lock', classes, curIdx, curName: s.className || '',
          unlockName: s.className || '', msg: ''
        });
      } else {
        const name = s.className || (classes[curIdx] && classes[curIdx].name) || '';
        this.setData({ stage: 'ready', classes, curIdx, curName: name, msg: '' });
      }
    } catch (e) {
      const code = e.code || '';
      if (code === 'pin401' || code === 'http401') {
        this.setData({ msg: '云端拒绝访问：请确认 proxy 云函数已「上传并部署」，并在云开发控制台为 proxy 配置 PIN 环境变量（需与云端口令一致）' });
      } else if (code === 'server503') {
        this.setData({ msg: '云端访问密码（PIN）未配置：请联系部署者在 proxy 云函数 / 云端设置 PIN 后再连' });
      } else if (code === 'callfn') {
        this.setData({ msg: '云函数调用失败：请确认已开通云开发并部署 proxy 云函数（右键 cloudfunctions/proxy → 上传并部署）' });
      } else {
        this.setData({ msg: '连接失败：' + (e.message || e) });
      }
    }
    this._busy = false;
    this.setData({ busy: false });
  },
  onRetry() {
    this.setData({ msg: '' });
    this.bootstrap();
  },
  async onClassTap(e) {
    const i = Number(e.currentTarget.dataset.i);
    const c = this.data.classes.find(x => x.i === i);
    if (!c || i === this.data.curIdx) return;
    // 班级一律走 rid 独立 DO（含目录首班）：与网页端「切班=换 ?room=rid」同构
    const room = c.rid || '1';
    if (!room) { wx.showToast({ title: '无法进入该班', icon: 'none' }); return; }
    if (c.locked) {
      // 会话已解锁过 → 自动带密码切过去（Ctrl sessionStorage djUnlock 同语义）
      const cached = wx.getStorageSync(unlockKey(room));
      if (cached) {
        wx.showLoading({ title: '解锁中', mask: true });
        try {
          const r = await cmdOf('unlockClass', { pass: cached }, room);
          if (r && r.ok) {
            setRoom(room);
            this.setData({ pass: '' });
            await this.bootstrap();
            wx.hideLoading();
            return;
          }
          wx.removeStorageSync(unlockKey(room));   // 密码已失效 → 走弹窗
        } catch (e) { wx.removeStorageSync(unlockKey(room)); }
        wx.hideLoading();
      }
      // 无缓存/缓存失效 → 停在当前页等待输入班级密码后解锁进入
      this.setData({ stage: 'lock', curIdx: i, unlockName: c.name, msg: '', pass: '', _pendingRoom: room });
      return;
    }
    setRoom(room);
    this.setData({ pass: '' });
    await this.bootstrap();
  },
  async doUnlock() {
    const pass = (this.data.pass || '').trim();
    if (!pass) { wx.showToast({ title: '请填写班级访问密码', icon: 'none' }); return; }
    const room = this.data._pendingRoom || getRoom();
    this.setData({ busy: true });
    try {
      const r = await cmdOf('unlockClass', { pass }, room);
      if (!r || !r.ok) throw new Error((r && r.msg) || '解锁失败');
      wx.setStorageSync(unlockKey(room), pass);
      setRoom(room);
      this.setData({ pass: '', _pendingRoom: '' });
      wx.showToast({ title: '已解锁', icon: 'success' });
      await this.bootstrap();
    } catch (e) {
      wx.showToast({ title: e.message || '解锁失败', icon: 'none' });
      this.setData({ busy: false });
    }
  }
});
