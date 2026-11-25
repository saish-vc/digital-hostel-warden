# Leave Approval — Implementation Reference

Status: **implemented on `feature/leave-approval`** (backend, warden dashboard,
Flutter student app). This document is the contract for the feature, the
mapping to the terms used by the original leave-approval specification, and
the commands to verify it.

The feature was **extended**, not rebuilt: the `LeaveRequest` model, the
`leave-overdue` worker and the gate-pass flow already shipped in Sprint 1.
This work added validation, list filters, verb-style routes, automated tests,
realtime dashboard updates and live status in the student app.

---

## 1. Endpoint map

The router is mounted twice — `app.use('/leaves', leaveRoutes)` and
`app.use('/leave', leaveRoutes)` — so both spellings hit the same handlers.

| Purpose | Route | Role |
| --- | --- | --- |
| Create a request | `POST /leaves` (alias `POST /leave`) | STUDENT |
| List my requests | `GET /leaves/my` | STUDENT |
| Get my gate pass | `GET /leaves/:id/pass` | STUDENT (owner, APPROVED/DEPARTED) |
| Cancel while pending | `DELETE /leaves/:id` or `PATCH /leaves/:id/cancel` | STUDENT (owner) |
| Off-campus SOS | `POST /leaves/:id/emergency` | STUDENT (owner) |
| List all requests (filters) | `GET /leaves?status=&type=&studentName=&from=&to=&page=&limit=` | WARDEN |
| Statistics | `GET /leaves/stats` | WARDEN |
| Currently away | `GET /leaves/active` | WARDEN |
| Overdue | `GET /leaves/overdue` | WARDEN |
| Detail | `GET /leaves/:id` | STUDENT (owner) / WARDEN |
| Decide | `PATCH /leaves/:id/review` `{status, decisionNote?}` | WARDEN |
| Approve | `PATCH /leaves/:id/approve` `{decisionNote?}` | WARDEN |
| Reject | `PATCH /leaves/:id/reject` `{decisionNote?}` | WARDEN |
| Record gate exit | `POST /leaves/:id/gate-departure` `{gatePassCode?}` | WARDEN |
| Record gate return | `POST /leaves/:id/gate-return` | WARDEN |

### Specification terms → implementation

| Spec term | Here | Why |
| --- | --- | --- |
| `POST /leave`, `GET /leave/my` … | Same handlers under `/leave` and `/leaves` | Singular alias added; no duplicate logic |
| status `PENDING` | `SUBMITTED` | Existing DB rows, Flutter model and dashboard labels use `SUBMITTED`; the UI renders it as "Pending approval" |
| `fromDate` / `toDate` | `departureTime` / `expectedReturn` | Existing schema; validated as a strict pair |
| `decisionNote` | `reviewRemarks` | Both accepted on `review`/`approve`/`reject`; stored in `reviewRemarks` |
| `PATCH …/approve`, `/reject` | Added as thin aliases over `applyReview` | Same code path as `PATCH …/review` |
| `PATCH …/cancel` | Added; `DELETE …/:id` kept | Flutter app already shipped DELETE |

No Prisma migration is required: every field this feature uses already exists
in `LeaveRequest` (the last migration is
`20261118072343_add_multitenancy_and_leaves`).

---

## 2. Status machine

```
SUBMITTED ──approve──▶ APPROVED ──gate-departure──▶ DEPARTED ──gate-return──▶ RETURNED
    │                     │                            │
    ├──reject──▶ REJECTED │                            └──(worker)──▶ OVERDUE ──gate-return──▶ RETURNED
    └──cancel──▶ CANCELLED

APPROVED and REJECTED are terminal for review: any further decision returns 409.
```

- A gate pass code (`HG-XXXXXX`) and signed QR payload are generated only on
  approval.
- The overdue worker (`leave-overdue.worker.ts`) flips `DEPARTED` rows past
  `expectedReturn` to `OVERDUE` every 5 minutes. Unchanged by this work.

---

## 3. Validation

On `POST /leaves`:

| Rule | Response |
| --- | --- |
| `type` ∈ `DAY_OUTING`, `NIGHT_OUT`, `HOME_VISIT`, `MEDICAL` | 400 |
| `reason` 3–500 characters after trim | 400 |
| `destination` 2–200 characters after trim | 400 |
| Dates parse as ISO; `expectedReturn > departureTime` | 400 |
| `departureTime` not in the past (60 s clock-skew tolerance) | 400 |
| Owner always comes from the JWT, never the body | — |

On decisions/transitions:

