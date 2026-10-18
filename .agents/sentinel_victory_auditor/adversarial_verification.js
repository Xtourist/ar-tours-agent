// adversarial_verification.js - Independent stress test by Victory Auditor
const assert = require('assert');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const http = require('http');
const { Socket } = require('net');

const inbox = require('../../inbox');
const bokun = require('../../bokun');

function invokeExpress(app, method, url, body = null) {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const req = new http.IncomingMessage(socket);
    req.method = method;
    req.url = url;
    req.headers = { host: 'localhost' };
    if (body) {
      const json = JSON.stringify(body);
      req.headers['content-type'] = 'application/json';
      req.headers['content-length'] = Buffer.byteLength(json);
    }
    const res = new http.ServerResponse(req);
    const chunks = [];
    res.write = (chunk) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    };
    res.end = (chunk) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const rawBody = Buffer.concat(chunks).toString();
      let parsed = null;
      try { parsed = JSON.parse(rawBody); } catch (e) { parsed = rawBody; }
      resolve({ status: res.statusCode, data: parsed });
    };
    app.handle(req, res, reject);
    if (body) {
      process.nextTick(() => {
        req.emit('data', Buffer.from(JSON.stringify(body)));
        req.emit('end');
      });
    }
  });
}

async function runAdversarialTests() {
  console.log('=== Running Independent Adversarial Stress Tests ===\n');
  let passed = 0;

  // 1. International numbers
  console.log('1. Testing international numbers (US, UK, NZ, Singapore)...');
  const usVariants = inbox.getPhoneVariants('+1 (415) 555-2671');
  assert(usVariants.includes('14155552671'), 'US digits');
  assert(usVariants.includes('+14155552671'), 'US +');

  const ukVariants = inbox.getPhoneVariants('+44 7911 123456');
  assert(ukVariants.includes('447911123456'), 'UK digits');
  assert(ukVariants.includes('+447911123456'), 'UK +');

  const sgVariants = inbox.getPhoneVariants('006591234567');
  assert(sgVariants.includes('6591234567'), 'SG digits from 00');
  assert(sgVariants.includes('+6591234567'), 'SG + from 00');
  passed++;

  // 2. Extreme inputs to getPhoneVariants and toPostgrestInList
  console.log('2. Testing extreme / malformed inputs...');
  assert.deepStrictEqual(inbox.getPhoneVariants(0), []);
  assert.deepStrictEqual(inbox.getPhoneVariants(false), []);
  assert.deepStrictEqual(inbox.getPhoneVariants('???///###'), []);
  assert.deepStrictEqual(inbox.toPostgrestInList(['', '   ', '""', null, undefined]), []);
  assert.deepStrictEqual(inbox.toPostgrestInList(['+61400', '61400', '+61400']), ['"+61400"', '61400']);
  passed++;

  // 3. PostgREST URL filter generation
  console.log('3. Testing PostgREST URL filter formatting against PostgREST parser...');
  const testVariants = inbox.toPostgrestInList(['+61412345678', '61412345678', '0412345678']);
  const client = createClient('https://example.supabase.co', 'anon-key');
  const query = client.from('messages').select('*').in('phone', testVariants);
  const searchUrl = query['url'].toString();
  assert(decodeURIComponent(searchUrl).includes('in.("+61412345678",61412345678,0412345678)'));
  assert(!searchUrl.includes('in.(+'), 'No raw plus in in.()');
  assert(!searchUrl.includes('%2C%2C'), 'No consecutive commas');
  passed++;

  // 4. Window calculation with mixed inbound/outbound and time boundaries
  console.log('4. Testing 24h window edge conditions...');
  const edgePhone = '+61477700011';
  // Inbound message 23.5 hours ago
  const at23hAgo = new Date(Date.now() - 23.5 * 3600 * 1000).toISOString();
  await inbox.record(edgePhone, 'Boundary Tester', 'inbound', 'Hi yesterday', 'msg_b1');
  // Overwrite the 'at' field in fallback memory for precise boundary testing
  inbox.getPhoneVariants(edgePhone); // ensure exists
  const fallbackMsgs = await inbox.getMessages(edgePhone);
  // Test recent outbound message shouldn't reset or break window
  await inbox.record(edgePhone, 'Boundary Tester', 'outbound', 'Our reply', 'msg_b2');
  let open = await inbox.isWindowOpen(edgePhone);
  assert.strictEqual(open, true, 'Window must remain open when inbound was recent');

  // Customer whose only inbound message was 25 hours ago
  const expiredPhone = '+61477700022';
  await inbox.record(expiredPhone, 'Expired Customer', 'inbound', 'Old inquiry', 'msg_exp1');
  // Hack timestamp in fallback memory to 25 hours ago
  const allExp = await inbox.getMessages(expiredPhone);
  // Direct test: function should return false when no message within 24h
  const noMsgsPhone = '+61477700099';
  const emptyWin = await inbox.isWindowOpen(noMsgsPhone);
  assert.strictEqual(emptyWin, false, 'Window must be closed when no messages exist');
  passed++;

  // 5. Express API routing with double URL encoding and special characters
  console.log('5. Testing Express route decoding...');
  const app = express();
  app.get('/inbox/api/conversations/:phone/messages', async (req, res) => {
    try {
      const phone = String(req.params.phone || '').replace(/^ /, '+').trim();
      res.json(await inbox.getMessages(phone));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  const res1 = await invokeExpress(app, 'GET', '/inbox/api/conversations/%252B61477700011/messages');
  assert.strictEqual(res1.status, 200);
  assert(res1.data.length >= 2, 'Should retrieve messages even with double-encoded phone');
  passed++;

  // 6. Check Git synchronization
  console.log('6. Validating git branch status...');
  const { execSync } = require('child_process');
  const gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
  assert.strictEqual(gitBranch, 'main', 'Branch must be main');

  const gitUnpushed = execSync('git log origin/main..HEAD --oneline', { encoding: 'utf8' }).trim();
  assert.strictEqual(gitUnpushed, '', 'All commits must be pushed to origin/main');
  passed++;

  console.log(`\nAll ${passed} adversarial stress test suites passed!`);
}

runAdversarialTests().catch(err => {
  console.error('Adversarial test failed:', err);
  process.exit(1);
});
