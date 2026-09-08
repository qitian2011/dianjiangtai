# 点将台 · 微信小程序控制端

「点将台」课堂互动系统的**手机控制端小程序**，配合教室大屏与电脑/网页控制端使用。功能与 `../app/public/ctrl.html`（Ctrl 端）对齐：随机点名限时作答判定、学生传呼、名单管理与批量导入、课表公告、班级密码锁、深浅色主题切换。

## 架构（三件套）

```
微信小程序端（本目录）
   │  wx.cloud.callFunction('proxy', ...)
   ▼
云函数 cloudfunctions/proxy      ← 微信云开发；HTTPS 转发（无鉴权，云端已开放直连）
   │  HTTPS 转发
   ▼
云端服务 app/worker.js           ← Cloudflare Workers + Durable Object（qitian.dpdns.org）
```

- **班级密码**是运行时数据（教师在本班设置），与云端部署无关
- 名单/课表/记录均存于云端 Durable Object（每班一个独立实例），不在小程序本地

## 目录结构

```
pages/roll      点名（随机/按组/权重/倒计时判定）
pages/page      传呼
pages/roster    名单（增删/请假/权重/批量导入）
pages/tt        课表/公告/备忘录
pages/set       设置 + 主题切换
pages/connect   连接与班级管理（自动连接，无密码门槛）
components/     classbar 班级栏 / lockoverlay 锁屏
utils/theme.js  浅色/深色/跟随系统 三态主题
utils/djt.js    云端通信封装（wx.cloud 云函数代理）
cloudfunctions/proxy  云函数：转发到云端 worker（BASE_URL 可配）
tools/          图标生成/预览脚本
```

## 部署步骤（新环境）

1. **改 appid**：`project.config.json` 中 `appid` 换成你自己的小程序 AppID
2. **开通云开发**：开发者工具 → 云开发 → 开通（得到一个环境；多环境时在 `config.js` 填 `CLOUD_ENV`，单环境可留空）
3. **部署云函数**：右键 `cloudfunctions/proxy` →「上传并部署：云端安装依赖」
4. **连接云端**：设置页「连接与班级管理」→ 默认 `https://qitian.dpdns.org`；如需自建云端请改 `cloudfunctions/proxy/index.js` 的 `BASE_URL` 并部署云端 `app/worker.js`
5. **编译运行**：进入后自动连接目录首个班级（每班一个独立云端实例，点名/传呼与网页端/大屏互通）

> 没有自己的云端服务时无法使用——本小程序是**控制端**，必须有配套云端/大屏端在线。

## 开源说明

MIT License。真实学生名单属于隐私数据，不在本仓库；详见仓库根目录 LICENSE 与 README。
