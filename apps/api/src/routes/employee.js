import { Router } from 'express';
import { z } from 'zod';
import { createCsv, parseDashboardDayStart, parseReportRange, summarizeActivity } from '../services/activity-summary.js';
import { CAMERA_CONSENT_VERSION, decryptCameraImage, purgeExpiredCameraCheckins } from '../services/camera-checkins.js';

const now = () => new Date().toISOString();
const requireEmployee = (req, res, next) => req.auth?.role === 'employee' ? next() : res.status(req.auth ? 403 : 401).json({ error: req.auth ? 'Employee access required' : 'Authentication required' });

export function createEmployeeRouter({ db }) {
  const router = Router();
  router.use(requireEmployee);

  router.get('/camera-consent', (req, res) => {
    const consent = db.prepare('SELECT enabled, consent_version AS consentVersion, updated_at AS updatedAt FROM employee_camera_consents WHERE user_id = ?')
      .get(req.auth.userId);
    res.json({ enabled: Boolean(consent?.enabled), consentVersion: consent?.consentVersion || null, updatedAt: consent?.updatedAt || null });
  });

  router.put('/camera-consent', (req, res) => {
    const parsed = z.object({ enabled: z.boolean(), consentVersion: z.literal(CAMERA_CONSENT_VERSION) }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Explicit camera consent with the current disclosure is required' });
    const updatedAt = now();
    db.prepare(`INSERT INTO employee_camera_consents (user_id, enabled, consent_version, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled,
      consent_version = excluded.consent_version, updated_at = excluded.updated_at`)
      .run(req.auth.userId, Number(parsed.data.enabled), parsed.data.consentVersion, updatedAt);
    db.prepare('INSERT INTO audit_logs (actor_user_id, action, target_user_id, details, occurred_at) VALUES (?, ?, ?, ?, ?)')
      .run(req.auth.userId, parsed.data.enabled ? 'camera.consent_granted' : 'camera.consent_revoked',
        req.auth.userId, JSON.stringify({ consentVersion: parsed.data.consentVersion }), updatedAt);
    res.json({ enabled: parsed.data.enabled, consentVersion: parsed.data.consentVersion, updatedAt });
  });

  router.get('/camera-checkins', (req, res) => {
    purgeExpiredCameraCheckins(db);
    const checkins = db.prepare(`SELECT id, captured_at AS capturedAt FROM employee_camera_checkins
      WHERE user_id = ? ORDER BY captured_at DESC LIMIT 500`).all(req.auth.userId);
    res.json({ checkins });
  });

  router.get('/camera-checkins/:id/image', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid camera check-in id' });
      purgeExpiredCameraCheckins(db);
      const checkin = db.prepare(`SELECT id, activity_event_id AS activityEventId, encrypted_image AS encryptedImage
        FROM employee_camera_checkins WHERE id = ? AND user_id = ?`).get(id, req.auth.userId);
      if (!checkin) return res.status(404).json({ error: 'Camera check-in not found or expired' });
      const image = decryptCameraImage(checkin.encryptedImage, req.auth.userId, checkin.activityEventId);
      db.prepare('INSERT INTO audit_logs (actor_user_id, action, target_user_id, details, occurred_at) VALUES (?, ?, ?, ?, ?)')
        .run(req.auth.userId, 'camera_checkin.viewed', req.auth.userId, JSON.stringify({ checkinId: id }), now());
      res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
      res.send(image);
    } catch (error) { next(error); }
  });

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
    purgeExpiredCameraCheckins(db);
    const rangeEnd = new Date();
    let dayStart;
    try { dayStart = parseDashboardDayStart(req.query.dayStart, rangeEnd); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    const latest = db.prepare('SELECT id, status, occurred_at AS occurredAt, reason FROM activity_events WHERE auth_session_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 1').get(req.auth.sessionId);
    const events = db.prepare(`SELECT status, occurred_at AS occurredAt FROM activity_events WHERE user_id = ?
      AND occurred_at >= ? ORDER BY occurred_at, id`).all(req.auth.userId, dayStart);
    const applicationSwitches = db.prepare(`SELECT previous_application AS previousApplication, previous_window_title AS previousWindowTitle,
      application, window_title AS windowTitle, occurred_at AS occurredAt FROM application_switch_events
      WHERE user_id = ? AND occurred_at >= ? ORDER BY occurred_at DESC, id DESC LIMIT 200`)
      .all(req.auth.userId, dayStart);
    const sessionStarted = db.prepare(`SELECT started_at AS startedAt, last_heartbeat_at AS lastHeartbeat, last_activity_at AS lastActivityAt,
      last_network_ssid AS lastNetworkSsid, last_network_match AS lastNetworkMatch FROM auth_sessions WHERE id = ?`).get(req.auth.sessionId);
    const approvedNetworkCount = db.prepare('SELECT COUNT(*) AS count FROM office_networks WHERE active = 1').get().count;
    const officeNetworkStatus = !sessionStarted.lastNetworkSsid ? 'unknown'
      : approvedNetworkCount === 0 ? 'not_configured'
        : sessionStarted.lastNetworkMatch === 1 ? 'matched' : 'not_matched';
    const cameraPolicy = db.prepare(`SELECT camera_enabled AS enabled, camera_requires_office_network AS requiresOfficeNetwork
      FROM application_settings WHERE id = 1`).get();
    const cameraConsent = db.prepare('SELECT enabled, consent_version AS consentVersion FROM employee_camera_consents WHERE user_id = ?')
      .get(req.auth.userId);
    const cameraCheckins = db.prepare(`SELECT id, captured_at AS occurredAt FROM employee_camera_checkins
      WHERE user_id = ? AND captured_at >= ? ORDER BY captured_at DESC LIMIT 200`).all(req.auth.userId, dayStart);
    const currentAwayCheckin = latest?.status === 'away'
      ? db.prepare('SELECT id, captured_at AS occurredAt FROM employee_camera_checkins WHERE activity_event_id = ?').get(latest.id)
      : null;
    const webSession = db.prepare('SELECT started_at AS startedAt FROM web_attendance_sessions WHERE auth_session_id = ? ORDER BY started_at DESC, id DESC LIMIT 1').get(req.auth.sessionId);
    const summary = summarizeActivity(db, req.auth.userId, dayStart, rangeEnd, { carryForwardOnlyFromOngoingSession: true });
    const awaySessions = events.filter((event, index) => event.status === 'away' && events[index - 1]?.status !== 'away').length;
    const firstAvailable = events.find((event) => event.status === 'available')?.occurredAt || null;
    const lastActivity = [...events].reverse().find((event) => event.status === 'available')?.occurredAt || null;
    res.json({
      status: latest?.status || 'unknown',
      awayStartedAt: latest?.status === 'away' ? latest.occurredAt : null,
      attendanceStartedAt: webSession?.startedAt || sessionStarted.startedAt,
      firstAvailableAt: firstAvailable,
      lastActivityAt: sessionStarted.lastActivityAt || lastActivity,
      officeNetworkStatus,
      officeNetworkSsid: sessionStarted.lastNetworkSsid,
      awaySessions,
      availableInteractionMs: summary.availableMs,
      awayDurationMs: summary.awayMs,
      events,
      applicationSwitches,
      cameraCheckins,
      currentAwayCheckin: currentAwayCheckin || null,
      cameraConsent: { enabled: Boolean(cameraConsent?.enabled), consentVersion: cameraConsent?.consentVersion || null },
      cameraPolicy: {
        enabled: Boolean(cameraPolicy.enabled),
        requiresOfficeNetwork: Boolean(cameraPolicy.requiresOfficeNetwork),
        status: cameraPolicy.enabled ? 'employee_consent_required' : 'disabled_by_admin'
      },
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
    purgeExpiredCameraCheckins(db);
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
    const checkinRangeSql = range ? 'AND captured_at >= ? AND captured_at < ?' : '';
    const cameraCheckins = db.prepare(`SELECT id, captured_at AS occurredAt FROM employee_camera_checkins
      WHERE user_id = ? ${checkinRangeSql} ORDER BY captured_at DESC${range ? '' : ' LIMIT 500'}`)
      .all(req.auth.userId, ...rangeParams);
    res.json({ events, applicationSwitches, cameraCheckins });
  });
  router.get('/profile', (req, res) => res.json({ user: { id: req.auth.userId, email: req.auth.email, fullName: req.auth.fullName, department: req.auth.department, designation: req.auth.designation } }));
  return router;
}
