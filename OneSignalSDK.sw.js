// ╔══════════════════════════════════════════════════════════════╗
// ║        OneSignalSDK.sw.js — 合并版 Service Worker           ║
// ║                                                              ║
// ║  【为什么要合并？】                                          ║
// ║  浏览器规则：一个 scope 只能有一个 SW 做 controller。        ║
// ║  之前 /sw.js 和 /OneSignalSDK.sw.js 都注册在 scope:/，       ║
// ║  两个 SW 互相抢控，ping 消息发给了不认识它的那个 SW，        ║
// ║  30秒后被浏览器杀死 → 通知无法发出 → 消息时有时无。         ║
// ║                                                              ║
// ║  解决：只用这一个文件，先 import OneSignal SDK，              ║
// ║  再追加我们自己的保活 + 通知逻辑。                           ║
// ║  /sw.js 不再需要，index.html 里的 /sw.js 注册也要删掉。      ║
// ╚══════════════════════════════════════════════════════════════╝

// ── 第一步：导入 OneSignal 官方 SW（处理服务端推送订阅）─────────
// OneSignal 的 push/pushsubscriptionchange 事件监听全在这里
importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');

// ── 第二步：我们自己的保活 + 通知逻辑 ──────────────────────────
// addEventListener 是叠加式的，不会覆盖 OneSignal 已注册的监听器，
// 两套逻辑完全并行，互不干扰。

const CUSTOM_VERSION = 'v3-combined';
const CACHE_NAME = 'jingyu-cache-v3';

// install：立刻跳过等待期，新 SW 马上生效，不用等所有旧标签页关闭
self.addEventListener('install', () => {
    console.log('[SW combined] install, skipWaiting');
    self.skipWaiting();
});

// activate：立刻接管所有已打开的页面（不需要用户刷新）
self.addEventListener('activate', (event) => {
    console.log('[SW combined] activated');
    event.waitUntil(
        Promise.all([
            self.clients.claim(), // 让这个新 SW 立刻成为所有页面的 controller
            // 顺便清理旧版本缓存，释放存储空间
            caches.keys().then(keys =>
                Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
            )
        ])
    );
});

// fetch：拦截网络请求
// 目的一：确保 HTML 永远从服务器拿最新版（不缓存，防止更新无效）
// 目的二：静态资源（图标等）缓存加速
// 目的三：有 fetch handler 的 SW 会被浏览器认为"更活跃"，不那么容易被休眠
self.addEventListener('fetch', (event) => {
    // 只处理同源请求
    if (!event.request.url.startsWith(self.location.origin)) return;

    const url = new URL(event.request.url);

    // 保活 ping 请求（HEAD /favicon.ico?_ka=...）：直接走网络，不缓存
    if (url.pathname === '/favicon.ico' && url.searchParams.has('_ka')) {
        event.respondWith(
            fetch(event.request).catch(() => new Response('', { status: 204 }))
        );
        return;
    }

    // ✅ HTML 入口文件：每次都从服务器取最新版，绝对不读缓存
    // 这是解决"GitHub 更新了但网站没变化"的关键
    if (url.pathname === '/' || url.pathname.endsWith('.html')) {
        event.respondWith(
            fetch(event.request, { cache: 'no-store' })
                .catch(() => caches.match(event.request)) // 断网时才降级缓存
        );
        return;
    }

    // 其他静态资源：网络优先，成功时写入缓存备用
    event.respondWith(
        fetch(event.request)
            .then(response => {
                if (event.request.method === 'GET' && response.ok) {
                    caches.open(CACHE_NAME).then(c => c.put(event.request, response.clone()));
                }
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});

// ── message：接收来自页面的消息 ──────────────────────────────────
// 【最关键的规则】：每个 handler 必须调用 event.waitUntil(somePromise)
// 原因：SW 的 message handler 执行完同步代码后，浏览器就会考虑关闭 SW。
//       只有 waitUntil() 才能告诉浏览器"我还有异步工作，先别关我"。
//       不调 waitUntil → SW 在 30 秒内被杀 → 下次通知无法发出。
self.addEventListener('message', (event) => {
    const data = event.data;
    if (!data?.type) return;

    // ── ping 保活 ─────────────────────────────────────────────
    if (data.type === 'ping') {
        // waitUntil 确保这个 async 操作完成前 SW 不会被杀
        event.waitUntil(
            self.clients.matchAll({ type: 'window', includeUncontrolled: true })
                .then(clients => {
                    // 回复 pong，让页面知道 SW 还活着
                    clients.forEach(c => c.postMessage({
                        type: 'pong',
                        ts: Date.now(),
                        version: CUSTOM_VERSION
                    }));
                    // 顺便重新注册 Background Sync，保持后台唤醒能力
                    return self.registration.sync?.register('keep-alive').catch(() => {});
                })
        );
        return;
    }

    // ── 页面进入后台 ──────────────────────────────────────────
    if (data.type === 'page-hidden') {
        // 页面告诉 SW "我要切到后台了，你来接管"
        event.waitUntil(
            self.registration.sync?.register('keep-alive').catch(() => Promise.resolve())
        );
        return;
    }

    // ── 显示通知（最可靠的路径）──────────────────────────────
    // 页面不直接调 reg.showNotification()，而是发消息给 SW，
    // 让 SW 在 event.waitUntil() 里调用 showNotification。
    // 这样即使页面主线程被节流，通知也能可靠发出。
    if (data.type === 'show-notification') {
        const { title = '新消息', body = '', icon, tag } = data;
        event.waitUntil(
            self.registration.showNotification(title, {
                body: body || '',
                icon: icon || '/icon-192.png', // 用默认图标保证不为空
                badge: '/icon-192.png',
                tag: tag || ('chat-' + Date.now()),
                renotify: false,
                data: { type: 'chat' }
            })
        );
        return;
    }

    // ── 节流 wakeup ───────────────────────────────────────────
    if (data.type === 'wakeup') {
        event.waitUntil(Promise.resolve());
        return;
    }
});

// ── Background Sync：后台唤醒后通知页面触发自动回复 ─────────────
self.addEventListener('sync', (event) => {
    if (event.tag === 'keep-alive') {
        event.waitUntil(
            self.clients.matchAll({ type: 'window', includeUncontrolled: true })
                .then(clients => {
                    clients.forEach(c => c.postMessage({
                        type: 'trigger-reply',
                        source: 'background-sync'
                    }));
                })
        );
    }
});

// ── notificationclick：用户点击通知 → 聚焦已有窗口 ─────────────
// 注意：OneSignal 也会注册自己的 notificationclick。
// 对于我们自己发出的通知（data.type === 'chat'），我们来处理聚焦逻辑。
self.addEventListener('notificationclick', (event) => {
    const notifData = event.notification.data;
    // 只处理我们自己发出的通知（带有 type:'chat' 标记）
    if (!notifData || notifData.type !== 'chat') return;

    event.notification.close();
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then(clients => {
                // 优先聚焦已有窗口
                const existing = clients.find(c => c.url.startsWith(self.location.origin));
                if (existing) return existing.focus();
                // 没有打开的窗口则新开一个
                return self.clients.openWindow('/');
            })
    );
});

console.log(`[SW combined ${CUSTOM_VERSION}] 脚本加载完成`);
