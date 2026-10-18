# Handoff Report: WhatsApp Customer Care Inbox Resolution (Review Round 1)

## 1. Executive Summary & Skepticism Disclaimer
> [!WARNING] **Skepticism Disclaimer**
> High confidence in Supabase PostgREST query generation, phone normalization, in-process routing, dialer UX, and unit test reliability; production live Meta Cloud API delivery remains unverified without real Meta webhook traffic.

---

## 2. Issues Discovered in Prior Attempt

### Issue 1: `npm test` Failed in Sandboxed Environments (`AxiosError: connect EPERM`)
- **Input**: `npm test`
- **Expected**: Automated test suite executes cleanly and passes with exit code 0.
- **Actual**: Test 5 crashed with `AxiosError: connect EPERM 127.0.0.1:<port> - Local (0.0.0.0:0)` because it attempted to open live TCP socket connections on an ephemeral port, which is blocked by macOS sandbox permissions and proxied by environment proxy variables.
- **Root cause**: Test 5 used `server.listen(0)` with `axios.get` instead of an in-process request dispatcher (`invokeExpress`), causing immediate test failures for automated runners.

### Issue 2: Empty / Invalid Phone Passed to Supabase Queries Generated Illegal PostgREST Filter `phone=in.()` (`PGRST100`)
- **Input**: Calling `inbox.getMessages('')`, `inbox.getBusinessNumber('')`, `bokun.getBookingsForPhone('')`, or `listConversations()` with empty conversation lists.
- **Expected**: Safe return of empty arrays (`[]`) or `null` without sending malformed HTTP queries to Supabase.
- **Actual**: Supabase queries sent `phone=in.()`, which PostgREST rejects with `PGRST100: failed to parse filter (in.())` resulting in logged server errors and empty fallbacks.
- **Root cause**: Queries did not guard against empty variant lists before executing `.in('phone', postgrestPhones)`.

### Issue 3: `getPhoneVariants` Generated Invalid Phone Numbers (`['+']` and `'+04...'`)
- **Input**: `getPhoneVariants('+')`, `getPhoneVariants('   ')`, or `getPhoneVariants('0400040043')`.
- **Expected**: Whitespace or `'+'` returns `[]`; Australian local format `0400040043` returns `['0400040043', '61400040043', '+61400040043']` without generating non-existent ITU-T prefixes like `+0400040043`.
- **Actual**: `'+'` or whitespace returned `['+']`, which became `['"+"']` in PostgREST queries; Australian mobile numbers generated `'+0400040043'`.
- **Root cause**: `set.add('+' + digits)` was run unconditionally whenever `digits` existed even if `digits` started with `0`, and `raw` was added to `set` without checking for alphanumeric characters.

### Issue 4: Contact Info Drawer Immediately Closed Upon Click (Double-Trigger Bug)
- **Input**: Clicking `#chAvatar` or `.chat-head .info` in `inbox.html`.
- **Expected**: Contact info drawer opens (`.show-info` class added) allowing access to contact details and the Contact Info Call button (`#ciCallBtn`).
- **Actual**: Contact info drawer failed to open or flickered and remained closed.
- **Root cause**: Both HTML markup had inline `onclick="toggleInfo()"` AND JavaScript had `addEventListener('click', toggleInfo)`. Clicking the element triggered both handlers in the same event dispatch, immediately canceling the toggle.

### Issue 5: Dead Code in Route Normalization (`String(...).trim().replace(/^ /, '+')`)
- **Input**: Phone parameter with leading space from URL decoding (e.g. `' 61400040043'`).
- **Expected**: Leading space decoded from `+` is replaced by `+`.
- **Actual**: `.trim()` removed the leading space first, causing `.replace(/^ /, '+')` to never match.
- **Root cause**: Incorrect method ordering; needed `.replace(/^ /, '+').trim()`.

### Issue 6: Uncaught Exceptions & Broken Variant Deletion on `mark-handled` & `reply`
- **Input**: User clicks "Mark as handled" or sends a reply from the inbox for an active handoff.
- **Expected**: In-memory and Supabase handoffs are cleared for all phone variants; route errors return structured 500 JSON without unhandled rejections.
- **Actual**: `mark-handled` and `reply` lacked try/catch wrappers; `humanHandoff.delete(phone)` only checked the literal input string, failing to clear handoffs recorded under a variant (e.g. `614...` vs `+614...`).
- **Root cause**: Missing try/catch error handling and missing phone variant resolution in handoff tracking.

