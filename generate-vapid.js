/**
 * generate-vapid.js
 * 在本地 Node.js 运行，生成 VAPID 密钥对
 * 运行方式：node generate-vapid.js
 */

const { generateVAPIDKeys } = require('web-push');

const keys = generateVAPIDKeys();
console.log('\n===== VAPID 密钥（复制到 Cloudflare Secrets）=====\n');
console.log('VAPID_PUBLIC  =', keys.publicKey);
console.log('VAPID_PRIVATE =', keys.privateKey);
console.log('\n运行以下命令设置 Cloudflare Worker Secrets:');
console.log(`  wrangler secret put VAPID_PUBLIC`);
console.log(`  wrangler secret put VAPID_PRIVATE`);
console.log(`  wrangler secret put VAPID_SUBJECT   # 填写: mailto:your@email.com`);
console.log(`  wrangler secret put PUSH_SECRET     # 填写一个随机字符串`);
console.log('\n完成后，将 VAPID_PUBLIC 复制到 index.html 中 PUSH_VAPID_PUBLIC 变量\n');
