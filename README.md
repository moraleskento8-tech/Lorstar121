# 星降长桉林 · 推送通知后台部署教程

> 目标：Cloudflare Worker 作为推送后端 + GitHub Pages 前端，实现真实浏览器推送通知。

---

## 文件清单

| 文件 | 用途 | 放置位置 |
|------|------|----------|
| `sw.js` | 真实 Service Worker | GitHub Pages 仓库根目录（与 index.html 同级）|
| `worker.js` | Cloudflare Worker 后端 | Cloudflare 部署 |
| `wrangler.toml` | Wrangler 配置文件 | 与 worker.js 同目录 |
| `generate-vapid.js` | 生成 VAPID 密钥 | 本地运行一次 |
| `push-client-patch.js` | 前端订阅代码 | 粘贴进 index.html |

---

## 第一步：生成 VAPID 密钥

```bash
# 安装依赖（只需一次）
npm install web-push

# 生成密钥
node generate-vapid.js
```

会输出：
```
VAPID_PUBLIC  = BXXXXXXX...
VAPID_PRIVATE = XXXXXXX...
```

**保存这两个值**，后面要用。

---

## 第二步：部署 Cloudflare Worker

### 2.1 安装 Wrangler
```bash
npm install -g wrangler
wrangler login    # 浏览器登录 Cloudflare 账号
```

### 2.2 创建 KV 命名空间
```bash
wrangler kv:namespace create PUSH_SUBS
# 复制输出的 id 和 preview_id，填入 wrangler.toml
```

### 2.3 设置 Secrets（不要写进代码！）
```bash
wrangler secret put VAPID_PUBLIC    # 粘贴 generate-vapid.js 输出的 publicKey
wrangler secret put VAPID_PRIVATE   # 粘贴 generate-vapid.js 输出的 privateKey
wrangler secret put VAPID_SUBJECT   # 填写: mailto:your@email.com
wrangler secret put PUSH_SECRET     # 填写任意随机字符串，如: Lorstar2024SecretXXX
```

### 2.4 部署
```bash
wrangler deploy
```

部署成功后会输出 Worker URL，例如：
```
https://lorstar-push.your-subdomain.workers.dev
```

---

## 第三步：配置 GitHub Pages sw.js

1. 将 `sw.js` 上传到仓库根目录（`/Lorstar121/sw.js`）
2. 确认可访问：`https://moraleskento8-tech.github.io/Lorstar121/sw.js`

---

## 第四步：修改 index.html

打开 `push-client-patch.js`，**替换**顶部两个常量：

```js
const PUSH_VAPID_PUBLIC = '你的 VAPID_PUBLIC';
const PUSH_WORKER_URL   = 'https://lorstar-push.你的子域.workers.dev';
```

然后将 `push-client-patch.js` 的**全部内容**粘贴到 `index.html` 的 `<script>` 标签内，
放在 Vue app 定义（`const app = Vue.createApp(...)`）的**上方**。

同时找到 index.html 中原有的 SW 注册代码（大约在 `// ===== Service Worker` 处），
**删除**原来的 Blob SW 注册代码，改为：
```js
// SW 已由 push-client-patch.js 注册，此处删除 Blob 版本
```

---

## 第五步：测试推送

### 手动触发推送（在终端运行）：
```bash
curl -X POST https://lorstar-push.你的子域.workers.dev/push \
  -H "Authorization: Bearer 你的PUSH_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"title":"静语·星降","body":"测试消息推送成功！"}'
```

### 推送给特定用户：
```bash
curl -X POST .../push \
  -H "Authorization: Bearer 你的PUSH_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"title":"新消息","body":"...","userId":"user-abc123"}'
```

---

## 常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| SW 注册失败 | sw.js 不在根目录 | 确认路径 `/Lorstar121/sw.js` 可访问 |
| 订阅失败 CORS | Worker 未配置 CORS | 检查 worker.js CORS 头，或改为仅允许你的域名 |
| 推送后无通知 | 浏览器未授权 | 前端需先调用 `Notification.requestPermission()` |
| iOS Safari 不支持 | iOS 16.4+ 需 PWA 安装 | 添加 manifest.json，引导用户"添加到主屏幕" |
| Blob SW 被替换后失效 | 缓存旧 SW | 清除浏览器缓存，或在 DevTools → Application → Service Workers 手动注销 |

---

## 架构图

```
浏览器（GitHub Pages）
  │
  ├─ sw.js（真实 Service Worker）
  │    └─ 接收 Push 事件 → 显示通知
  │
  └─ push-client-patch.js
       └─ navigator.serviceWorker.register('sw.js')
       └─ pushManager.subscribe(VAPID_PUBLIC)
       └─ POST /subscribe → Cloudflare Worker
                              │
                         KV 存储订阅信息
                              │
                   POST /push（触发推送）
                              │
                    Web Push API → 浏览器推送服务
                                        │
                               sw.js push 事件 → 通知弹出
```

---

*部署完成后，切换标签页仍可收到推送通知（由浏览器推送服务处理，无需页面在前台）。*
