// 引入 OneSignal 核心，必须放在第一行！
importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");

const SW_VERSION = 'v3.1-enhanced';
const CACHE_NAME = 'jingyu-cache-v3.1';

// ── install：跳过等待，立刻激活 ──
self.addEventListener('install', (event) => {
    console.log(`[SW ${SW_VERSION}] installing`);
    event.waitUntil(self.skipWaiting());
});

// ── activate：立刻接管所有 client，清理旧缓存 ──
self.addEventListener('activate', (event) => {
    console.log(`[SW ${SW_VERSION}] activated`);
    event.waitUntil(
        Promise.all([
            self.clients.claim(),
            caches.keys().then(keys =>
                Promise.all(
                    keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
                )
            )
        ])
    );
});

// ── fetch：网络请求拦截 ──
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;

    if (url.pathname === '/favicon.ico' && url.searchParams.has('_ka')) {
        event.respondWith(fetch(event.request).catch(() => new Response('', { status: 204 })));
        return;
    }

    // HTML 绝对走网络，防止更新后用户看不到新版本
    if (url.pathname === '/' || url.pathname.endsWith('.html')) {
        event.respondWith(
            fetch(event.request, { cache: 'no-store' })
                .catch(() => caches.match(event.request))
        );
        return;
    }

    event.respondWith(
        fetch(event.request)
            .then(response => {
                if (event.request.method === 'GET' && response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});

// ── message：主页面与 SW 通信，核心保活机制 ──
self.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || !data.type) return;

    if (data.type === 'ping') {
        event.waitUntil(
            self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
                .then(clients => {
                    clients.forEach(c => c.postMessage({ type: 'pong', ts: Date.now(), swVersion: SW_VERSION }));
                    return self.registration.sync?.register('keep-alive').catch(() => {});
                })
        );
        return;
    }

    if (data.type === 'page-hidden') {
        event.waitUntil(
            Promise.resolve().then(() => self.registration.sync?.register('keep-alive').catch(() => {}))
        );
        return;
    }

    // 处理前端手动触发的强提醒通知
    if (data.type === 'show-notification') {
        event.waitUntil(
            self.registration.showNotification(data.title, {
                body: data.body || '',
                icon: data.icon || '/icon-192.png',
                badge: '/icon-192.png', // 安卓状态栏小图标
                tag: data.tag || ('chat-' + Date.now()),
                vibrate: [200, 100, 200, 100, 200], // 强震动提示
                requireInteraction: true, // 核心增强：通知不会自动消失，直到用户点击或清除 (类似微信)
                renotify: true, // 新消息来了会重新震动
                data: { type: 'chat', url: self.location.origin }
            })
        );
        return;
    }
});

// ── Background Sync & Periodic Sync ──
self.addEventListener('sync', (event) => {
    if (event.tag === 'keep-alive' || event.tag === 'sync-chat') {
        event.waitUntil(
            self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(clients => {
                clients.forEach(c => c.postMessage({ type: 'trigger-reply', source: 'sync' }));
            })
        );
    }
});

self.addEventListener('periodicsync', (event) => {
    if (event.tag === 'periodic-keep-alive' || event.tag === 'chat-refresh') {
        event.waitUntil(
            self.clients.matchAll({ type: 'window' }).then(clients => {
                clients.forEach(c => c.postMessage({ type: 'trigger-reply', source: 'periodic-sync' }));
            })
        );
    }
});

// ── push：接收自定义 Web Push 消息 ──
self.addEventListener('push', (event) => {
    // OneSignal 自己会处理它发来的 Push，这里是处理你自己的服务器发的 Push
    if (!event.data) return;
    
    let payload;
    try {
        payload = event.data.json();
    } catch (e) {
        payload = { title: '新消息', body: event.data.text() };
    }

    event.waitUntil(
        self.registration.showNotification(payload.title || '新消息', {
            body: payload.body || '',
            icon: payload.icon || "/icon-192.png",
            badge: payload.badge || "/icon-192.png",
            vibrate: [200, 100, 200, 100, 200],
            tag: payload.chatid || ('push-' + Date.now()),
            renotify: true,
            requireInteraction: true, // 核心增强：强制停留屏幕
            data: payload.data || { url: self.location.origin }
        })
    );
});

// ── notificationclick：用户点击通知时的完美唤醒逻辑 ──
self.addEventListener('notificationclick', (event) => {
    event.notification.close(); // 先关横幅
    
    const targetUrl = (event.notification.data && event.notification.data.url) ? event.notification.data.url : self.location.origin;

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
            // 1. 如果有可见的窗口，直接聚焦
            const visibleClient = clients.find(c => c.visibilityState === 'visible');
            if (visibleClient) return visibleClient.focus();
            
            // 2. 如果有被隐藏到后台的同域名窗口，聚焦它
            const anyClient = clients.find(c => c.url.includes(self.location.origin));
            if (anyClient) return anyClient.focus();
            
            // 3. 如果彻底没打开（被杀后台），新开一个窗口
            return self.clients.openWindow(targetUrl);
        })
    );
});