# Handoff Report: WhatsApp Customer Care Inbox Resolution (Review Round 3)

## 1. Executive Summary & Skepticism Disclaimer
> [!WARNING] **Skepticism Disclaimer**
> High confidence in PostgREST in-list sanitization, sender tag rendering, scroll position preservation, tab visibility/idle backoff polling, and unified phone normalization; external live Meta Cloud API webhook receipt and live Render production environment network latency remain unverified in local testing.

---

## 2. Issues Discovered in Prior Attempt

### Issue 1: `toPostgrestInList` Leaked Empty Strings on Quote-Only Array Items, Triggering Consecutive Commas `,,` in Supabase Queries
- **Input**: Array containing quote-only or whitespace strings, e.g. `['""', '"   "', '"', '"""', '+61400040043', 61400040043]`.
- **Expected**: Clean array with only valid, non-empty values `['"+61400040043"', '61400040043']`.
- **Actual**: Returned `['"+61400040043"', '', '61400040043']`. When passed to `@supabase/supabase-js`, generated query `phone=in.(%22%2B61400040043%22,,61400040043)`.
- **Root cause**: The prior attempt filtered values using `.filter(v => v !== null && v !== undefined && String(v).trim().length > 0)` *before* stripping quotes. Inside `.map()`, `String('""').replace(/"/g, '').trim()` became empty string `""` and passed through unquoted, creating consecutive commas `,,` in PostgREST queries and triggering `PGRST100` syntax errors.

### Issue 2: Background Polling Forcibly Reset Scroll Position to Bottom Every 8 Seconds While Reading History
- **Input**: User views a long conversation and scrolls up to read earlier message history.
- **Expected**: Periodic background poll refreshes message list without interrupting the user's scroll position.
- **Actual**: `loadMsgs` executed `box.scrollTop = box.scrollHeight;` on every single 8-second poll, repeatedly yanking the user's view to the bottom of the conversation.
- **Root cause**: Unconditional auto-scroll in `loadMsgs` rather than checking `wasNearBottom` or `forceScrollBottom` flag.

### Issue 3: Missing Sender Tags in Message Bubbles in `#msgs`
- **Input**: Inbound or outbound messages loaded into `#msgs`.
- **Expected**: Message bubbles explicitly render sender tags (`You` vs customer name) and `data-sender` attributes as mandated by requirement R2.
- **Actual**: Message bubbles contained only body text and timestamps; sender tags were completely missing in `#msgs` bubbles (only present in sidebar preview).
- **Root cause**: `loadMsgs` failed to create `.sender-tag` elements inside message bubble DOM structures.

### Issue 4: Continuous 8-Second Polling When Browser Tab Was Backgrounded / Idle Overnight
- **Input**: User minimizes tab or leaves computer unattended overnight.
- **Expected**: Polling pauses or backs off to avoid quota exhaustion, excessive database connection load, and throttling on Render/Supabase.
- **Actual**: `setInterval` fired unconditionally every 8 seconds indefinitely.
- **Root cause**: Lack of `document.hidden` check, lack of `visibilitychange` listener, and lack of idle timer backoff.

### Issue 5: Incomplete Chat State Reset on Back Navigation
- **Input**: User opens a conversation and clicks the back button (`#backBtn`).
- **Expected**: Chat panel, composer, quick action buttons, Bokun card, and warning banner reset to clean initial placeholder states.
- **Actual**: `#backBtn` only removed CSS classes without hiding `#chatHead`, `#composer`, `#quick`, or resetting `#msgs` to the default placeholder.
- **Root cause**: Missing comprehensive `closeChat()` routine.

### Issue 6: Duplicated and Inconsistent Phone Variant Extraction in `bokun.js`
- **Input**: Booking queries with international prefix `00` or double URL encoding `%252B`.
- **Expected**: Unified normalization logic between `inbox.js` and `bokun.js`.
- **Actual**: `bokun.js` maintained its own divergent copy of phone normalization instead of reusing `getPhoneVariants` from `inbox.js`.
- **Root cause**: Code duplication between modules.

---

## 3. What I Changed

