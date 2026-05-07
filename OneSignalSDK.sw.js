// ╔══════════════════════════════════════════════════════════════╗
// ║     OneSignalSDK.sw.js — 合并版 Service Worker  v5          ║
// ║                                                              ║
// ║  放在 GitHub 仓库根目录，与 index.html 同级                  ║
// ║  Netlify 部署后地址为 /OneSignalSDK.sw.js                    ║
// ╚══════════════════════════════════════════════════════════════╝

// ── 导入 OneSignal 官方 SW（处理服务端 push 订阅）───────────────
importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');

// ── 保活常量 ────────────────────────────────────────────────────
const SW_VERSION   = 'v5';
const CACHE_NAME   = 'jingyu-v5';
// 超过此时间未收到 ping，认为页面已挂起，SW 主动触发 Background Sync
const PING_TIMEOUT_MS = 45000;

// ── SW 内部状态 ─────────────────────────────────────────────────
let lastPingAt = Date.now();
let selfHealTimer = null;

// 自愈定时器：每 20s 检查一次 ping 是否超时
// 若超时（页面被挂起/Worker 被节流），SW 自行注册 Background Sync
// 这是在页面完全沉默时 SW 保持存活的"心跳"
const startSelfHeal = () => {
    if (selfHealTimer) return;
    selfHealTimer = setInterval(() => {
        const silent = Date.now() - lastPingAt;
        if (silent > PING_TIMEOUT_MS) {
            // 超时：页面可能已挂起，主动注册 Background Sync 唤醒
            self.registration.sync?.register('keep-alive').catch(() => {});
            console.log(`[SW ${SW_VERSION}] 自愈触发，静默 ${Math.round(silent/1000)}s`);
        }
    }, 20000);
};

// ── install ──────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
    console.log(`[SW ${SW_VERSION}] install`);
    // skipWaiting：新版本 SW 立刻激活，不等旧页面关闭
    event.waitUntil(self.skipWaiting());
});

// ── activate ────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
    console.log(`[SW ${SW_VERSION}] activated`);
    event.waitUntil(
        Promise.all([
            self.clients.claim(),                   // 立刻接管所有已打开的页面
            // 清理旧版本缓存
            caches.keys().then(keys =>
                Promise.all(
                    keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
                )
            ),
            // 激活即注册 Background Sync，确保后台唤醒能力
            self.registration.sync?.register('keep-alive').catch(() => {})
        ]).then(() => {
            startSelfHeal(); // 启动自愈定时器
        })
    );
});

// ── fetch ────────────────────────────────────────────────────────
// 注意：OneSignal importScripts 后可能已注册了 fetch handler。
// 为避免冲突，我们用 try-catch 包裹 respondWith，
// 并只处理 OneSignal 不会处理的请求（同源 HTML / 保活 ping）。
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // 只处理同源请求
    if (url.origin !== self.location.origin) return;

    // 保活 ping（HEAD /favicon.ico?_ka=...）
    if (url.pathname === '/favicon.ico' && url.searchParams.has('_ka')) {
        event.respondWith(
            fetch(event.request, { cache: 'no-store' })
                .catch(() => new Response('', { status: 204 }))
        );
        return;
    }

    // HTML 入口：永远走网络，不读缓存（保证 GitHub push 后立刻生效）
    if (url.pathname === '/' || url.pathname.endsWith('.html')) {
        event.respondWith(
            fetch(event.request, { cache: 'no-store' })
                .catch(() => caches.match(event.request))
        );
        return;
    }

    // 其他同源静态资源：网络优先 + 缓存备用
    event.respondWith(
        fetch(event.request)
            .then(res => {
                if (event.request.method === 'GET' && res.ok) {
                    caches.open(CACHE_NAME)
                          .then(c => c.put(event.request, res.clone()))
                          .catch(() => {});
                }
                return res;
            })
            .catch(() => caches.match(event.request))
    );
});

