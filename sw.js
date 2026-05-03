// ╔══════════════════════════════════════════════════════════════╗
// ║              静语·星降  Service Worker  v3                  ║
// ║                                                              ║
// ║  【最重要的一个文件】                                        ║
// ║  这个文件必须放在 GitHub 仓库根目录，与 index.html 同级。    ║
// ║  Netlify 部署后访问地址为 /sw.js。                           ║
// ║                                                              ║
// ║  核心功能：                                                  ║
// ║  1. 后台通知（页面隐藏时也能弹系统通知）                     ║
// ║  2. event.waitUntil() 保活（防止 SW 被浏览器 30s 后杀死）    ║
// ║  3. Background Sync（后台定期唤醒触发操作）                  ║
// ║  4. 通知点击→聚焦窗口                                        ║
// ╚══════════════════════════════════════════════════════════════╝

const SW_VERSION = 'v3.0';
const CACHE_NAME = 'jingyu-cache-v3';

// ── install：跳过等待，立刻激活 ─────────────────────────────────
// 不使用 skipWaiting 的话，新版本 SW 要等所有旧页面关闭才能生效，
// 导致更新时保活功能延迟恢复。
self.addEventListener('install', (event) => {
    console.log(`[SW ${SW_VERSION}] installing`);
    event.waitUntil(self.skipWaiting());
});

// ── activate：立刻接管所有 client ───────────────────────────────
// clients.claim() 让 SW 立刻控制所有打开的页面，
// 不需要用户刷新就能开始接收 message 和发送通知。
self.addEventListener('activate', (event) => {
    console.log(`[SW ${SW_VERSION}] activated`);
    event.waitUntil(
        Promise.all([
            self.clients.claim(),
            // 清除旧版本缓存
            caches.keys().then(keys =>
                Promise.all(
                    keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
                )
            )
        ])
    );
});

// ── fetch：拦截所有网络请求 ──────────────────────────────────────
// 【为什么要有 fetch handler？】
// 浏览器衡量 SW 是否"活跃"的一个重要指标是：它是否在处理 fetch 事件。
// 没有 fetch handler 的 SW 会被更激进地休眠。
// 这里采用 "网络优先" 策略：正常走网络，失败时降级到缓存。
// 对于通知图标等静态资源，缓存能加快加载速度。
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // 只处理同源请求，跨域资源（CDN）直接放行
    if (url.origin !== self.location.origin) return;

    // favicon.ico 是保活 ping 用的，不需要缓存，直接走网络
    if (url.pathname === '/favicon.ico' && url.searchParams.has('_ka')) {
        event.respondWith(
            fetch(event.request).catch(() => new Response('', { status: 204 }))
        );
        return;
    }

    // 其他同源请求：网络优先，失败时降级缓存
    event.respondWith(
        fetch(event.request)
            .then(response => {
                // 成功时，顺手缓存 GET 请求（图标、页面等静态资源）
                if (event.request.method === 'GET' && response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, clone);
                    });
                }
                return response;
            })
            .catch(() => {
                // 网络失败：尝试从缓存读取
                return caches.match(event.request);
            })
    );
});

// ── message：主页面 → SW 的通信 ─────────────────────────────────
// 【关键修复】：这里必须用 event.waitUntil() 包裹所有异步操作！
// 原因：浏览器在 SW 的 message handler 执行完毕后就会考虑关闭 SW。
// 如果 handler 是同步的或者不调用 waitUntil()，SW 会在 30s 后被杀死。
// 调用 waitUntil(somePromise) 告诉浏览器"我还有事没做完，先别关我"。
self.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || !data.type) return;

    console.log(`[SW ${SW_VERSION}] 收到消息:`, data.type);

    if (data.type === 'ping') {
        // ✅ waitUntil 延长 SW 生命周期，这是保活的核心！
        // 同时向所有打开的 client（页面）回复 pong，证明 SW 还活着
        event.waitUntil(
            self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
                .then(clients => {
                    clients.forEach(client => {
                        client.postMessage({ type: 'pong', ts: Date.now(), swVersion: SW_VERSION });
                    });
                    // 每次 ping 时也尝试重新注册 Background Sync
                    return self.registration.sync?.register('keep-alive').catch(() => {});
                })
        );
        return;
    }

    if (data.type === 'page-hidden') {
        // 主页面告诉 SW "我要进后台了"
        // SW 可以在这里做一些准备工作（如预缓存通知图标）
        event.waitUntil(
            Promise.resolve().then(() => {
                console.log('[SW] 页面进入后台，时间戳:', data.ts);
                // 注册一个 Background Sync，让浏览器在合适的时机唤醒 SW
                return self.registration.sync?.register('keep-alive').catch(() => {});
            })
        );
        return;
    }

    if (data.type === 'wakeup') {
        // Watchdog 检测到主线程节流，SW 记录日志
        event.waitUntil(
            Promise.resolve().then(() => {
                console.log('[SW] 检测到主线程节流，漂移:', data.drift, 'ms');
            })
        );
        return;
    }

    if (data.type === 'show-notification') {
        // 主页面请求 SW 直接发系统通知（最可靠的通知方式）
        const { title, body, icon, tag } = data;
        event.waitUntil(
            self.registration.showNotification(title, {
                body: body || '',
                icon: icon || '/icon-192.png',
                badge: '/icon-192.png',
                tag: tag || ('chat-' + Date.now()),
                renotify: false,
                silent: false,
                data: { type: 'chat', url: self.location.origin }
            })
        );
        return;
    }
});

