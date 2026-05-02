// ========================================================
// sw.js — Service Worker for 静语·星降
// ========================================================
// 这个文件需要和 index.html 放在同一个目录下（GitHub 仓库里）
// 它的作用有两个：
//   1. 缓存页面，让 App 能离线使用
//   2. 接收并显示推送通知（即使标签页已关闭）
// ========================================================

const CACHE_NAME = 'lorstar-v4';

// ——— 安装：把 index.html 缓存起来 ———
self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll(['./', './index.html']);
        })
    );
    self.skipWaiting(); // 安装后立即激活，不用等旧 SW 退出
});

// ——— 激活：清理旧版本缓存 ———
self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys
                    .filter(k => k !== CACHE_NAME)
                    .map(k => caches.delete(k))
            )
        )
    );
    self.clients.claim(); // 立即接管所有已打开的页面
});

// ——— 网络请求拦截：优先用缓存，缓存没有再联网 ———
self.addEventListener('fetch', e => {
    e.respondWith(
        caches.match(e.request).then(cached => cached || fetch(e.request).catch(() => cached))
    );
});

// ——— 接收服务端 Push 推送（OneSignal 或其他后端发来的）———
// 当你在 OneSignal 控制台或用 REST API 发送通知时，这里会被触发
self.addEventListener('push', e => {
    let data = { title: '静语·星降', body: '你有新消息 ✨', icon: '' };
    if (e.data) {
        try { data = { ...data, ...e.data.json() }; } catch(err) {}
    }
    e.waitUntil(
        self.registration.showNotification(data.title, {
            body: data.body,
            icon: data.icon || '',
            tag: 'chat-push',
            renotify: true,
            // badge: '' // 可选：手机状态栏的小图标
        })
    );
});

// ——— 用户点击通知时：跳转回 App ———
self.addEventListener('notificationclick', e => {
    e.notification.close();
    e.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
            // 如果 App 已经在某个标签页打开，直接聚焦那个标签页
            const existing = cs.find(c => c.url.includes('Lorstar121') || c.url.endsWith('/'));
            if (existing) return existing.focus();
            // 否则打开一个新标签页
            return clients.openWindow('./');
        })
    );
});

// ——— 被 index.html 直接调用的后台通知（不通过 OneSignal）———
// 当页面在后台、标签页未关闭时，index.html 会调用 swReg.showNotification()
// 这个 SW 文件不需要做任何额外处理，浏览器会自动弹出通知
// （这就是为什么要有真实的 SW 文件，Blob URL 方式无法实现这个功能）
