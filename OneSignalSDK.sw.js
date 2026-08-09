// ═══════════════════════════════════════════════════════════════
// 这个文件必须放在网站【根目录】，和 index.html 同一层级，
// 文件名必须叫 OneSignalSDK.sw.js —— 一个字都不能改，
// 因为 index.html 里 OneSignal.init() 传的
// serviceWorkerPath: "/OneSignalSDK.sw.js" 就是按这个文件名+路径去找它的。
//
// ⚠️ 重要：这个网站【只应该有这一个】Service Worker，不要再单独注册 /sw.js。
// 之前 /sw.js 里写的"保活 / 后台唤醒 / 缓存"逻辑，本身根本没被注册使用
// （index.html 里只用 navigator.serviceWorker.ready 去等"当前正在控制页面
// 的那个 SW"，而真正被 OneSignal.init() 注册、控制页面的，一直是这个文件）。
// 所以之前 /sw.js 里那些 Background Sync / Periodic Sync / 保活逻辑其实从没
// 真正生效过，这也是"推送有时候收得到有时候收不到、还会延迟"的根本原因之一：
// 页面向"当前控制它的 SW"发 ping、注册 sync，但那个 SW（也就是这个文件，
// 旧版本）根本没有处理这些事件的代码，等于石沉大海。
// 这版把 /sw.js 里有用的部分（fetch 缓存策略、Background Sync 保活、
// Periodic Sync、message 心跳）合并进来了，并且修掉了 /sw.js 里的几个实际
// bug（下面详细注释标了 🐛）。以后只维护这一个文件就够了。
// ═══════════════════════════════════════════════════════════════

importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");

const SW_VERSION = 'v4.0';
const CACHE_NAME = 'jingyu-cache-v4';

// ───────────────────────────────────────────────────────────────
// 生命周期：装好就立刻接管，不等旧页面关闭
// ───────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        Promise.all([
            self.clients.claim(),
            caches.keys().then(keys =>
                Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
            )
        ])
    );
});

// ───────────────────────────────────────────────────────────────
// fetch：HTML 永远走网络（避免更新后页面不刷新），
// 其他同源静态资源网络优先、失败时降级到缓存
// ───────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return; // 跨域（CDN）直接放行，不拦截

    if (url.pathname === '/' || url.pathname.endsWith('.html')) {
        event.respondWith(
            fetch(event.request, { cache: 'no-store' }).catch(() => caches.match(event.request))
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

// ───────────────────────────────────────────────────────────────
// message：页面 ⇄ SW 通信（心跳 / 后台提醒页面已隐藏 / 代发系统通知）
// 🐛 修复点：原 sw.js 里这段逻辑是对的，但因为不在被实际注册的文件里而失效；
//    现在合并到这里，页面的 ping 才有对应的 pong。
// ───────────────────────────────────────────────────────────────
self.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || !data.type) return;

    if (data.type === 'ping') {
        event.waitUntil(
            self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(list => {
                list.forEach(c => c.postMessage({ type: 'pong', ts: Date.now(), swVersion: SW_VERSION }));
                return self.registration.sync?.register('keep-alive').catch(() => {});
            })
        );
        return;
    }

    if (data.type === 'page-hidden') {
        self.__pageHiddenAt = data.ts || Date.now();
        event.waitUntil(self.registration.sync?.register('keep-alive').catch(() => {}) || Promise.resolve());
        return;
    }

    if (data.type === 'show-notification') {
        event.waitUntil(
            self.registration.showNotification(data.title || '消息提醒', {
                body: data.body || '',
                icon: data.icon || '/icon-192.png',
                badge: data.badge || '/icon-192.png',
                tag: data.tag || 'app-message',
                renotify: data.renotify !== undefined ? data.renotify : true,
                silent: data.silent || false,
                data: { ...(data.data || {}), __appCustom: true },
            }).catch(() => {})
        );
        return;
    }
});