// ── message：接收页面的消息 ──────────────────────────────────────
// 每个分支都必须调用 event.waitUntil()，否则 SW 会在 handler 执行完后被杀死
self.addEventListener('message', (event) => {
    const data = event.data;
    if (!data?.type) return;

    // 更新最后心跳时间
    lastPingAt = Date.now();

    // ── ping ─────────────────────────────────────────────────────
    if (data.type === 'ping') {
        if (!selfHealTimer) startSelfHeal(); // 确保自愈定时器在运行
        event.waitUntil(
            self.clients
                .matchAll({ type: 'window', includeUncontrolled: true })
                .then(clients => {
                    clients.forEach(c => c.postMessage({
                        type: 'pong',
                        ts: Date.now(),
                        version: SW_VERSION
                    }));
                    // 每次 ping 同时重新注册 Background Sync
                    return self.registration.sync?.register('keep-alive').catch(() => {});
                })
        );
        return;
    }

    // ── 页面进入后台 ─────────────────────────────────────────────
    if (data.type === 'page-hidden') {
        event.waitUntil(
            self.registration.sync?.register('keep-alive').catch(() => Promise.resolve())
        );
        return;
    }

    // ── 显示通知（最可靠路径：由 SW 在 waitUntil 内发出）────────
    if (data.type === 'show-notification') {
        const { title = '新消息', body = '', icon, tag } = data;
        event.waitUntil(
            self.registration.showNotification(title, {
                body: body || '',
                icon: icon || '/icon-192.png',
                badge: '/icon-192.png',
                tag: tag || ('chat-' + Date.now()),
                renotify: true,     // 同 tag 也重新弹出（确保每条消息都可见）
                silent: false,
                data: { type: 'chat', origin: self.location.origin }
            })
        );
        return;
    }

    // ── Watchdog 节流通知 ────────────────────────────────────────
    if (data.type === 'wakeup') {
        event.waitUntil(
            self.registration.sync?.register('keep-alive').catch(() => Promise.resolve())
        );
        return;
    }
});

// ── Background Sync ──────────────────────────────────────────────
// 浏览器在有网络时会唤醒 SW 执行此任务
// 即使页面被完全挂起，Chrome Android 也能通过这个路径触发消息
self.addEventListener('sync', (event) => {
    if (event.tag !== 'keep-alive') return;
    event.waitUntil(
        self.clients
            .matchAll({ type: 'window', includeUncontrolled: true })
            .then(clients => {
                if (clients.length === 0) {
                    // 没有打开的页面：SW 独立运行（真正的后台）
                    // 此时只能依赖 OneSignal 的服务端推送
                    console.log(`[SW ${SW_VERSION}] 后台独立运行，无活跃页面`);
                    return;
                }
                // 通知页面触发一次自动回复
                clients.forEach(c => c.postMessage({
                    type: 'trigger-reply',
                    source: 'background-sync'
                }));
            })
    );
});

// ── Periodic Background Sync（Chrome Android 支持）───────────────
self.addEventListener('periodicsync', (event) => {
    if (event.tag === 'periodic-heartbeat') {
        event.waitUntil(
            self.clients.matchAll({ type: 'window' }).then(clients => {
                clients.forEach(c => c.postMessage({ type: 'trigger-reply', source: 'periodic-sync' }));
            })
        );
    }
});

// ── push：服务端推送（OneSignal REST API）───────────────────────
self.addEventListener('push', (event) => {
    // OneSignal 的 push 由 importScripts 里的代码处理
    // 这里处理自定义 VAPID push（如果有）
    if (!event.data) return;
    let payload;
    try { payload = event.data.json(); }
    catch { payload = { title: '新消息', body: event.data.text() }; }
    const { title = '新消息', body = '', icon = '/icon-192.png' } = payload;
    event.waitUntil(
        self.registration.showNotification(title, {
            body, icon, badge: '/icon-192.png',
            tag: 'push-' + Date.now(), renotify: true,
            data: { type: 'chat', origin: self.location.origin }
        })
    );
});

// ── notificationclick ───────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
    const d = event.notification.data;
    if (!d || d.type !== 'chat') return;    // 只处理我们自己发的通知
    event.notification.close();
    event.waitUntil(
        self.clients
            .matchAll({ type: 'window', includeUncontrolled: true })
            .then(clients => {
                const origin = d.origin || self.location.origin;
                const existing = clients.find(c => c.url.startsWith(origin));
                if (existing) return existing.focus();
                return self.clients.openWindow('/');
            })
    );
});

console.log(`[SW ${SW_VERSION}] loaded`);
