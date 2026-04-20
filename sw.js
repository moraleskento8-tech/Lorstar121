// ===================================================
// sw.js — 静语·星降 Service Worker
// 放在 Lorstar121/ 文件夹里（和 index.html 同级）
// ===================================================

const CACHE_NAME = 'jingyu-v1';

// 缓存这些文件，断网也能打开 App
const CACHE_URLS = [
  '/Lorstar121/',
  '/Lorstar121/index.html',
  '/Lorstar121/icon-192.png',
  '/Lorstar121/icon-512.png',
  '/Lorstar121/manifest.json',
];

// ===== 安装：预缓存核心文件 =====
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(CACHE_URLS).catch(() => {
        // 部分文件缓存失败也继续安装
      });
    })
  );
  self.skipWaiting();
});

// ===== 激活：清理旧缓存 =====
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ===== Fetch：离线优先策略 =====
self.addEventListener('fetch', event => {
  // 只缓存 GET 请求
  if (event.request.method !== 'GET') return;
  
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // 缓存成功的响应
        if (response.ok && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    }).catch(() => {
      // 完全离线时，返回主页
      if (event.request.destination === 'document') {
        return caches.match('/Lorstar121/index.html');
      }
    })
  );
});

// ===== Push：收到推送通知时显示弹窗 =====
self.addEventListener('push', event => {
  let data = { title: '静语·星降', body: '你收到了一条新消息 ✨' };
  
  try {
    if (event.data) {
      data = event.data.json();
    }
  } catch(e) {}

  const options = {
    body: data.body || '你收到了一条新消息 ✨',
    icon: '/Lorstar121/icon-192.png',
    badge: '/Lorstar121/icon-192.png',
    tag: 'chat-msg',
    renotify: true,
    requireInteraction: false,
    vibrate: [200, 100, 200],
    data: { url: '/Lorstar121/' },
    actions: [
      { action: 'open', title: '查看消息' },
      { action: 'close', title: '忽略' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title || '静语·星降', options)
  );
});

// ===== 点击通知：跳转到 App =====
self.addEventListener('notificationclick', event => {
  event.notification.close();

  if (event.action === 'close') return;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // 如果 App 已经打开，直接聚焦
      for (const client of clientList) {
        if (client.url.includes('/Lorstar121/') && 'focus' in client) {
          return client.focus();
        }
      }
      // 否则打开新窗口
      return clients.openWindow('/Lorstar121/');
    })
  );
});
