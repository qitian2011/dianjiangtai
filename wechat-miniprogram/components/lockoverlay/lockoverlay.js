// 全屏班级锁 overlay（对齐 Ctrl 网页 #lockOverlay）：
// 当前班已加密时整屏盖住内容，输入「班级访问密码」解锁；下方提供「切换其他班级」入口。
// 用法：<lockoverlay show="{{s && s.locked}}" name="{{s.className}}" bind:unlocked="onSwitch" />
const { cmdOf, getRoom, setRoom } = require('../../utils/djt.js');

Component({
  properties: {
    show: { type: Boolean, value: false },   // true=当前班处于锁定态
    name: { type: String, value: '' }        // 班级名
  },
  data: {
    pass: '',
    msg: '',
    busy: false
  },
  observers: {
    show(v) { if (!v) this.setData({ pass: '', msg: '', busy: false }); }
  },
  methods: {
    onPass(e) { this.setData({ pass: e.detail.value, msg: '' }); },
    noop() {},   // 遮罩点击不放行
    async doUnlock() {
      const pass = (this.data.pass || '').trim();
      if (!pass) { this.setData({ msg: '请输入班级访问密码' }); return; }
      this.setData({ busy: true, msg: '' });
      try {
        const r = await cmdOf('unlockClass', { pass }, getRoom());
        if (!r || !r.ok) throw new Error((r && r.msg) || '密码不正确');
        this.setData({ pass: '', busy: false });
        this.triggerEvent('unlocked');
      } catch (e) {
        this.setData({ busy: false, msg: e.message || '解锁失败，请重试' });
      }
    },
    goSwitch() {
      // 「切换其他班级」→ 去连接页（那里的班级列表可切换/解锁），等价 Ctrl 锁屏上的切换按钮
      wx.navigateTo({ url: '/pages/connect/connect' });
    }
  }
});