### Issue 7: Deep Link Parameter Rigidity in `inbox.html`
- **Input**: Deep link `/inbox?chat=%2B61400040043` or `?phone=%2B61400040043`.
- **Expected**: Chat opens automatically.
- **Actual**: Ignored because only `params.get('open')` was checked.
- **Root cause**: `inbox.html` only inspected the `open` query parameter.

---

## 3. What I Changed

1. **`inbox.js`**:
   - Refined `getPhoneVariants(phone)` to strictly avoid invalid `+04...` numbers and lone `+` or whitespace inputs (returns `[]`).
   - Added array length guards to `getMessages`, `getBusinessNumber`, and `listConversations` before executing Supabase `.in('phone', ...)` queries to eliminate `PGRST100: failed to parse filter (in.())`.
   - Updated `removeHandoff` to resolve all phone variants and delete from both in-memory fallback and Supabase.

2. **`bokun.js`**:
   - Added guards against `+0...` generation and empty phone variants before `.in('phone', postgrestPhones)` queries.

3. **`whatsapp_agent.js`**:
   - Corrected phone normalization order across routes to `replace(/^ /, '+').trim()`.
   - Updated `isInHandoff` to test all phone variants.
   - Wrapped `mark-handled` and `reply` in try/catch blocks with proper error logging and HTTP 500 responses.
   - Formatted recipient `to` in `sendWhatsAppMessage` to digits only (`.replace(/[^0-9]/g, '')`) conforming with Meta WhatsApp Cloud API specifications.

4. **`inbox.html`**:
   - Removed duplicate inline `onclick="toggleInfo()"` attributes from `#chAvatar` and `.info` so the Contact Info panel reliably opens to access the Contact Info Call button.
   - Supported `?chat=`, `?open=`, and `?phone=` deep link query parameters.

5. **`test_inbox_resolution.js`**:
   - Implemented an in-process Express route dispatcher (`invokeExpress`) that tests Express routing, parameter decoding, query execution, and status codes without binding local TCP sockets.
   - Added comprehensive assertions for empty inputs, Australian format conversions, and edge cases.

---

## 4. Verification Record

- **Deep Verification (ran actual tests):**
  - Executed `npm test` (`node test_inbox_resolution.js`): All 6 automated test suites passed with exit code 0 in both standard sandboxed and unsandboxed execution modes.
  - Executed node syntax check (`node --check inbox.js && node --check whatsapp_agent.js && node --check bokun.js && node --check test_inbox_resolution.js`): Exited with code 0.
  - Extracted and verified script syntax in `inbox.html`: Exited with code 0.
  - Verified Supabase query generation with `@supabase/supabase-js` ensuring proper quoting (`"%2B61400040043"`) and elimination of `in.()` empty filters.

- **Shallow Verification (manual inspection):**
  - Inspected HTML markup in `inbox.html` for `#chCallBtn`, `#ciCallBtn`, `.btn-active-feedback`, `#chStatus`, `#chHumanTag`, and `#handledBtn`.
  - Verified CSS classes `.status-pill.pill-open`, `.status-pill.pill-closed`, and `.tag.tag-human`.

- **Unverified Aspects:**
  - Live Meta WhatsApp webhook delivery from Meta Cloud API production servers (requires external webhook payload delivery).
  - Live Supabase production network roundtrips (tested with supabase-js query builder and in-memory fallback; live credentials are deployed on Render).

---

## 5. Known Issues

- `Minor Robustness Risk` — If an external caller passes a phone number with invalid letters (e.g. `foo123`), `getPhoneVariants` will preserve the raw string alongside digits. Fuzzy SQL regex matching is intentionally not used in favor of exact indexed lookups.

---

## 6. Remaining Risk & Next Step

The resolution is complete. All 6 acceptance criteria are verified, committed in `988d34a`, and pushed to `origin main`. The next step is deployment observation on Render.