// ── Background Sync：后台周期性唤醒 ─────────────────────────────
// 当用户的设备有网络时，浏览器会唤醒 SW 执行注册的 sync 任务。
// 这是目前 Web 最接近"真正后台运行"的机制（Android Chrome 支持较好）。
self.addEventListener('sync', (event) => {
    console.log(`[SW ${SW_VERSION}] Background Sync 触发:`, event.tag);

    if (event.tag === 'keep-alive') {
        event.waitUntil(
            self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
                .then(clients => {
                    if (clients.length === 0) {
                        // 没有打开的页面，SW 独立运行（真正的后台模式）
                        console.log('[SW] 后台独立运行，无活跃页面');
                        return Promise.resolve();
                    }
                    // 有打开的页面：通知主页面触发一次自动回复
                    clients.forEach(client => {
                        client.postMessage({ type: 'trigger-reply', source: 'background-sync' });
                    });
                    return Promise.resolve();
                })
        );
        return;
    }
});

// ── Periodic Background Sync：定期后台同步（Chrome Android）──────
// 比普通 Background Sync 更强大：可以定期（如每小时）唤醒 SW，
// 不需要用户手动触发 sync.register()。
// 需要 manifest.json 中 periodic-background-sync 权限，且浏览器支持。
self.addEventListener('periodicsync', (event) => {
    console.log(`[SW ${SW_VERSION}] Periodic Sync:`, event.tag);
    if (event.tag === 'periodic-keep-alive') {
        event.waitUntil(
            self.clients.matchAll({ type: 'window' }).then(clients => {
                clients.forEach(c => c.postMessage({ type: 'trigger-reply', source: 'periodic-sync' }));
            })
        );
    }
});

// ── notificationclick：用户点击通知 ─────────────────────────────
// 当用户点击系统通知弹窗时，SW 收到此事件。
// 目标：聚焦已打开的页面，而不是重新打开一个新标签页。
self.addEventListener('notificationclick', (event) => {
    console.log('[SW] 用户点击通知');
    event.notification.close(); // 先关掉通知弹窗

    event.waitUntil(
        self.clients.matchAll({
            type: 'window',
            includeUncontrolled: true
        }).then(clients => {
            // 优先聚焦已经打开的标签页
            const visibleClient = clients.find(c => c.visibilityState === 'visible') || clients[0];
            if (visibleClient) {
                return visibleClient.focus();
            }
            // 没有打开的页面：打开一个新标签页
            return self.clients.openWindow('/');
        })
    );
});

// ── push：接收服务端推送（OneSignal / Web Push） ─────────────────
// 如果你通过 OneSignal 控制台或 REST API 发送消息，会触发此事件。
// OneSignalSDK.sw.js 已经处理了 OneSignal 自己的 push，
// 这里只处理你自定义 VAPID 发送的 push（如果有的话）。
self.addEventListener('push', (event) => {
    if (!event.data) return;
    let payload;
    try {
        payload = event.data.json();
    } catch (e) {
        payload = { title: '新消息', body: event.data.text() };
    }

    const { title = '新消息', body = '', icon = '/icon-192.png', tag } = payload;
    event.waitUntil(
        self.registration.showNotification(title, {
            body,
            icon,
            badge: '/icon-192.png',
            tag: tag || ('push-' + Date.now()),
            data: { type: 'chat', url: self.location.origin }
        })
    );
});

console.log(`[SW ${SW_VERSION}] 脚本加载完成`);
