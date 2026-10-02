/* Lorstar OneSignal Service Worker
 * Keep this file at the site root as /OneSignalSDK.sw.js
 */
importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');

const SW_VERSION = 'lorstar-v6';

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/' || url.pathname.endsWith('.html')) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }).catch(() => caches.match(event.request)));
  }
});

self.addEventListener('message', event => {
  const data = event.data || {};
  if (!data.type) return;

  if (data.type === 'ping') {
    event.waitUntil(
      self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(list => {
        list.forEach(client => client.postMessage({ type: 'pong', ts: Date.now(), swVersion: SW_VERSION }));
      })
    );
    return;
  }

  if (data.type === 'page-hidden') {
    self.__pageHiddenAt = data.ts || Date.now();
    return;
  }

  if (data.type === 'show-notification') {
    event.waitUntil(
      self.registration.showNotification(data.title || '消息提醒', {
        body: data.body || '',
        icon: data.icon || '/icon-192.png',
        badge: data.badge || '/icon-192.png',
        tag: data.tag || ('app-message-' + Date.now()),
        renotify: data.renotify !== false,
        silent: !!data.silent,
        data: { ...(data.data || {}), __appCustom: true }
      })
    );
    return;
  }
});

// Background Sync 只负责“叫页面检查时间”，绝不直接触发回复。
// 页面会再次验证 activeMsgNextFireAt，因此不会绕过用户设置的主动间隔。
self.addEventListener('sync', event => {
  if (event.tag !== 'keep-alive') return;
  event.waitUntil(
    self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(list => {
      list.forEach(client => client.postMessage({ type: 'trigger-reply', source: 'background-sync' }));
    })
  );
});

// 自己创建的通知：优先聚焦已有 App，不导航到 /?openChat=1，避免整页刷新。
self.addEventListener('notificationclick', event => {
  const data = event.notification?.data || {};
  if (!data.__appCustom) return;

  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async list => {
      const sameOrigin = list.filter(c => {
        try { return new URL(c.url).origin === self.location.origin; } catch (e) { return false; }
      });
      // 优先复用当前已有窗口；不要因为通知点击而重新导航页面。
      const existing = sameOrigin.find(c => c.focused) || sameOrigin.find(c => 'focus' in c);
      if (existing) {
        try { await existing.focus(); } catch (e) {}
        try { existing.postMessage({ type: 'navigate-to-chat', source: 'notification-click' }); } catch (e) {}
        return;
      }
      // 只有系统已经把网页进程彻底回收、没有任何窗口时，才新建页面。
      return self.clients.openWindow ? self.clients.openWindow('/') : undefined;
    })
  );
});

console.log('[SW] ' + SW_VERSION + ' ready');