- Only `SUBMITTED` can be approved/rejected/cancelled (409 otherwise).
- Only the owning student can cancel (403 otherwise).
- Only a `WARDEN` can review; only a `STUDENT` can create/cancel.
- Gate departure requires `APPROVED`; gate return requires `DEPARTED` or
  `OVERDUE`; a supplied gate-pass code must match.

`GET /leaves` accepts `status`, `type`, `studentName`, and a departure window
`from`/`to` (ISO dates, inclusive). An unparseable date returns 400.

---

## 4. Realtime contract

All events are emitted to the `wardens` room; student events go to
`student:<studentId>` (the socket joins this room from the JWT).

| Event | Target | Payload |
| --- | --- | --- |
| `leave:created` | wardens | full leave row |
| `leave:updated` | wardens + owning student | full row (approval/rejection, with `gatePassCode`) |
| `leave:cancelled` | wardens (`{id, studentId}`) + owning student (full row) | see left |
| `leave:departed` | wardens + owning student | full row |
| `leave:returned` | wardens + owning student | full row |

Socket behaviour is fire-and-forget: a socket failure is logged and never
fails the HTTP request. Existing `alert:*` events are untouched.

---

## 5. Clients

**Warden dashboard** (`src/pages/Leaves.tsx`, `src/hooks/useLeaveSocket.ts`)

- Listens to all `leave:*` events and refreshes the board (no polling).
- A submission that arrives while the warden is on another tab raises an
  amber "N new leave request(s)" banner that jumps to *Pending approvals* —
  the same pattern as the SOS pending banner, so a request can never be
  silently filtered away.
- Tabs: Pending approvals, Approved passes, Currently away, Overdue, and
  *History & filters* (`ALL` / `REJECTED` / `CANCELLED` / `RETURNED`).
- Pending rows open a decision modal with the request details, an optional
  decision note (≤ 500 chars) and Approve / Reject buttons.

**Flutter student app** (`lib/screens/leave_status_screen.dart`,
`lib/services/socket.dart`, `lib/screens/leave_apply_screen.dart`)

- The status screen holds a socket subscription (`leave:updated`,
  `leave:departed`, `leave:returned`, `leave:cancelled`) and silently reloads
  so a decision appears without pulling to refresh.
- Cancel is offered only while `SUBMITTED` (`LeaveRequest.canCancel`).
- The date picker starts at today and the form refuses a past departure
  before submitting.

---

## 6. How to test

### Automated

```bash
cd backend
npm run test:db:up          # Postgres 16 + Redis 7 on 5432/6379 (test DB)
npm test                    # includes tests/leaves.test.ts (27 cases)
npm run test:db:down        # optional: delete the throwaway volumes
```

`tests/leaves.test.ts` covers: creation + required fields, unknown type, past
departure, inverted dates, reason length, ownership on cancel, double
decisions (409), role isolation (student→warden routes, warden→student
routes, 401/403), list filters, and realtime fan-out/isolation.

### Manual flow (seeded environment)

Seeded accounts (see `prisma/seed.ts`): `aarav@hostel.local` /
`password123` (STUDENT), `warden@hostel.local` / `password123` (WARDEN).

```bash
API=http://localhost:3001

STUDENT_TOKEN=$(curl -s -X POST $API/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"aarav@hostel.local","password":"password123","role":"STUDENT"}' \
  | jq -r .token)

# Future window, otherwise the API rejects it
DEP=$(date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%SZ)
RET=$(date -u -d '+6 hours' +%Y-%m-%dT%H:%M:%SZ)

curl -s -X POST $API/leaves \
  -H "Authorization: Bearer $STUDENT_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"type\":\"DAY_OUTING\",\"reason\":\"Family function\",\"destination\":\"Pune\",\"departureTime\":\"$DEP\",\"expectedReturn\":\"$RET\"}"

WARDEN_TOKEN=$(curl -s -X POST $API/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"warden@hostel.local","password":"password123","role":"WARDEN"}' \
  | jq -r .token)

curl -s -X PATCH $API/leaves/<leaveId>/approve \
  -H "Authorization: Bearer $WARDEN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"decisionNote":"Approved by block warden"}'

curl -s $API/leaves/my -H "Authorization: Bearer $STUDENT_TOKEN"
```

In the browser (dashboard at `:5173`): log in as the warden, open *Leave
Requests & Outings*, submit the request from the curl above (or a second
student tab) and watch it appear without a refresh, open *Review*, approve,
then confirm the row moves to *Approved passes* and appears under *History &
filters → All*.

---

## 7. Deliberately out of scope

- SMS/Twilio for leave decisions (parent-notification task P0.4 remains
  deferred).
- Tenant-scoped leave lists: no existing route in the repo scopes by
  `organizationId`, and this feature follows the established pattern rather
  than introducing scoping for one module.
