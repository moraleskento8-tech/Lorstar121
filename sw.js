// sw.js — Service Worker for 静语·星降
const CACHE_NAME = 'lorstar-v4';

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE_NAME).then(c => c.addAll(['./', './index.html']))
    );
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', e => {
    e.respondWith(
        caches.match(e.request).then(cached => cached || fetch(e.request).catch(() => cached))
    );
});

// 接收服务端推送（OneSignal 后台推送时触发）
self.addEventListener('push', e => {
    let d = { title: '静语·星降', body: '你有新消息 ✨', icon: '/icon-192.png' };
    if (e.data) { try { d = { ...d, ...e.data.json() }; } catch(err) {} }
    e.waitUntil(
        self.registration.showNotification(d.title, {
            body: d.body,
            icon: d.icon,
            // 每次推送用唯一 tag，确保每条消息独立弹出不互相覆盖
            tag: 'push-' + Date.now(),
            silent: false,
            data: { type: 'chat' },
        })
    );
});

// 点击通知时的处理
// 关键：我们通过 clients.matchAll 找到已有的 App 窗口并聚焦
// 而不是用 clients.openWindow(url) 打开带 URL 的新窗口
// 这样通知栏就不会显示跳转地址
self.addEventListener('notificationclick', e => {
    e.notification.close();
    e.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
            // 找到已经打开的 App 窗口，直接聚焦
            const existing = cs.find(c => c.url.includes(self.registration.scope));
            if (existing) return existing.focus();
            // 如果 App 没有打开，则打开根路径（不带任何参数）
            return clients.openWindow(self.registration.scope);
        })
    );
});