// ───────────────────────────────────────────────────────────────
// Background Sync：浏览器认为设备有网时唤醒 SW，通知页面触发一次自动回复。
// 🐛 修复点：原 sw.js 里重复注册了两个 'sync' 监听器，第二个 tag 叫
//    'sync-chat'，回调里调用了一个从未定义过的 syncMessages()，
//    只要触发就会抛 ReferenceError。这里只保留一个、且真正有效的版本。
// ───────────────────────────────────────────────────────────────
self.addEventListener('sync', (event) => {
    if (event.tag !== 'keep-alive') return;
    event.waitUntil(
        self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(list => {
            list.forEach(c => c.postMessage({ type: 'trigger-reply', source: 'background-sync' }));
        })
    );
});

// ───────────────────────────────────────────────────────────────
// Periodic Background Sync：定期唤醒（目前仅 Android Chrome、且需要
// 页面主动 register，见回复正文里"给页面追加"的说明）
// ───────────────────────────────────────────────────────────────
self.addEventListener('periodicsync', (event) => {
    if (event.tag !== 'periodic-keep-alive') return;
    event.waitUntil(
        self.clients.matchAll({ type: 'window' }).then(list => {
            list.forEach(c => c.postMessage({ type: 'trigger-reply', source: 'periodic-sync' }));
        })
    );
});

// ───────────────────────────────────────────────────────────────
// push：接收推送并弹系统通知。
// 🐛 修复点：原 sw.js 里也重复注册了两个 'push' 监听器；第二个直接
//    `event.data.json()`，一旦 push 没带 payload（event.data 为 null，
//    某些静默/心跳型推送就是这样），会抛 TypeError，导致该次推送
//    "有时候收不到通知、或者收到空通知"。这里合并成一个、带好 null 判断
//    和 JSON 解析失败兜底的版本。
// 注：OneSignal 自己的推送已经由上面 importScripts 进来的官方脚本处理，
//    这里主要是给你自己后端/Cloudflare Worker 直接用标准 Web Push
//    发送的消息兜底（如果没有走 OneSignal REST API 的话）。
// ───────────────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
    let payload = {};
    if (event.data) {
        try { payload = event.data.json(); }
        catch (e) { payload = { title: '新消息', body: event.data.text() }; }
    }
    const { title = '新消息', body = '', icon = '/icon-192.png', tag, chatid } = payload;
    event.waitUntil(
        self.registration.showNotification(title, {
            body,
            icon,
            badge: '/icon-192.png',
            vibrate: [200, 100, 200],
            tag: tag || chatid || ('push-' + Date.now()),
            renotify: true,
            requireInteraction: true,
            data: payload
        })
    );
});

// ───────────────────────────────────────────────────────────────
// notificationclick：自定义通知（show-notification 消息发出的那种）
// 点击后聚焦已打开的窗口，并告诉它跳到聊天界面；没有已打开的窗口就新开一个。
// 只处理带 __appCustom 标记的通知，不跟 OneSignal 自己推送的通知抢事件。
// ───────────────────────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
    if (!event.notification.data || !event.notification.data.__appCustom) return;
    event.notification.close();
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
            const existing = list.find(c => 'focus' in c);
            if (existing) {
                existing.postMessage({ type: 'navigate-to-chat' });
                return existing.focus();
            }
            if (self.clients.openWindow) return self.clients.openWindow('/?openChat=1');
        })
    );
});

// 点击 OneSignal 自己推送的通知：交给官方逻辑处理聚焦/开窗，
// 这里只是"顺便"告诉最终被聚焦的页面跳到聊天界面。
self.addEventListener('notificationclick', (event) => {
    if (event.notification.data && event.notification.data.__appCustom) return; // 上面那个监听器已经处理过了
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
            list.forEach(c => c.postMessage({ type: 'navigate-to-chat' }));
        })
    );
});

console.log(`[SW ${SW_VERSION}] 脚本加载完成`);
