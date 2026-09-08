// 点将台小程序通信封装：微信云函数代理 → 云端 worker.js
// 协议与点将台现有 H5 控制端完全一致，仅传输层不同（wx.cloud.callFunction 免域名白名单）
//
// 房间（room）语义与 H5 的 URL ?room= 一致：
//   '1'            = 主实例（管理中枢 + 目录源），仅用于拉班级目录，不作为上课工作房
//   某班级的 rid   = 该班级独立 DO（点名/名单/课表/传呼/广播都在它上面）
// 小程序同一时刻只在一个房间上下文里工作，切班 = setRoom(rid) 后再请求。
//
// ⚠️ 2026-09-06 修复：此前把「目录第 0 个班」硬编码映射到主实例 room '1'（假设它恒为示例班），
// 但实际首班可能是带独立 DO 的真实班级（如初三（2）班 c31ieon）。主实例 room'1' 与班级 DO
// 是两个不同 Durable Object：page/lastPick/解锁/SSE 广播等会话态互相隔离——
// 小程序发在 room'1' 上的点名/传呼，大屏（连班级 DO）永远收不到。故现在一律按 rid 访问班级，
// room '1' 只在「未选定班级」时作为临时目录语境，由 resolveRoom() 自动落到目录首班的 rid。

const SID_KEY = 'djt_mp_sid';
const ROOM_KEY = 'djt_mp_room';

// 云端访问密码已上移：由 proxy 云函数环境变量 PIN 持有并自动注入，本端不再存储/传输密码

// 当前房间上下文：默认 '1'（示例班）
function getRoom() { const r = wx.getStorageSync(ROOM_KEY); return r ? String(r) : '1'; }
function setRoom(r) { wx.setStorageSync(ROOM_KEY, r === '1' ? '1' : String(r || '1')); }

// 固定会话 sid（与浏览器标签页同语义）：本机持久化，解锁态按 sid 隔离
function getSid() {
  let s = wx.getStorageSync(SID_KEY);
  if (!s) {
    s = 'mp' + Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36);
    wx.setStorageSync(SID_KEY, s);
  }
  return s;
}

// 把 HTTP 状态翻译成可识别错误（code 供 UI 分流提示）
function httpError(status, json, raw) {
  const e = new Error((json && json.msg) || raw || ('HTTP ' + status));
  e.status = status;
  if (status === 401) e.code = 'pin401';          // 云端拒绝访问：proxy 未配 PIN / 云端 PIN 不匹配（部署问题）
  else if (status === 403) e.code = 'class403';    // 班级密码门禁（未解锁操作）
  else if (status === 503) e.code = 'server503';   // 云端未配置 PIN（fail-closed）
  else e.code = 'http' + status;
  return e;
}

// 底层请求：走云函数 proxy（部署见 cloudfunctions/proxy）
function call(method, path, room, body) {
  const sid = getSid();
  const query = { room: room || '1', sid };
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'proxy',
      data: { method, path, q: query, body: body || null }
    }).then(res => {
      const r = res && res.result;
      if (!r) return reject(new Error('云函数无返回'));
      if (r.status === 200) return resolve(r.json);
      reject(httpError(r.status, r.json || {}, '请求失败'));
    }).catch(err => {
      const m = new Error((err && err.errMsg) || '云函数调用失败');
      m.code = 'callfn';
      reject(m);
    });
  });
}

// —— 指定房间请求（跨房/目录等特殊场景） ——
function getStateOf(room) { return call('GET', '/api/state', room || '1'); }
function cmdOf(action, extra, room) {
  return call('POST', '/api/cmd', room || '1', Object.assign({ action }, extra || {}));
}

// —— 当前房间上下文请求（业务页面主用：跟随 getRoom/setRoom） ——
function getState() { return call('GET', '/api/state', getRoom()); }
function cmd(action, extra) {
  return call('POST', '/api/cmd', getRoom(), Object.assign({ action }, extra || {}));
}

// 房间归一：工作房必须是具体班级的 rid 独立 DO（与网页端「切班=换 ?room=rid」一致）。
// getRoom() 为 '1'（尚未选定班级 / 新装默认 / 删班回退）时，拉一次主实例目录，
// 自动落到目录首班（classes[0]）的 rid 并记住；目录为空则维持 '1'。
// 避免点名/传呼落在主实例 room'1' 的班级副本上——副本与班级 DO 会话隔离，接收端收不到。
async function resolveRoom() {
  let room = getRoom();
  if (room === '1') {
    const d = await call('GET', '/api/state', '1').catch(() => null);
    const first = (d && d.allClasses && d.allClasses[0]) || null;
    if (first && first.rid) { room = String(first.rid); setRoom(room); }
  }
  return room;
}

// 带班级目录的完整状态：当前房为 rid（班级实例）时其快照 allClasses 只含本班，
// 需并行向主实例('1')取全量目录，供顶部班级栏切换使用。
async function getStateWithDir() {
  const room = await resolveRoom();
  const [s, dir] = await Promise.all([
    call('GET', '/api/state', room),
    room !== '1' ? call('GET', '/api/state', '1').catch(() => null) : Promise.resolve(null)
  ]);
  const classes = (dir && dir.allClasses && dir.allClasses.length)
    ? dir.allClasses
    : (s.allClasses || []);
  return { s, classes, room };
}

module.exports = { getSid, getRoom, setRoom, getState, cmd, getStateOf, cmdOf, getStateWithDir, resolveRoom };