1. **`inbox.js`**:
   - Refactored `toPostgrestInList` to strip quotes and trim before checking string length, completely eliminating empty string leaks and consecutive commas `,,`.
   - Updated `getPhoneVariants` to handle international exit prefix `00` (e.g. `0061...`), discard pure non-digit strings (`foo` -> `[]`), and cleanly extract digits from alphanumeric strings.
   - Added `postgrestPhones.length` defensive guards in `listConversations`, `getBusinessNumber`, and `removeHandoff` before calling Supabase `.in(...)` or `.delete().in(...)`.
   - Hardened `isWindowOpen` to skip `NaN` timestamp records with `continue`.

2. **`bokun.js`**:
   - Imported and reused `getPhoneVariants` from `./inbox`, removing duplicated normalization code and unifying phone parsing across messages and bookings.

3. **`inbox.html`**:
   - Added `.sender-tag` CSS styling and rendered sender tags (`You` vs customer name) and `data-sender` attributes inside all message bubbles (both text and media).
   - Added scroll preservation in `loadMsgs`: only auto-scrolls to bottom on initial chat open, user send, or if user was already near the bottom (`wasNearBottom < 80px`). Preserves `prevScrollTop` when reading history.
   - Replaced naive `setInterval` with tab-visibility-aware, idle-backed-off polling (`resetPollTimer`, `doPoll`, `markActivity`, `visibilitychange`), pausing while tab is hidden and backing off to 20s/60s on idle.
   - Implemented `closeChat()` on back button click to reset `#chatHead`, `#composer`, `#quick`, `#bokunCard`, `#warn`, and restore `#msgs` placeholder.
   - Updated `formatE164` to handle `00` international prefix.
   - Added dynamic `title` and `aria-label` updates on Call buttons (`Call +61...`).
   - Added user feedback toast when clicking quick action buttons while 24h window is closed.

4. **`test_inbox_resolution.js`**:
   - Added test assertions for quote-only input stripping in `toPostgrestInList`, verifying no consecutive commas `,,` in query strings.
   - Added test assertions for international `00` prefix, non-digit strings, and alphanumeric variants in `getPhoneVariants`.
   - Added test assertions for `bokun.getBookingsForPhone` with `00` prefix and non-digit handling.
   - Added assertions verifying `.sender-tag`, `data-sender`, scroll preservation, tab visibility/idle backoff, and `closeChat` in `inbox.html`.

---

## 4. Verification Record

- **Deep Verification (ran actual tests):**
  - `npm test`: All 6 automated test suites passed with exit code 0.
  - `node --check inbox.js && node --check bokun.js && node --check whatsapp_agent.js && node --check test_inbox_resolution.js`: All passed with exit code 0.
  - Evaluated `<script>` extract from `inbox.html` via `new Function(...)`: Passed with exit code 0.
  - Verified Supabase query generation with `@supabase/supabase-js`: Confirmed no unquoted plus signs and no consecutive commas `,,`.

- **Shallow Verification (manual inspection):**
  - Inspected DOM structures in `inbox.html` for `#msgs`, `#chStatus`, `#warn`, `#chCallBtn`, `#ciCallBtn`, `.sender-tag`, and `data-sender`.
  - Verified `formatE164('0061400040043')` returns `+61400040043`.
  - Verified dialer formatting `tel:+<phone>` and active feedback transitions.

- **Unverified Aspects:**
  - Live Meta WhatsApp webhook delivery from Facebook Cloud API servers (requires live inbound webhook payload).
  - Production Supabase roundtrips under live Render container deployment (production keys injected on Render).

---

## 5. Known Issues

- `Minor Robustness Risk` — While background polling now pauses when the tab is hidden and backs off to 60s when idle, offline network detection (`navigator.onLine`) is handled gracefully via fetch catch blocks without an offline status banner.

---

## 6. Remaining Risk & Next Step

All requirements (R1, R2, R3) and acceptance criteria are completely satisfied. Changes have been committed in commit `1db3c10` and pushed to git `origin main`. The inbox resolution is ready for deployment verification on Render.
