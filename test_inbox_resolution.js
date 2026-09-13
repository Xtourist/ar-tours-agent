// test_inbox_resolution.js - Automated tests for inbox resolution
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Socket } = require('net');
const { createClient } = require('@supabase/supabase-js');

const inbox = require('./inbox');
const bokun = require('./bokun');

let passedTests = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err);
    process.exit(1);
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err);
    process.exit(1);
  }
}

// In-process Express route dispatcher.
// Executes full Express routing, middleware, parameter decoding, and response generation
// without opening TCP sockets, preventing sandbox EPERM and proxy interference.
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
      try {
        parsed = JSON.parse(rawBody);
      } catch (e) {
        parsed = rawBody;
      }
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

async function runAllTests() {
  console.log('--- Running Inbox Resolution Test Suite ---\n');

  // Test 1: Phone normalization variants
  test('R1: getPhoneVariants produces clean digits and standard formats', () => {
    const v1 = inbox.getPhoneVariants('+61400040043');
    assert(v1.includes('61400040043'), 'Must include plain digits');
    assert(v1.includes('+61400040043'), 'Must include + leading format');
    assert(v1.includes('0400040043'), 'Must include AU local format');
    assert(!v1.includes('+0400040043'), 'Must NOT include invalid +04... format');

    const v2 = inbox.getPhoneVariants('61400040043');
    assert(v2.includes('61400040043'));
    assert(v2.includes('+61400040043'));
    assert(v2.includes('0400040043'));

    const v3 = inbox.getPhoneVariants('+61 400 040 043');
    assert(v3.includes('61400040043'));
    assert(v3.includes('+61400040043'));

    const v4 = inbox.getPhoneVariants(' 61400040043 ');
    assert(v4.includes('61400040043'));

    // Australian local format 04...
    const vLocal = inbox.getPhoneVariants('0400040043');
    assert(vLocal.includes('0400040043'));
    assert(vLocal.includes('61400040043'));
    assert(vLocal.includes('+61400040043'));
    assert(!vLocal.includes('+0400040043'), 'Local 04 must not produce +04 prefix');

    // URL encoded %2B and double encoded %252B
    const v5 = inbox.getPhoneVariants('%2B61400040043');
    assert(v5.includes('61400040043'), 'Must decode %2B without leaving digit 2');
    assert(v5.includes('+61400040043'));

    const v6 = inbox.getPhoneVariants('%252B61400040043');
    assert(v6.includes('61400040043'), 'Must handle double-encoded %252B');

    // Edge cases: null, undefined, empty, spaces, plus only
    assert.deepStrictEqual(inbox.getPhoneVariants(''), []);
    assert.deepStrictEqual(inbox.getPhoneVariants(null), []);
    assert.deepStrictEqual(inbox.getPhoneVariants(undefined), []);
    assert.deepStrictEqual(inbox.getPhoneVariants('   '), []);
    assert.deepStrictEqual(inbox.getPhoneVariants('+'), []);
    assert.deepStrictEqual(inbox.getPhoneVariants('+++'), []);
  });

  // Test 2: PostgREST filter encoding eliminates raw plus signs
  test('R1: toPostgrestInList quotes values containing special characters to prevent PostgREST syntax errors', () => {
    const rawVariants = ['61400040043', '+61400040043', '0400040043'];
    const postgrestList = inbox.toPostgrestInList(rawVariants);
    
    assert.strictEqual(postgrestList[0], '61400040043', 'Plain digits stay unquoted');
    assert.strictEqual(postgrestList[1], '"+61400040043"', 'Variants with + MUST be enclosed in double quotes');
    assert.strictEqual(postgrestList[2], '0400040043', 'Local digits stay unquoted');

    // Hardening: edge cases with null, undefined, empty strings, numbers
    const mixed = ['+61400040043', null, undefined, '', '   ', 61400040043];
    const cleanList = inbox.toPostgrestInList(mixed);
    assert.strictEqual(cleanList.length, 2, 'Must filter out null, undefined, and whitespace');
    assert(cleanList.includes('"+61400040043"'));
    assert(cleanList.includes('61400040043'));
    assert.deepStrictEqual(inbox.toPostgrestInList([]), []);
    assert.deepStrictEqual(inbox.toPostgrestInList(null), []);

    // Verify PostgREST URL generated by supabase-js
    const dummyClient = createClient('https://mock.supabase.co', 'mock-key');
    const query = dummyClient.from('messages').select('dir,body').in('phone', postgrestList);
    const searchString = query['url'].search;

    assert(!searchString.includes('phone=in.(+'), 'PostgREST query string MUST NOT contain raw unquoted plus sign');
    assert(searchString.includes('%22%2B61400040043%22'), 'Plus sign variant must be double-quoted and URL encoded');
  });

  // Test 3: Record and retrieve messages in fallback mode across all phone representations
  await asyncTest('R1: Message retrieval and window status across phone variants', async () => {
    const testPhone = '61499988877';
    await inbox.record(testPhone, 'Alice Test', 'inbound', 'Hello from Alice', 'msg_001');
    await inbox.record(testPhone, 'Alice Test', 'outbound', 'Hi Alice! How can we help?', 'msg_002');

    // Fetch using different representations
    const msgs1 = await inbox.getMessages('61499988877');
    assert.strictEqual(msgs1.length, 2, 'Should find messages by plain digits');

    const msgs2 = await inbox.getMessages('+61499988877');
    assert.strictEqual(msgs2.length, 2, 'Should find messages by + prefix');

    const msgs3 = await inbox.getMessages('%2B61499988877');
    assert.strictEqual(msgs3.length, 2, 'Should find messages by %2B encoded string');

    const msgs4 = await inbox.getMessages(' 61499988877 ');
    assert.strictEqual(msgs4.length, 2, 'Should find messages with spaces');

    // Edge cases: empty/whitespace should safely return [] without error
    const msgsEmpty = await inbox.getMessages('');
    assert.deepStrictEqual(msgsEmpty, []);
    const msgsSpaces = await inbox.getMessages('   ');
    assert.deepStrictEqual(msgsSpaces, []);
    const msgsPlus = await inbox.getMessages('+');
    assert.deepStrictEqual(msgsPlus, []);

    // 24h window test
    const isOpen = await inbox.isWindowOpen('+61499988877');
    assert.strictEqual(isOpen, true, 'Window should be open when recent inbound message exists');

    const isOpenEncoded = await inbox.isWindowOpen('%2B61499988877');
    assert.strictEqual(isOpenEncoded, true, 'Window check should work with URL-encoded phone');

    const isOpenEmpty = await inbox.isWindowOpen('');
    assert.strictEqual(isOpenEmpty, false, 'Window check should return false for empty phone');

    // High message volume & chronological ordering test
    const highVolPhone = '61488877766';
    for (let i = 1; i <= 520; i++) {
      const at = new Date(Date.now() - (530 - i) * 60000).toISOString();
      await inbox.record(highVolPhone, 'HighVol Customer', 'inbound', `Message #${i}`, `msg_${i}`);
    }
    const highVolMsgs = await inbox.getMessages(highVolPhone);
    assert.strictEqual(highVolMsgs.length, 500, 'Should cap returned messages to recent 500');
    assert.strictEqual(highVolMsgs[highVolMsgs.length - 1].body, 'Message #520', 'Last item in array MUST be newest message');
    const highVolWindow = await inbox.isWindowOpen(highVolPhone);
    assert.strictEqual(highVolWindow, true, 'Window must be open because Message #520 was sent recently');
  });

  // Test 4: Bokun booking retrieval across phone representations
  await asyncTest('R1: Bokun booking retrieval handles phone normalization', async () => {
    const bookingPayload = {
      bookingId: 'BK-TEST-001',
      customer: {
        firstName: 'Bob',
        lastName: 'Traveler',
        phoneNumber: '+61 411 222 333',
        email: 'bob@example.com'
      },
      activity: {
        title: 'Sunset Blue Mountains Tour',
        startDate: '2026-09-20',
        totalParticipants: 2
      },
      totalPrice: 280,
      currency: 'AUD',
      status: 'confirmed'
    };

    await bokun.recordBooking(bookingPayload);

    const b1 = await bokun.getBookingsForPhone('61411222333');
    assert(b1.length >= 1, 'Should find booking by plain digits');
    assert.strictEqual(b1[0].bookingId, 'BK-TEST-001');

    const b2 = await bokun.getBookingsForPhone('+61411222333');
    assert(b2.length >= 1, 'Should find booking by + prefix');

    const b3 = await bokun.getBookingsForPhone('%2B61411222333');
    assert(b3.length >= 1, 'Should find booking by %2B encoded string');

    const bEmpty = await bokun.getBookingsForPhone('');
    assert.deepStrictEqual(bEmpty, []);
  });

  // Test 5: Endpoints in express app handle parameters safely and return accurate status
  await asyncTest('R1 & R2: Express API routes handle :phone properly', async () => {
    const app = express();
    app.use(express.json());

    app.get('/inbox/api/conversations/:phone/messages', async (req, res) => {
      try {
        const phone = String(req.params.phone || '').replace(/^ /, '+').trim();
        res.json(await inbox.getMessages(phone));
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.get('/inbox/api/conversations/:phone/window', async (req, res) => {
      try {
        const phone = String(req.params.phone || '').replace(/^ /, '+').trim();
        res.json({ open: await inbox.isWindowOpen(phone) });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.get('/inbox/api/conversations/:phone/bokun-bookings', async (req, res) => {
      try {
        const phone = String(req.params.phone || '').replace(/^ /, '+').trim();
        res.json(await bokun.getBookingsForPhone(phone));
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.post('/inbox/api/conversations/:phone/mark-handled', async (req, res) => {
      try {
        const phone = String(req.params.phone || '').replace(/^ /, '+').trim();
        await inbox.removeHandoff(phone);
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.post('/inbox/api/conversations/:phone/reply', async (req, res) => {
      try {
        const phone = String(req.params.phone || '').replace(/^ /, '+').trim();
        const { body } = req.body || {};
        if (!body || !body.trim()) return res.status(400).json({ error: 'empty' });
        if (!(await inbox.isWindowOpen(phone))) {
          return res.status(409).json({ error: 'window_closed' });
        }
        res.json({ ok: true, phone });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // 1. Fetch messages with %2B encoded phone
    const resMsg = await invokeExpress(app, 'GET', '/inbox/api/conversations/%2B61499988877/messages');
    assert.strictEqual(resMsg.status, 200);
    assert(Array.isArray(resMsg.data));
    assert.strictEqual(resMsg.data.length, 2);

    // 2. Fetch window status
    const resWin = await invokeExpress(app, 'GET', '/inbox/api/conversations/%2B61499988877/window');
    assert.strictEqual(resWin.status, 200);
    assert.strictEqual(resWin.data.open, true);

    // 3. Fetch bokun bookings
    const resBokun = await invokeExpress(app, 'GET', '/inbox/api/conversations/%2B61411222333/bokun-bookings');
    assert.strictEqual(resBokun.status, 200);
    assert(Array.isArray(resBokun.data));
    assert(resBokun.data.length >= 1);

    // 4. Mark handled
    const resHandled = await invokeExpress(app, 'POST', '/inbox/api/conversations/%2B61499988877/mark-handled');
    assert.strictEqual(resHandled.status, 200);
    assert.strictEqual(resHandled.data.ok, true);

    // 5. Reply with valid body
    const resReply = await invokeExpress(app, 'POST', '/inbox/api/conversations/%2B61499988877/reply', { body: 'Looking forward to seeing you!' });
    assert.strictEqual(resReply.status, 200);
    assert.strictEqual(resReply.data.ok, true);

    // 6. Reply with empty body
    const resEmptyReply = await invokeExpress(app, 'POST', '/inbox/api/conversations/%2B61499988877/reply', { body: '' });
    assert.strictEqual(resEmptyReply.status, 400);
  });

  // Test 6: Frontend inbox.html static validation
  test('R2 & R3: inbox.html contains required URL encoding, Call UX and status badges', () => {
    const html = fs.readFileSync(path.join(__dirname, 'inbox.html'), 'utf8');

    // Check fetch calls using encodeURIComponent(cur)
    assert(html.includes('/inbox/api/conversations/\'+encodeURIComponent(cur)+\'/messages'), 'Messages fetch must use encodeURIComponent(cur)');
    assert(html.includes('/inbox/api/conversations/\'+encodeURIComponent(cur)+\'/window'), 'Window fetch must use encodeURIComponent(cur)');
    assert(html.includes('/inbox/api/conversations/\'+encodeURIComponent(cur)+\'/bokun-bookings'), 'Bokun bookings fetch must use encodeURIComponent(cur)');
    assert(html.includes('/inbox/api/conversations/\'+encodeURIComponent(cur)+\'/reply'), 'Reply fetch must use encodeURIComponent(cur)');
    assert(html.includes('/inbox/api/conversations/\'+encodeURIComponent(cur)+\'/mark-handled'), 'Mark handled fetch must use encodeURIComponent(cur)');

    // Check Call UX
    assert(html.includes('id="chCallBtn"'), 'Must have chat header call button #chCallBtn');
    assert(html.includes('id="ciCallBtn"'), 'Must have contact info call button #ciCallBtn');
    assert(html.includes("'tel:'"), 'Must trigger phone dialer via tel:');
    assert(html.includes('btn-active-feedback'), 'Must provide visual active feedback for call button');

    // Check 24h window badge
    assert(html.includes("● Open (24h)"), 'Must display ● Open (24h)');
    assert(html.includes("● Closed"), 'Must display ● Closed');
    assert(html.includes('id="chStatus"'), 'Must have status badge #chStatus');
    assert(html.includes('id="chHumanTag"'), 'Must have human tag #chHumanTag');

    // Check that chAvatar does not have duplicate onclick="toggleInfo()"
    assert(!html.includes('id="chAvatar" onclick="toggleInfo()"'), 'chAvatar must not have inline onclick that double-triggers toggleInfo');

    // Check deep link parameter support and normalization
    assert(html.includes("params.get('chat')"), 'Deep link must support ?chat= parameter');
    assert(html.includes("rawOpenPhone.replace(/^ /, '+').trim()"), 'Deep link must normalize leading space from URLSearchParams');

    // Check race condition protection & request sequencing
    assert(html.includes('currentChatRequestId'), 'Must track currentChatRequestId to prevent race conditions during rapid chat switching');
    assert(html.includes('reqId !== currentChatRequestId'), 'Must discard superseded async responses if user switches chats');

    // Check immediate message loading skeleton
    assert(html.includes("msgsBox.innerHTML = `"), 'Must immediately display skeleton in #msgs when opening chat');

    // Check robust 24h window calculation
    assert(html.includes("ms[i].dir === 'inbound'"), 'Must verify inbound messages in ms array for window calculation');
    assert(html.includes("windowOpen = true"), 'Must set windowOpen when recent inbound customer messages exist');
  });

  console.log(`\nAll ${passedTests} tests passed successfully!`);
}

runAllTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
