export const ACCOUNT_ROLES = Object.freeze({ ADMIN: 'admin', EMPLOYEE: 'employee' });
export const AVAILABILITY = Object.freeze({ UNKNOWN: 'unknown', AVAILABLE: 'available', AWAY: 'away', OFFLINE: 'offline' });
export const DEFAULT_IDLE_THRESHOLD_SECONDS = 60;
export const HEARTBEAT_STALE_THRESHOLD_MS = 45_000;
export const DEFAULT_CAMERA_POLICY = Object.freeze({ enabled: false, requireOfficeNetwork: true });

export function getAwayPopupAction(currentStatus, nextStatus) {
  if (nextStatus === AVAILABILITY.AWAY) return currentStatus === AVAILABILITY.AWAY ? 'keep' : 'show';
  return currentStatus === AVAILABILITY.AWAY ? 'close' : 'none';
}

export function calculateDurations(events, rangeStart, rangeEnd) {
  const start = new Date(rangeStart).getTime();
  const end = new Date(rangeEnd).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new RangeError('Invalid activity range');
  }
  const ordered = [...events].sort((left, right) => new Date(left.occurredAt) - new Date(right.occurredAt));
  let cursor = start;
  let status = AVAILABILITY.UNKNOWN;
  const totals = { availableMs: 0, awayMs: 0, awaySessions: 0 };
  for (const event of ordered) {
    const at = Math.max(start, Math.min(end, new Date(event.occurredAt).getTime()));
    if (!Number.isFinite(at)) continue;
    const duration = Math.max(0, at - cursor);
    if (status === AVAILABILITY.AVAILABLE) totals.availableMs += duration;
    if (status === AVAILABILITY.AWAY) totals.awayMs += duration;
    if (event.status === AVAILABILITY.AWAY && status !== AVAILABILITY.AWAY) totals.awaySessions += 1;
    status = event.status;
    cursor = at;
  }
  const tail = Math.max(0, end - cursor);
  if (status === AVAILABILITY.AVAILABLE) totals.availableMs += tail;
  if (status === AVAILABILITY.AWAY) totals.awayMs += tail;
  return totals;
}
