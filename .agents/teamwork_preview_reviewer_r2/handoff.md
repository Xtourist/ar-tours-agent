# Handoff Report: WhatsApp Customer Care Inbox Resolution (Review Round 2)

## 1. Executive Summary & Skepticism Disclaimer
> [!WARNING] **Skepticism Disclaimer**
> High confidence in PostgREST query building, high-volume message chronological sorting, race condition mitigation via monotonic request ID sequencing, and client/server 24-hour window status calculation; live Meta Graph API webhook callbacks and Render live network latency remain unverified in local testing.

---

## 2. Issues Discovered in Prior Attempt

### Issue 1: `getMessages(phone)` Returned the OLDEST 500 Messages Instead of the NEWEST Messages
- **Input**: Conversations with high message counts (>500 messages).
- **Expected**: Retrieve the 500 most recent messages in chronological order (oldest to newest), ensuring today's active conversation is shown.
- **Actual**: Supabase query executed `.order('at', { ascending: true }).limit(500)`, retrieving the 500 oldest messages from months ago and truncating the latest messages. Consequently, `isWindowOpen` evaluated only historical messages and falsely marked the 24h window as `● Closed`.
- **Root cause**: Ascending sort order coupled with a query limit selects from the beginning of history rather than the most recent records.

### Issue 2: Race Conditions and Stale Message Bleed on Rapid Chat Switching in `inbox.html`
- **Input**: User rapidly clicks between conversation rows (e.g. Chat 1 -> Chat 2 -> Chat 1).
- **Expected**: `#msgs` shows an immediate loading state for the selected conversation, and slower out-of-order network responses from superseded selections are discarded.
- **Actual**: `#msgs` retained the prior conversation's messages and composer lock state until the network returned. Slower responses from prior clicks could overwrite the active conversation in `#msgs`.
- **Root cause**: Lack of monotonic request sequencing (`currentChatRequestId`) and lack of immediate `#msgs` skeleton rendering on conversation switch.

### Issue 3: False 24h Window Closure (`● Closed`) on Server Error or Network Glitch
- **Input**: Server transient error (500) on `/inbox/api/conversations/:phone/window`.
- **Expected**: Window stays open or is accurately inferred if the message list (`ms`) already contains inbound messages from the customer within the last 24 hours.
- **Actual**: In `inbox.html`, `res.json()` on HTTP 500 returned `{ error: ... }`. `wr.open` evaluated to `undefined` (falsy), immediately setting `#chStatus` to `● Closed`, rendering the 24h warning banner, and disabling the message input and send buttons.
- **Root cause**: Client blindly checked `wr.open` without verifying `res.ok`, and failed to inspect the loaded message history (`ms`) which already contained recent customer inbound messages.

### Issue 4: Deep Link `?chat=+...` Decoded `+` to Space Character
- **Input**: Direct navigation to `/inbox?chat=+61400040043` or `?phone=+61400040043`.
- **Expected**: Deep link decodes cleanly as `+61400040043` and selects canonical conversation `c.phone`.
- **Actual**: `new URLSearchParams().get('chat')` standard decode converts raw `+` into a space character (`" 61400040043"`), resulting in malformed phone values in `cur` unless canonical conversation matching was enforced.
- **Root cause**: Missing leading space normalization (`replace(/^ /, '+').trim()`) and failure to prefer `c.phone` over raw query parameter string.

### Issue 5: `toPostgrestInList` Weakness Against Null, Undefined, and Empty Array Items
- **Input**: Array containing `null`, `undefined`, or whitespace elements passed to `toPostgrestInList`.
- **Expected**: Clean removal of empty/null values, leaving only valid quoted/unquoted strings.
- **Actual**: Returned `[null]` or `[""]`, which when serialized to PostgREST created `phone=in.("")` or `phone=in.(null)` triggering PostgREST `PGRST100` filter syntax errors.
- **Root cause**: Missing nullish and whitespace filtering before mapping values.

