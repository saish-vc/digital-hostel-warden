const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

export interface AlertStudent {
  id: string;
  name: string;
  roomNumber: string;
  emergencyContact: string;
  medicalConditions: string | null;
}

export interface Alert {
  id: string;
  studentId: string;
  type: string;
  status: 'PENDING' | 'ACKNOWLEDGED' | 'RESOLVED' | string;
  latitude: number | null;
  longitude: number | null;
  locationAccuracy: number | null;
  createdAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  student: AlertStudent;
  /**
   * Socket-only state, never sent by the API: set from `alert:escalated` /
   * `alert:escalation-failed`. There is no schema column for these, so a page
   * reload loses them and the pill reports "unconfirmed" rather than claiming
   * a delivery it cannot verify.
   */
  escalatedAt?: string | null;
  escalationFailedAt?: string | null;
}

export interface AlertHistoryRow {
  id: string;
  type: string;
  status: string;
  createdAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  acknowledgedByName: string | null;
  student: { id: string; name: string; roomNumber: string };
}

export interface HistoryPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface HistoryResponse {
  data: AlertHistoryRow[];
  pagination: HistoryPagination;
}

export interface HistoryQuery {
  page: number;
  limit: number;
  /** Empty/absent = every status. */
  statuses?: string[];
  from?: string;
  to?: string;
  studentName?: string;
}

const TOKEN_KEY = 'token';
const USER_KEY = 'user';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser(): { id: string; name: string; role: string } | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { id: string; name: string; role: string };
  } catch {
    return null;
  }
}

export function setSession(token: string, user: unknown): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();

  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Response was not JSON; keep the status-based message.
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

export { API_URL };

/** GET /alerts with optional server-side status bucket + row cap. */
export function fetchAlerts(
  options: { statuses?: string[]; limit?: number } = {},
): Promise<Alert[]> {
  const params = new URLSearchParams();
  if (options.statuses && options.statuses.length > 0) {
    params.set('status', options.statuses.join(','));
  }
  if (options.limit) {
    params.set('limit', String(options.limit));
  }
  const query = params.toString();
  return api<Alert[]>(`/alerts${query ? `?${query}` : ''}`);
}

function historySearchParams(query: HistoryQuery): URLSearchParams {
  const params = new URLSearchParams();
  params.set('page', String(query.page));
  params.set('limit', String(query.limit));
  if (query.statuses && query.statuses.length > 0) {
    params.set('status', query.statuses.join(','));
  }
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  if (query.studentName) params.set('studentName', query.studentName);
  return params;
}

/** Paginated audit trail (GET /alerts/history). */
export function fetchHistory(query: HistoryQuery): Promise<HistoryResponse> {
  return api<HistoryResponse>(`/alerts/history?${historySearchParams(query).toString()}`);
}

/**
 * CSV export. A plain <a href> cannot carry the Bearer token, so the file is
 * fetched with the auth header and handed to the browser as a blob.
 */
export async function downloadHistoryCsv(query: HistoryQuery): Promise<void> {
  const token = getToken();
  const response = await fetch(
    `${API_URL}/alerts/history.csv?${historySearchParams(query).toString()}`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  );

  if (!response.ok) {
    throw new Error(`CSV export failed (${response.status})`);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = `alert-history-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

/** Register (or refresh) this browser's FCM push token. Warden-only. */
export function registerFcmToken(token: string, userAgent?: string): Promise<{ ok: boolean; id: number }> {
  return api<{ ok: boolean; id: number }>('/wardens/fcm-token', {
    method: 'POST',
    body: JSON.stringify({ token, userAgent }),
  });
}

/** Delete this browser's FCM push token (called on logout). */
export function deleteFcmToken(token: string): Promise<{ ok: boolean; deleted: number }> {
  return api<{ ok: boolean; deleted: number }>('/wardens/fcm-token', {
    method: 'DELETE',
    body: JSON.stringify({ token }),
  });
}

// ---------------------------------------------------------------------------
// Leave management (P0.3)
// ---------------------------------------------------------------------------

export interface LeaveStudent {
  id: string;
  name: string;
  email: string;
  roomNumber: string;
  emergencyContact: string;
  medicalConditions: string | null;
}

export interface LeaveReviewer {
  id: string;
  name: string;
  email: string;
  hostelBlock: string;
}

export interface LeaveRequest {
  id: string;
  studentId: string;
  type: string;
  reason: string;
  destination: string;
  emergencyContact: string;
  departureTime: string;
  expectedReturn: string;
  actualDeparture: string | null;
  actualReturn: string | null;
  status: 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'DEPARTED' | 'RETURNED' | 'OVERDUE' | 'CANCELLED' | string;
  parentConsent: boolean;
  gatePassCode: string | null;
  gatePassQr: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewRemarks: string | null;
  createdAt: string;
  student: LeaveStudent;
  reviewer?: LeaveReviewer | null;
}

export interface LeaveStats {
  pendingApprovals: number;
  currentlyAway: number;
  approvedPasses: number;
  overdueCount: number;
}

export interface LeaveListResponse {
  data: LeaveRequest[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export function fetchLeaveStats(): Promise<LeaveStats> {
  return api<LeaveStats>('/leaves/stats');
}

export function fetchLeaves(
  params: { page?: number; limit?: number; status?: string; type?: string; studentName?: string } = {},
): Promise<LeaveListResponse> {
  const query = new URLSearchParams();
  query.set('page', String(params.page ?? 1));
  query.set('limit', String(params.limit ?? 100));
  if (params.status) query.set('status', params.status);
  if (params.type) query.set('type', params.type);
  if (params.studentName) query.set('studentName', params.studentName);
  return api<LeaveListResponse>(`/leaves?${query.toString()}`);
}

export function fetchActiveLeaves(): Promise<LeaveRequest[]> {
  return api<LeaveRequest[]>('/leaves/active');
}

export function fetchOverdueLeaves(): Promise<LeaveRequest[]> {
  return api<LeaveRequest[]>('/leaves/overdue');
}

export function reviewLeave(
  leaveId: string,
  status: 'APPROVED' | 'REJECTED',
  reviewRemarks?: string,
): Promise<LeaveRequest> {
  return api<LeaveRequest>(`/leaves/${leaveId}/review`, {
    method: 'PATCH',
    body: JSON.stringify({ status, reviewRemarks }),
  });
}

export function recordGateDeparture(
  leaveId: string,
  gatePassCode?: string,
): Promise<LeaveRequest> {
  return api<LeaveRequest>(`/leaves/${leaveId}/gate-departure`, {
    method: 'POST',
    body: JSON.stringify({ gatePassCode }),
  });
}

export function recordGateReturn(leaveId: string): Promise<LeaveRequest> {
  return api<LeaveRequest>(`/leaves/${leaveId}/gate-return`, {
    method: 'POST',
  });
}
