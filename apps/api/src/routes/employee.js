import { Router } from 'express';
import { z } from 'zod';
import { createCsv, parseDashboardDayStart, parseReportRange, summarizeActivity } from '../services/activity-summary.js';

const now = () => new Date().toISOString();
const requireEmployee = (req, res, next) => req.auth?.role === 'employee' ? next() : res.status(req.auth ? 403 : 401).json({ error: req.auth ? 'Employee access required' : 'Authentication required' });

export function createEmployeeRouter({ db }) {
  const router = Router();
  router.use(requireEmployee);

  router.post('/attendance/start', (req, res) => {
    const parsed = z.object({ clientSessionId: z.string().uuid() }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'A valid browser session ID is required' });
    const existing = db.prepare('SELECT started_at AS startedAt FROM web_attendance_sessions WHERE auth_session_id = ? AND client_session_id = ?')
      .get(req.auth.sessionId, parsed.data.clientSessionId);
    if (existing) return res.json({ startedAt: existing.startedAt, created: false });
    const startedAt = now();
    db.prepare('INSERT INTO web_attendance_sessions (auth_session_id, client_session_id, started_at) VALUES (?, ?, ?)')
      .run(req.auth.sessionId, parsed.data.clientSessionId, startedAt);
    res.status(201).json({ startedAt, created: true });
  });

  router.get('/dashboard', (req, res) => {
    const rangeEnd = new Date();
    let dayStart;
    try { dayStart = parseDashboardDayStart(req.query.dayStart, rangeEnd); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    const latest = db.prepare('SELECT status, occurred_at AS occurredAt, reason FROM activity_events WHERE auth_session_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 1').get(req.auth.sessionId);
    const events = db.prepare(`SELECT status, occurred_at AS occurredAt FROM activity_events WHERE user_id = ?
      AND occurred_at >= ? ORDER BY occurred_at, id`).all(req.auth.userId, dayStart);
    const applicationSwitches = db.prepare(`SELECT previous_application AS previousApplication, previous_window_title AS previousWindowTitle,
      application, window_title AS windowTitle, occurred_at AS occurredAt FROM application_switch_events
      WHERE user_id = ? AND occurred_at >= ? ORDER BY occurred_at DESC, id DESC LIMIT 200`)
      .all(req.auth.userId, dayStart);
    const sessionStarted = db.prepare('SELECT started_at AS startedAt, last_heartbeat_at AS lastHeartbeat, last_activity_at AS lastActivityAt FROM auth_sessions WHERE id = ?').get(req.auth.sessionId);
    const webSession = db.prepare('SELECT started_at AS startedAt FROM web_attendance_sessions WHERE auth_session_id = ? ORDER BY started_at DESC, id DESC LIMIT 1').get(req.auth.sessionId);
    const summary = summarizeActivity(db, req.auth.userId, dayStart, rangeEnd, { carryForwardOnlyFromOngoingSession: true });
    const awaySessions = events.filter((event, index) => event.status === 'away' && events[index - 1]?.status !== 'away').length;
    const firstAvailable = events.find((event) => event.status === 'available')?.occurredAt || null;
    const lastActivity = [...events].reverse().find((event) => event.status === 'available')?.occurredAt || null;
    res.json({
      status: latest?.status || 'unknown',
      attendanceStartedAt: webSession?.startedAt || sessionStarted.startedAt,
      firstAvailableAt: firstAvailable,
      lastActivityAt: sessionStarted.lastActivityAt || lastActivity,
      awaySessions,
      availableInteractionMs: summary.availableMs,
      awayDurationMs: summary.awayMs,
      events,
      applicationSwitches,
      cameraPolicy: { enabled: false, status: 'disabled_by_default' },
      session: { startedAt: sessionStarted.startedAt, lastHeartbeatAt: sessionStarted.lastHeartbeat, lastActivityAt: sessionStarted.lastActivityAt, expiresAt: req.auth.expiresAt },
      asOf: rangeEnd.toISOString()
    });
  });

  router.get('/attendance', (req, res) => {
    try {
      const range = parseReportRange(req.query);
      const events = db.prepare(`SELECT status, reason, occurred_at AS occurredAt FROM activity_events WHERE user_id = ?
        AND occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at`).all(req.auth.userId, range.start, range.end);
      res.json({ range, summary: summarizeActivity(db, req.auth.userId, range.start, range.end), events, note: 'Attendance session time and interaction-derived availability are distinct; available time is not verified productive work.' });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  router.get('/reports', (req, res) => {
    try {
      const range = parseReportRange(req.query);
      const summary = summarizeActivity(db, req.auth.userId, range.start, range.end);
      res.json({ range, note: 'Available duration is interaction-derived time, not verified productive work.', report: summary });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  router.get('/reports.csv', (req, res) => {
    try {
      const range = parseReportRange(req.query);
      const summary = summarizeActivity(db, req.auth.userId, range.start, range.end);
      const csv = createCsv([
        ['Employee ID', 'Available interaction minutes', 'Away minutes', 'Away sessions'],
        [req.auth.userId, Math.round(summary.availableMs / 60000), Math.round(summary.awayMs / 60000), summary.awaySessions]
      ]);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="my-activity-report.csv"');
      res.send(csv);
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  router.get('/activity', (req, res) => {
    let range;
    if (req.query.from !== undefined || req.query.to !== undefined) {
      try {
        if (req.query.from === undefined || req.query.to === undefined) throw new RangeError('Both activity range boundaries are required');
        range = parseReportRange(req.query);
      } catch (error) { return res.status(400).json({ error: error.message }); }
    }
    const rangeSql = range ? 'AND occurred_at >= ? AND occurred_at < ?' : '';
    const rangeParams = range ? [range.start, range.end] : [];
    const events = db.prepare(`SELECT id, previous_status AS previousStatus, status, reason, occurred_at AS occurredAt
      FROM activity_events WHERE user_id = ? ${rangeSql} ORDER BY occurred_at DESC, id DESC${range ? '' : ' LIMIT 500'}`)
      .all(req.auth.userId, ...rangeParams);
    const applicationSwitches = db.prepare(`SELECT id, previous_application AS previousApplication, previous_window_title AS previousWindowTitle,
      application, window_title AS windowTitle, occurred_at AS occurredAt FROM application_switch_events
      WHERE user_id = ? ${rangeSql} ORDER BY occurred_at DESC, id DESC${range ? '' : ' LIMIT 500'}`)
      .all(req.auth.userId, ...rangeParams);
    res.json({ events, applicationSwitches });
  });
  router.get('/profile', (req, res) => res.json({ user: { id: req.auth.userId, email: req.auth.email, fullName: req.auth.fullName, department: req.auth.department, designation: req.auth.designation } }));
  return router;
}
