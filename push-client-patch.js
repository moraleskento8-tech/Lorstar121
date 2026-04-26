/**
 * push-client-patch.js
 * 将此代码块粘贴到 index.html 的 <script> 顶部（在 Vue app 定义之前）
 * 
 * 替换其中的常量后，此代码会：
 *   1. 注册真实 sw.js（不再用 Blob）
 *   2. 订阅 Push，将 subscription 发送给 Cloudflare Worker
 *   3. 后台接收推送通知
 */

// ⚠️ 替换为你的实际值
const PUSH_VAPID_PUBLIC  = 'YOUR_VAPID_PUBLIC_KEY_HERE';   // generate-vapid.js 输出的 publicKey
const PUSH_WORKER_URL    = 'https://lorstar-push.YOUR_SUBDOMAIN.workers.dev'; // Worker 部署 URL
const PUSH_USER_ID       = 'user-' + (localStorage.getItem('pushUserId') || (() => {
  const id = Math.random().toString(36).slice(2);
  localStorage.setItem('pushUserId', id);
  return id;
})());

// ── 注册 sw.js（同源，GitHub Pages 根目录）──
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    // 注意：scope 必须与 sw.js 所在路径匹配
    const reg = await navigator.serviceWorker.register('./sw.js', {
      scope: './'
    });
    console.log('[SW] 注册成功 scope:', reg.scope);
    return reg;
  } catch (e) {
    console.warn('[SW] 注册失败:', e);
    return null;
  }
}

// ── 订阅 Push ──
async function subscribePush(reg) {
  if (!reg || !reg.pushManager) return;
  try {
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(PUSH_VAPID_PUBLIC),
      });
    }
    // 发送订阅信息到 Cloudflare Worker
    await fetch(`${PUSH_WORKER_URL}/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), userId: PUSH_USER_ID }),
    });
    console.log('[Push] 订阅成功');
  } catch (e) {
    console.warn('[Push] 订阅失败:', e);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// ── 启动（等待首次用户手势后初始化，规避浏览器限制）──
(async () => {
  const reg = await registerServiceWorker();
  if (!reg) return;
  // 等待 SW 就绪
  await navigator.serviceWorker.ready;
  // 请求通知权限后订阅
  const perm = await Notification.requestPermission();
  if (perm === 'granted') {
    await subscribePush(reg);
  }
})();
