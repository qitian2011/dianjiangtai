# -*- coding: utf-8 -*-
# 一次性改造：移除小程序端「全局云端访问密码」(PIN 上移 proxy 云函数注入)
# 幂等：每项输出命中次数；0 命中=该项已是目标态（无需担心）
import io, sys

ROOT = r'D:/Users/18117/Desktop/点将台桌面版/微信小程序-控制端/'

# (文件, [(old, new), ...])
JOBS = [
  (ROOT + 'utils/djt.js', [
    ("const PIN_KEY = 'djt_mp_pin';\nconst SID_KEY = 'djt_mp_sid';",
     "const SID_KEY = 'djt_mp_sid';"),
    ("function getPin() { return wx.getStorageSync(PIN_KEY) || ''; }\nfunction setPin(v) { wx.setStorageSync(PIN_KEY, String(v || '').trim()); }\n\n",
     "// 云端访问密码已上移：由 proxy 云函数环境变量 PIN 持有并自动注入，本端不再存储/传输密码\n\n"),
    ("if (status === 401) e.code = 'pin401';          // 云端访问密码缺失/错误",
     "if (status === 401) e.code = 'pin401';          // 云端拒绝访问：proxy 未配 PIN / 云端 PIN 不匹配（部署问题）"),
    ("function call(method, path, room, body) {\n  const pin = getPin();\n  const sid = getSid();\n  const query = { room: room || '1', sid };\n  if (pin) query.pin = pin;",
     "function call(method, path, room, body) {\n  const sid = getSid();\n  const query = { room: room || '1', sid };"),
    ("module.exports = { getPin, setPin, getSid, getRoom, setRoom, getState, cmd, getStateOf, cmdOf, getStateWithDir };",
     "module.exports = { getSid, getRoom, setRoom, getState, cmd, getStateOf, cmdOf, getStateWithDir };"),
  ]),
  (ROOT + 'utils/ui.js', [
    ("// 401（云端访问密码失效/未保存）时引导到连接页；已在连接页则不重复跳转（防轮询堆栈）",
     "// 连接异常（401 云端拒绝 / 部署未配置）时引导到连接页查看详情；已在连接页则不重复跳转（防轮询堆栈）"),
    ("  wx.showToast({ title: title || '云端访问密码失效', icon: 'none' });",
     "  wx.showToast({ title: title || '连接失败', icon: 'none' });"),
  ]),
  (ROOT + 'cloudfunctions/proxy/index.js', [
    ("const BASE = (process.env.BASE_URL || 'https://qitian.dpdns.org').replace(/\\/+$/, '');\n\nexports.main = async (event) => {",
     "const BASE = (process.env.BASE_URL || 'https://qitian.dpdns.org').replace(/\\/+$/, '');\n// 云端访问密码（PIN）由 proxy 环境变量持有并注入：小程序端不感知、不传输密码。\n// 部署：云开发控制台 → 云函数 → proxy → 配置 → 新增环境变量 PIN = 云端口令（与 worker 的 PIN 一致）。\nconst PIN = String(process.env.PIN || '');\n\nexports.main = async (event) => {"),
    ("  const q = (event.q && typeof event.q === 'object') ? event.q : {};\n  const pin = String(event.pin || '');\n\n  const params = new URLSearchParams();\n  Object.keys(q).forEach(k => {\n    const v = q[k];\n    if (v !== undefined && v !== null && v !== '') params.append(k, String(v));\n  });\n  if (pin) params.set('pin', pin);",
     "  const q = (event.q && typeof event.q === 'object') ? event.q : {};\n\n  if (!PIN) {\n    // fail-closed：未配置 PIN 一律不放行，并给出可操作的部署提示\n    return { status: 503, text: '', json: { ok: false, msg: 'proxy 云函数未配置 PIN 环境变量：请在云开发控制台为 proxy 新增环境变量 PIN 后重新部署' } };\n  }\n\n  const params = new URLSearchParams();\n  Object.keys(q).forEach(k => {\n    const v = q[k];\n    if (v !== undefined && v !== null && v !== '') params.append(k, String(v));\n  });\n  params.set('pin', PIN);   // 注入云端访问密码（服务端覆盖，客户端无法伪造）"),
    ("    const headers = { 'x-pin': pin, 'user-agent': 'djt-mp-proxy' };",
     "    const headers = { 'x-pin': PIN, 'user-agent': 'djt-mp-proxy' };"),
  ]),
  (ROOT + 'pages/roll/roll.js', [
    ("const { getState, getStateWithDir, cmd, getPin } = require('../../utils/djt.js');",
     "const { getState, getStateWithDir, cmd } = require('../../utils/djt.js');"),
  ]),
  (ROOT + 'pages/set/set.js', [
    ("const { getStateWithDir, cmd, getPin, getRoom, setRoom } = require('../../utils/djt.js');",
     "const { getStateWithDir, cmd, getRoom, setRoom } = require('../../utils/djt.js');"),
    ("    renameText: '',\n    pinSaved: false,\n    volValue: 30,",
     "    renameText: '',\n    volValue: 30,"),
    ("    this.setData({ pinSaved: !!getPin(), roomTxt: this.roomLabel() });",
     "    this.setData({ roomTxt: this.roomLabel() });"),
  ]),
  (ROOT + 'pages/set/set.wxml', [
    ("  <view class=\"tip mt6\" wx:if=\"{{!errTxt}}\" style=\"font-size:11px\">首次使用请先到「⚙ 连接设置」填写云端访问密码</view>",
     "  <!-- 首次使用无需云端密码：PIN 由 proxy 云函数注入 -->"),
    ("""    <view class="row-gap mt10">
      <view class="btn btn-sm btn-light" bindtap="goConnect">⚙ 云端连接设置（PIN）</view>
      <view class="tip">{{pinSaved ? '密码已保存' : '尚未保存云端密码'}}</view>
    </view>""",
     """    <view class="row-gap mt10">
      <view class="btn btn-sm btn-light" bindtap="goConnect">⚙ 连接与班级管理</view>
      <view class="tip">云端密码由 proxy 云函数注入，本端无需填写</view>
    </view>"""),
  ]),
]

