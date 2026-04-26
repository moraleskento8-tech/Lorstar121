/**
 * sw.js — 真实 Service Worker，放在 GitHub Pages 仓库根目录
 * 路径：/Lorstar121/sw.js  (与 index.html 同级)
 */

const CACHE = 'lorstar-v3';
const ASSETS = ['./', './index.html'];

// ── 安装：预缓存核心资源 ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── 激活：清理旧缓存 ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Fetch：网络优先，降级缓存 ──
self.addEventListener('fetch', e => {
  e.respondWith(
    fetch(e.request)
      .then(res => {
        // 缓存成功响应
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// ── Push 通知接收 ──
self.addEventListener('push', e => {
  let data = { title: '静语·星降', body: '你有新消息' };
  try { data = e.data.json(); } catch (_) {}

  e.waitUntil(
    self.registration.showNotification(data.title, {
      body:      data.body,
      icon:      data.icon  || './icon-192.png',
      badge:     data.badge || './icon-192.png',
      tag:       data.tag   || 'chat',
      renotify:  true,
      data:      { url: self.location.origin + self.registration.scope },
      actions: [
        { action: 'view', title: '查看' },
        { action: 'close', title: '关闭' },
      ]
    })
  );
});

// ── 通知点击 ──
self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'close') return;
  const target = (e.notification.data && e.notification.data.url) || self.location.origin;
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(cs => {
        const open = cs.find(c => c.url === target && 'focus' in c);
        return open ? open.focus() : clients.openWindow(target);
      })
  );
});
