// ═══════════════════════════════════════════════════════════════
// 这个文件必须放在网站【根目录】，和 index.html 同一层级，
// 文件名必须叫 OneSignalSDK.sw.js —— 一个字都不能改，
// 因为 index.html 里 OneSignal.init() 传的
// serviceWorkerPath: "/OneSignalSDK.sw.js" 就是按这个文件名+路径去找它的，
// 名字或路径对不上，Service Worker 会注册失败，推送和后台保活都会失效。
//
// 如果你的仓库根目录已经有一个 OneSignalSDK.sw.js
// （比如之前从 OneSignal 后台下载的），可以直接用这份替换掉——
// 第一行原样保留了 OneSignal 官方要求的 importScripts，
// 不会影响"时光信箱回信 / 日历回复"这些推送通知的正常工作，
// 只是在后面追加了这个 app 自己需要的保活/通知逻辑。
// ═══════════════════════════════════════════════════════════════

importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");

// ───────────────────────────────────────────────────────────────
// 以下是给 app 自定义追加的部分，OneSignal 的推送逻辑不受影响
// ───────────────────────────────────────────────────────────────

// 页面 ⇄ SW 消息通道：
//   ping      → 页面用来检测 SW 是否还活着（心跳）
//   show-notification → 页面切到后台时，让 SW 代为弹出系统通知
//                        （SW 级别的 showNotification 比页面里直接
//                        new Notification() 更不容易被系统吞掉/延迟）
//   page-hidden → 记录一下页面隐藏的时间戳，目前仅供调试用
self.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || !data.type) return;

    if (data.type === 'ping') {
        event.source?.postMessage({ type: 'pong', ts: Date.now() });
        return;
    }

    if (data.type === 'show-notification') {
        self.registration.showNotification(data.title || '消息提醒', {
            body: data.body || '',
            icon: data.icon || '/icon-192.png',
            badge: data.badge || '/icon-192.png',
            tag: data.tag || 'app-message',       // 有 tag 就用页面给的（比如每条消息独立 tag），没有就用默认值
            renotify: data.renotify !== undefined ? data.renotify : true,
            silent: data.silent || false,
            // __appCustom 标记这是本 app 自己发的通知，供下面 notificationclick 区分，
            // 不去跟 OneSignal 自己推送的通知抢点击事件
            data: { ...(data.data || {}), __appCustom: true },
        }).catch(() => {});
        return;
    }

    if (data.type === 'page-hidden') {
        self.__pageHiddenAt = data.ts || Date.now();
        return;
    }
});

// 点击上面这个自定义通知时，把已经打开的窗口切到前台；
// 没有已打开的窗口就开一个新的。
// 只处理带 __appCustom 标记的通知——OneSignal 自己推送的通知
// 由上面 importScripts 进来的官方逻辑处理，这里不会跟它抢点击事件。
self.addEventListener('notificationclick', (event) => {
    if (!event.notification.data || !event.notification.data.__appCustom) return;
    event.notification.close();
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
            const existing = list.find(c => 'focus' in c);
            if (existing) return existing.focus();
            if (self.clients.openWindow) return self.clients.openWindow('/');
        })
    );
});
