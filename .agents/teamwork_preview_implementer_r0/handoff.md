# Handoff Report: WhatsApp Customer Care Inbox Resolution

## 1. Summary of Changes Made

### R1. Conversation Messages Loading & Normalization
- **Phone Normalization (`inbox.js`, `bokun.js`, `whatsapp_agent.js`)**:
  - Implemented URL percent-decoding loops (`decodeURIComponent`) within `getPhoneVariants(phone)` and `bokun.js:getBookingsForPhone(phone)` to handle encoded values like `%2B61400040043` or `%252B61400040043` without corrupting digits.
  - Generates all valid standard representations: plain digits (`61400040043`), leading plus (`+61400040043`), Australian national local format (`0400040043` <-> `+61400040043`), and raw strings.
  - Sanitized incoming route parameters across all `/inbox/api/conversations/:phone/*` endpoints in `whatsapp_agent.js` to normalize leading spaces and raw plus signs.
- **PostgREST Query Filter Syntax Error Elimination (`inbox.js`, `bokun.js`)**:
  - Built `toPostgrestInList(variants)` helper that wraps any phone string containing special characters (such as `+`) in double quotes: `"+61400040043"`.
  - Applied `toPostgrestInList` to `.in('phone', postgrestPhones)` queries in `getMessages`, `listConversations`, `getBusinessNumber`, and `bokun.js:getBookingsForPhone`.
  - Eliminates PostgREST syntax error `PGRST100: failed to parse filter` caused by raw unquoted `+` signs in HTTP query strings.
  - Added robust try/catch blocks with 500 error responses across `/inbox/api/conversations/:phone/messages`, `/inbox/api/conversations/:phone/window`, and `/inbox/api/conversations/:phone/bokun-bookings`.

### R2. Frontend URL Encoding & Active Chat Synchronization (`inbox.html`)
- **Strict URL Encoding**:
  - Updated all fetch requests to consistently use `encodeURIComponent(cur)`:
    - `/inbox/api/conversations/${encodeURIComponent(cur)}/messages`
    - `/inbox/api/conversations/${encodeURIComponent(cur)}/window`
    - `/inbox/api/conversations/${encodeURIComponent(cur)}/bokun-bookings`
    - `/inbox/api/conversations/${encodeURIComponent(cur)}/reply`
    - `/inbox/api/conversations/${encodeURIComponent(cur)}/mark-handled`
- **Parallel Loading & Instant Rendering**:
  - Updated `openChat()` to trigger `Promise.all([loadBokunCard(), loadMsgs()])` concurrently rather than serially awaiting bookings first.
  - In `loadMsgs()`, fetched conversation messages and 24-hour window status in parallel with `Promise.all`.
  - Rendered message bubbles immediately with day separators (`.daysep`), inbound/outbound directions (`.bubble.in` / `.bubble.out`), timestamps (`.meta`), double ticks (`.ticks`), and media attachments (`.media-bubble`).
- **24-Hour Window Badge Synchronization**:
  - Added `#chHumanTag` to chat header actions alongside `#chStatus` and `#handledBtn`.
  - When recent customer messages exist, `#chStatus` accurately displays `'● Open (24h)'` (with class `.status-pill.pill-open`), instead of falsely displaying `'● Closed'`.
  - When human handoff is required, `#chHumanTag` displays `'🙋 Needs you'` and `#handledBtn` is displayed, while `#chStatus` maintains window open status.

### R3. Outbound Calling UX (`inbox.html`)
- **Native Dialer & Feedback**:
  - Chat header call button (`#chCallBtn`) and contact info call button (`#ciCallBtn`) invoke `tel:+<e164_phone>` dialer links.
  - Added visual user feedback via toast (`Calling +<phone>...`) and CSS click/touch feedback class (`.btn-active-feedback`) with scale/opacity animation.
  - Added `aria-label="Call Contact"` and `title="Call Contact"` to both buttons for accessibility.

---

## 2. Diff / Affected Files

### Affected Files:
1. `inbox.js`: Added URL decoding to `getPhoneVariants`, added `toPostgrestInList`, quoted phone variants in Supabase queries, exported helpers.
2. `whatsapp_agent.js`: Normalized `:phone` parameter and added try/catch error handling on messages, window, and bokun-bookings routes.
3. `bokun.js`: Normalized phone in `getBookingsForPhone` with URL decode and quoted PostgREST filter values.
4. `inbox.html`: Added URL encoding `encodeURIComponent(cur)` across all conversation endpoints, parallelized chat loading, separated `#chHumanTag` from `#chStatus` 24h window badge, and added outbound calling visual feedback.
5. `package.json`: Added `npm test` script.
6. `test_inbox_resolution.js`: Automated unit test suite verifying R1, R2, and R3.

### Git Commits:
- `d4fb9d0`: `fix(inbox): resolve phone variant PostgREST query parsing, 24h window calculation, and E164 dialer format`
- `4ebff48`: `test(inbox): add automated unit checks for inbox message resolution`
- Pushed to `origin main` at `https://github.com/Xtourist/ar-tours-agent.git`.

---

## 3. Verification Record

### Deep Verification (ran actual tests):
Executed automated test runner `npm test` (`node test_inbox_resolution.js`):
```
> ar-tours-whatsapp-agent@1.0.0 test
> node test_inbox_resolution.js

--- Running Inbox Resolution Test Suite ---

✓ R1: getPhoneVariants produces clean digits and standard formats
✓ R1: toPostgrestInList quotes values containing special characters to prevent PostgREST syntax errors
✓ R1: Message retrieval and window status across phone variants
✓ R1: Bokun booking retrieval handles phone normalization
✓ R1 & R2: Express API routes handle :phone properly
✓ R2 & R3: inbox.html contains required URL encoding, Call UX and status badges

All 6 tests passed successfully!
```

### Syntax Validation:
```bash
node --check inbox.js
node --check whatsapp_agent.js
node --check bokun.js
node -e "..." # inbox.html extracted script check
# Result: inbox.html script syntax check: PASSED (all exit code 0)
```

### Shallow Verification (manual inspection):
- Eyeballed `inbox.html` CSS and HTML tree for `.btn-active-feedback`, `#chCallBtn`, `#ciCallBtn`, `#chHumanTag`, `#chStatus`, and `#handledBtn`.
- Verified regex logic for Australian local/international phone numbers (`614...` <-> `04...`).

### Unverified Aspects:
- Live Meta WhatsApp webhook delivery from Facebook Cloud API servers (requires live inbound webhook payload).
- Live Supabase production network roundtrips (tested query generation and URL encoding against `@supabase/supabase-js` and in-memory fallback; production `SUPABASE_SECRET_KEY` is injected on Render).

---

## 4. Known Issues
- `Minor Robustness Risk` — If a phone number stored in legacy Postgres contains arbitrary alphanumeric characters other than digits and `+`, `toPostgrestInList` will quote it, but fuzzy regex matching in SQL is not implemented (exact variant matching is used).

---

## 5. Untested Edge Cases & Next Step
- **Reviewer next step**: Test opening conversation with deep link containing unusual encoding, e.g. `/inbox?chat=%2B61400040043` in browser and confirm dialer prompt on mobile device.
