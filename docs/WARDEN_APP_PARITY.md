# Warden App — Dashboard Parity

Compared against `warden-dashboard/` at commit `ed09dc7`. "Implemented" means
code exists and `flutter analyze`/`flutter test` pass; it does **not** mean the
flow was exercised on a phone (see `docs/WARDEN_APP_TESTS.md`).

| Dashboard capability | Native app | Status |
|---|---|---|
| Warden login, role `WARDEN` | `POST /auth/login`; 429 shows Retry-After minutes; 401 clears session | Implemented |
| Session persistence | JWT + user in Android Keystore | Implemented (native delta) |
| Active / Resolved / All filters | Segmented filters; Active = not resolved | Implemented |
| Pending / Responding / Resolved-today counters | Same definitions; resolved-today uses the local day | Implemented |
| New-PENDING banner on non-active filters | Red banner with Show; alarm still fires | Implemented |
| Alert list row: type, student, room, time, GPS, status | `AlertCard` | Implemented |
| Alert detail: student, room, medical notes | Detail screen | Implemented |
| Map pin + accuracy | `flutter_map` + OSM, graceful fallback | Implemented (tiles unverified offline) |
| Emergency contact tap-to-call | `tel:` via `url_launcher` | Implemented |
| Acknowledge (PENDING only) | Server-confirmed `PATCH`; 409 surfaced | Implemented |
| Resolve (ACKNOWLEDGED only) | Dialog, trimmed 3–500, server-confirmed | Implemented |
| "SMS sent" pill | Renders only from `escalatedAt`; failure toast from `alert:escalation_failed` | Implemented |
| Live socket updates | One WebSocket-only socket; alert + leave events | Implemented |
| Connection indicator | Live / Connecting / Offline | Implemented |
| Reconnect behaviour | Refetch board + leaves (web does not) | Implemented (native delta) |
| History table + filters + paging | Status/from/to/student, 25/page | Implemented |
| History CSV export | Share sheet | Implemented (native delta) |
| Leave stats cards | 4 cards from `/leaves/stats` | Implemented |
| Leave tabs (pending/approved/away/overdue/history) | Implemented | Implemented |
| Leave review approve/reject + gate code | Implemented, 409 surfaced | Implemented |
| Gate departure with code / gate return | Implemented | Implemented |
| New leave-request banner | Implemented | Implemented |
| Push alerts (FCM) | Channel, token register/unregister, foreground/background tap | Implemented; delivery **unverified** (no device) |
| Full-screen alarm + repeating cue | `AlarmScreen`, fetch-before-ring, acknowledge/dismiss | Implemented; device behaviour unverified |
| Permission / battery health | Settings section + board banner | Implemented; device behaviour unverified |
| On-duty keep-alive | Native foreground service (`dataSync`) | Implemented; device behaviour unverified |
| Screen privacy | Optional `FLAG_SECURE` | Implemented; device behaviour unverified |

Deliberate deviations (documented in-app and in the design doc): strict
server-confirmed mutations, reconnect refetch, local-day history filters, secure
token storage, share-sheet CSV, forced login on 401/UNAUTHORIZED, no optimistic
resolve.

Not in parity, by decision: per-block alert scoping (server broadcasts to the
`wardens` room), editable student records, analytics. Those are server/product
changes outside this client.
