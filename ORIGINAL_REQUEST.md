# Original User Request

## 2026-09-13T04:55:18Z

# Teamwork Project Prompt

This is a single self-contained fix; keep it small and focused. Complete the resolution for the AR Tours WhatsApp customer care inbox where chat previews appear in the left sidebar, but selecting a conversation does not load or render the messages in the central chat view (#msgs) and displays 'Say hi to start the conversation!'.

Working directory: /Users/grr/Documents/antigravity/watabot
Integrity mode: development

## Requirements

### R1. Conversation Messages Loading & Normalization
Fix the query in `/inbox/api/conversations/:phone/messages` and `inbox.js:getMessages(phone)` so that messages are retrieved accurately from Supabase regardless of whether the phone parameter has a leading `+`, no `+`, spaces, or URL encoding quirks. Eliminate Supabase PostgREST filter syntax errors caused by raw plus signs in query strings.

### R2. Frontend URL Encoding & Active Chat Synchronization
Update `inbox.html` so that all fetch requests for conversation messages, window status, and bookings use `encodeURIComponent(cur)`. Ensure that when a conversation is clicked, its message bubbles render immediately with timestamps, sender tags, media, and correct 24-hour window status.

### R3. Outbound Calling UX
Ensure the Call button in the chat header and contact info panel triggers the phone's native dialer via `tel:+<phone>` and provides clear visual feedback.

## Acceptance Criteria

### Message Display Verification
- [ ] Clicking any conversation row in `inbox.html` fetches `/inbox/api/conversations/:phone/messages` successfully without PostgREST syntax errors.
- [ ] Central message container (`#msgs`) displays all past inbound and outbound message bubbles instead of the empty placeholder when messages exist.
- [ ] 24h window badge displays '● Open (24h)' when recent customer messages exist, instead of falsely marking the window as '● Closed'.
- [ ] Both automated unit checks and syntax validation pass with exit code 0.
- [ ] Changes are committed and pushed to git `origin main`.