OLD_401 = "if (e.code === 'pin401') { needConnect('云端访问密码失效'); this.setData({ loading: false, errTxt: '云端访问密码不正确或未设置，请到「连接」页填写' }); return; }"
NEW_401 = "if (e.code === 'pin401') { needConnect('云端拒绝访问'); this.setData({ loading: false, errTxt: '云端拒绝访问：proxy 云函数未配置 PIN 环境变量或与云端口令不一致（部署问题），请联系部署者' }); return; }"
OLD_TIP = "  <view class=\"tip mt6\" wx:if=\"{{!errTxt}}\" style=\"font-size:11px\">首次使用请先到「⚙ 连接设置」填写云端访问密码</view>"
NEW_TIP = "  <!-- 首次使用无需云端密码：PIN 由 proxy 云函数注入 -->"

# 批量 401 文案（业务页 js：若仍是旧文案则替换）
for p in ['pages/roll/roll.js', 'pages/page/page.js', 'pages/roster/roster.js', 'pages/tt/tt.js', 'pages/set/set.js']:
  JOBS.append((ROOT + p, [(OLD_401, NEW_401)]))
# 批量 tip 行（业务页 wxml：roll/page/roster/tt/set）
for p in ['pages/roll/roll.wxml', 'pages/page/page.wxml', 'pages/roster/roster.wxml', 'pages/tt/tt.wxml']:
  JOBS.append((ROOT + p, [(OLD_TIP, NEW_TIP)]))

def main():
  total_ok = 0
  for path, rules in JOBS:
    try:
      with io.open(path, 'r', encoding='utf-8') as f:
        txt = f.read()
    except Exception as e:
      print('READ-FAIL', path, e)
      continue
    changed = False
    for old, new in rules:
      n = txt.count(old)
      if n:
        txt = txt.replace(old, new)
        changed = True
        total_ok += n
        print('HIT x%d  %s' % (n, path.split('微信小程序-控制端/')[-1]))
    if changed:
      with io.open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(txt)
  print('---\nTOTAL REPLACEMENTS:', total_ok)

if __name__ == '__main__':
  main()