### Issue 6: Unformatted Recipient in `sendWhatsAppTemplate`
- **Input**: Sending a WhatsApp template with a phone containing `+` (e.g. `+61400040043`).
- **Expected**: Meta WhatsApp Cloud API accepts only numeric digits (`to: '61400040043'`).
- **Actual**: `sendWhatsAppTemplate` passed the raw `phoneNumber` string without stripping `+`.
- **Root cause**: Missing digit sanitization on recipient `to` in `sendWhatsAppTemplate`.

---

## 3. What I Changed

1. **`inbox.js`**:
   - Updated `toPostgrestInList` to strictly filter out `null`, `undefined`, and empty/whitespace values before string formatting.
   - Updated `getMessages` to query Supabase with `.order('at', { ascending: false }).limit(500)` and reverse the resulting slice to return the 500 newest messages in ascending chronological order.
   - Capped fallback in-memory message history to the most recent 500 items.
   - Hardened `isWindowOpen` against clock skew and bogus future timestamps (`diffH >= -1 && diffH <= 24`).

2. **`bokun.js`**:
   - Reused shared `toPostgrestInList` from `./inbox` for consistent PostgREST filter formatting across bookings.

3. **`whatsapp_agent.js`**:
   - Hardened `isInHandoff` so that when a handoff expires, all associated phone variants are deleted from `humanHandoff` and cleared from Supabase.
   - Stripped non-digits from `to` parameter in `sendWhatsAppTemplate` to comply with Meta Cloud API specifications.

4. **`inbox.html`**:
   - Implemented monotonic request tracking (`currentChatRequestId`) in `openChat`, `loadBokunCard`, and `loadMsgs` to eliminate race conditions on rapid chat switching.
   - Rendered an immediate message skeleton in `#msgs` on conversation selection and reset UI states (`#chStatus`, `#warn`, composer input state) immediately.
   - Implemented robust 24-hour window calculation that directly evaluates `ms` inbound messages within 24h, eliminating false `● Closed` states when recent messages exist.
   - Normalized deep link query parameters to convert leading spaces back to `+` and align with canonical `c.phone`.

5. **`test_inbox_resolution.js`**:
   - Added test assertions for `toPostgrestInList` edge cases (null, undefined, whitespace, plain numbers).
   - Added automated test for 500+ message volume, verifying chronological ordering and window evaluation.
   - Added assertions verifying `currentChatRequestId` request sequencing, message skeleton rendering, and deep link normalization in `inbox.html`.

---

## 4. Verification Record

- **Deep Verification (ran actual tests):**
  - Executed `npm test` (`node test_inbox_resolution.js`): All 6 automated test suites passed with exit code 0.
  - Executed `node --check inbox.js && node --check whatsapp_agent.js && node --check bokun.js && node --check test_inbox_resolution.js`: Exited with code 0.
  - Verified JavaScript parsing of extracted `<script>` from `inbox.html`: Exited with code 0.
  - Verified Supabase PostgREST query generation via `@supabase/supabase-js` without syntax errors or unquoted `+` characters.

- **Shallow Verification (manual inspection):**
  - Inspected DOM structures in `inbox.html` for `#msgs`, `#chStatus`, `#warn`, `#chCallBtn`, `#ciCallBtn`, and `btn-active-feedback`.
  - Verified dialer formatting `tel:+<phone>` and active feedback transitions.

- **Unverified Aspects:**
  - Live Meta WhatsApp webhook ingestion and outbound API token validity (requires external Meta production requests).
  - Production Supabase roundtrips under live Render container deployment (environment keys injected by hosting platform).

---

## 5. Known Issues

- `Minor Robustness Risk` — High-frequency background polling (every 8 seconds) will poll active chats continuously; if a user leaves a tab open overnight, it continues periodic polling without an idle backoff.

---

## 6. Remaining Risk & Next Step

All acceptance criteria are satisfied. Changes are committed in commit `09a951a` and pushed to `origin main`. The application is ready for production verification on Render.
