/**
 * sw.js — Service Worker for 星降长桉林
 * 放置位置：GitHub Pages 仓库根目录（与 index.html 同级）
 * 路径确认：https://moraleskento8-tech.github.io/Lorstar121/sw.js
 */

const CACHE = 'lorstar-v4';

// ── 安装 ──
self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE)
            .then(c => c.addAll(['./', './index.html']))
            .then(() => self.skipWaiting())
    );
});

// ── 激活 ──
self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(k => k !== CACHE).map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

// ── 网络请求拦截（网络优先，降级缓存）──
self.addEventListener('fetch', e => {
    e.respondWith(
        fetch(e.request)
            .then(res => {
                if (res.ok && e.request.method === 'GET') {
                    const clone = res.clone();
                    caches.open(CACHE).then(c => c.put(e.request, clone));
                }
                return res;
            })
            .catch(() => caches.match(e.request))
    );
});

// ── 接收后台 Push 推送（核心！）──
self.addEventListener('push', e => {
    let data = { title: '静语·星降', body: '你有新消息' };
    try {
        if (e.data) data = e.data.json();
    } catch (_) {
        if (e.data) data.body = e.data.text();
    }

    const options = {
        body:              data.body || '',
        icon:              data.icon  || './icon-192.png',
        badge:             './icon-192.png',
        tag:               data.tag   || 'chat',
        renotify:          true,
        requireInteraction: false,
        vibrate:           [200, 100, 200],
        data: {
            url: self.location.origin + self.registration.scope,
            ...data
        },
    };

    e.waitUntil(
        self.registration.showNotification(data.title || '静语·星降', options)
    );
});

// ── 通知点击 ──
self.addEventListener('notificationclick', e => {
    e.notification.close();
    const target = (e.notification.data && e.notification.data.url)
        || self.location.origin;

    e.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then(cs => {
                // 如果已有窗口打开就 focus，否则新开
                const win = cs.find(c => c.url === target && 'focus' in c);
                return win ? win.focus() : clients.openWindow(target);
            })
    );
});

// ── 通知关闭（可选）──
self.addEventListener('notificationclose', () => {});
