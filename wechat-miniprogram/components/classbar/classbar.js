// 班级栏：对齐 Ctrl 网页顶栏 —— 横向班级 chips（当前班高亮、锁班标 🔒）
// 右侧操作：➕ 新建班级 / ✏️ 改名当前班 / 🗑 删除当前班 / ⚙ 连接与班级管理
// 交互语义与 ctrl.js 的 class-actions 一致：
//   · 点班级即切换（带锁班先输「班级访问密码」，成功后记住本次会话免二次输）
//   · 新建班级后留在原班（Ctrl 亦如此），新班出现在目录尾部可再点入
//   · 删除班级 = 删除当前班（Ctrl delClassBtn 语义），删完回示例班房
// 切班后组件发出事件 'switch'，宿主页面在 bindswitch 里执行「清空旧态 + 重新拉取」（等价 Ctrl 切班重载页面）。
const { cmdOf, getRoom, setRoom } = require('../../utils/djt.js');

// 班级解锁密码的会话级记忆：键 djUnlock:<rid>（与 Ctrl sessionStorage 同语义，本机重启即清由 storage 持续到显式清理）
const UNLOCK_PREFIX = 'djUnlock:';
function unlockKey(rid) { return UNLOCK_PREFIX + rid; }

Component({
  properties: {
    classes: { type: Array, value: [] },   // [{i,name,rid,locked}]  i=主实例下标（对齐 ctrl classSel 的 value）
    curIdx: { type: Number, value: 0 }     // 当前班 i
  },
  data: {
    mgrOpen: false
  },
  methods: {
    // —— 切班 ——
    onTap(e) {
      const i = Number(e.currentTarget.dataset.i);
      const c = this.data.classes.find(x => x.i === i);
      if (!c || i === this.data.curIdx) return;
      const room = i === 0 ? '1' : (c.rid || '');   // 示例班固定 '1' 房（与无参 H5 同构）
      if (!room) { wx.showToast({ title: '无法进入该班', icon: 'none' }); return; }
      if (c.locked) this.enterLocked(room, c.name);
      else this.goRoom(room);
    },
    goRoom(room) {
      setRoom(room);
      this.triggerEvent('switch');
    },
    // 带锁班：会话内已有密码 → 静默自动解锁（Ctrl: sessionStorage djUnlock 自动 doUnlock）；没有 → 弹窗输入
    enterLocked(room, name) {
      const cached = wx.getStorageSync(unlockKey(room));
      if (cached) {
        wx.showLoading({ title: '解锁中', mask: true });
        cmdOf('unlockClass', { pass: cached }, room).then(r => {
          wx.hideLoading();
          if (r && r.ok) { this.goRoom(room); return; }
          wx.removeStorageSync(unlockKey(room));   // 密码已失效 → 清缓存走弹窗
          this.promptLock(room, name);
        }).catch(() => {
          wx.hideLoading();
          wx.removeStorageSync(unlockKey(room));
          this.promptLock(room, name);
        });
      } else {
        this.promptLock(room, name);
      }
    },
    promptLock(room, name) {
      wx.showModal({
        title: '🔒 ' + name + ' 已加密',
        editable: true,
        placeholderText: '输入该班「班级访问密码」',
        success: (res) => {
          if (!res.confirm) return;
          const pass = String((res.content || '')).trim();
          if (!pass) { wx.showToast({ title: '未输入密码', icon: 'none' }); return; }
          wx.showLoading({ title: '解锁中', mask: true });
          cmdOf('unlockClass', { pass }, room).then(r => {
            wx.hideLoading();
            if (!r || !r.ok) throw new Error((r && r.msg) || '密码不正确');
            wx.setStorageSync(unlockKey(room), pass);   // 记住本次会话
            this.goRoom(room);
            wx.showToast({ title: '已进入该班', icon: 'success' });
          }).catch(err => {
            wx.hideLoading();
            wx.showToast({ title: err.message || '解锁失败', icon: 'none' });
          });
        }
      });
    },

    // —— 班级管理（对齐 Ctrl class-actions）——
    onAdd() {
      wx.showModal({
        title: '新建班级',
        editable: true,
        placeholderText: '班级名称（留空自动命名）',
        success: r1 => {
          if (!r1.confirm) return;
          const name = String((r1.content || '')).trim();
          wx.showModal({
            title: '班级访问密码（可选）',
            editable: true,
            placeholderText: '留空 = 不加密',
            success: r2 => {
              if (!r2.confirm) return;
              const pass = String((r2.content || '')).trim();
              wx.showLoading({ title: '创建中', mask: true });
              cmdOf('addClass', { name, pass }, getRoom()).then(r => {
                wx.hideLoading();
                if (!r || !r.ok) throw new Error((r && r.msg) || '创建失败');
                wx.showToast({ title: '已创建「' + (name || '新班级') + '」', icon: 'success' });
                this.triggerEvent('switch');   // 刷新目录（新班出现在末尾，Ctrl 同：留在原班）
              }).catch(err => {
                wx.hideLoading();
                wx.showToast({ title: err.message || '创建失败', icon: 'none' });
              });
            }
          });
        }
      });
    },
    onRename() {
      const c = this.data.classes.find(x => x.i === this.data.curIdx);
      if (!c) return;
      wx.showModal({
        title: '修改班级名称',
        editable: true,
        placeholderText: '新名称',
        content: c.name,
        success: r => {
          if (!r.confirm) return;
          const name = String((r.content || '')).trim();
          if (!name || name === c.name) return;
          cmdOf('renameClass', { name }, getRoom()).then(r => {
            if (!r || !r.ok) throw new Error((r && r.msg) || '改名失败');
            wx.showToast({ title: '已改名', icon: 'success' });
            this.triggerEvent('switch');
          }).catch(err => wx.showToast({ title: err.message || '改名失败', icon: 'none' }));
        }
      });
    },
    onDel() {
      const c = this.data.classes.find(x => x.i === this.data.curIdx);
      if (!c) return;
      // Ctrl delClassBtn：删除前若该班带锁需要输入「班级访问密码」
      const askPass = () => {
        if (!c.locked) return doDel('');
        wx.showModal({
          title: '删除加密班级',
          content: '「' + c.name + '」已设置班级密码，删除需要输入它',
          editable: true,
          placeholderText: '班级访问密码',
          success: rr => { if (rr.confirm) doDel(String((rr.content || '')).trim()); }
        });
      };
      const doDel = (pass) => {
        wx.showModal({
          title: '确认删除',
          content: '删除班级「' + c.name + '」？该班名单、课表、统计将一并删除且不可恢复！',
          confirmColor: '#C0392B',
          success: r => {
            if (!r.confirm) return;
            wx.showLoading({ title: '删除中', mask: true });
            cmdOf('delClass', { index: c.i, confirm: true, pass }, getRoom()).then(r2 => {
              wx.hideLoading();
              if (!r2 || !r2.ok) throw new Error((r2 && r2.msg) || '删除失败');
              wx.removeStorageSync(unlockKey(c.rid));   // 删班后解锁记忆失效
              setRoom('1');                             // 回示例班房（Ctrl 删班后回首页）
              wx.showToast({ title: '已删除', icon: 'success' });
              this.triggerEvent('switch');
            }).catch(err => {
              wx.hideLoading();
              wx.showToast({ title: err.message || '删除失败', icon: 'none' });
            });
          }
        });
      };
      askPass();
    },

    goConnect() {
      wx.navigateTo({ url: '/pages/connect/connect' });
    }
  }
});
