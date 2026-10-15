import { calculateDurations } from '@eam/shared';

export function summarizeActivity(db, userId, rangeStart, rangeEnd) {
  const start = new Date(rangeStart).toISOString();
  const end = new Date(rangeEnd).toISOString();
  if (Date.parse(end) <= Date.parse(start)) throw new RangeError('Report end must be after report start');
  const prior = db.prepare(`SELECT status, previous_status AS previousStatus, occurred_at AS occurredAt FROM activity_events
    WHERE user_id = ? AND occurred_at < ? ORDER BY occurred_at DESC, id DESC LIMIT 1`).get(userId, start);
  const events = db.prepare(`SELECT status, previous_status AS previousStatus, occurred_at AS occurredAt FROM activity_events
    WHERE user_id = ? AND occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at, id`).all(userId, start, end);
  const timeline = prior ? [prior, ...events] : events;
  const durations = calculateDurations(timeline, start, end);
  return {
    ...durations,
    awaySessions: events.filter((event) => event.status === 'away' && event.previousStatus !== 'away').length
  };
}

export function parseReportRange(query) {
  const end = query.to ? Date.parse(String(query.to)) : Date.now();
  const start = query.from ? Date.parse(String(query.from)) : end - 7 * 86400000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 366 * 86400000) {
    throw new RangeError('Report range must be valid and no longer than 366 days');
  }
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

export function createCsv(rows) {
  const quote = (value) => {
    let text = String(value ?? '');
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return rows.map((row) => row.map(quote).join(',')).join('\r\n');
}
