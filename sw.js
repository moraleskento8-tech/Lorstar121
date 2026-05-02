// sw.js — Service Worker for 静语·星降
// 必须和 index.html 放在同一目录（GitHub 仓库根目录）
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

// 接收服务端推送通知（OneSignal 后台推送）
self.addEventListener('push', e => {
    let d = { title: '静语·星降', body: '你有新消息 ✨', icon: '/icon-192.png' };
    if (e.data) { try { d = { ...d, ...e.data.json() }; } catch(err) {} }
    e.waitUntil(
        self.registration.showNotification(d.title, {
            body: d.body, icon: d.icon, tag: 'chat-push', renotify: true
        })
    );
});

// 点击通知 → 跳回 App
self.addEventListener('notificationclick', e => {
    e.notification.close();
    e.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
            const found = cs.find(c => c.url.includes(self.location.origin));
            return found ? found.focus() : clients.openWindow('/');
        })
    );
});
