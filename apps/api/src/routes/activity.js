import { Router } from 'express';
import { z } from 'zod';
import { HEARTBEAT_STALE_THRESHOLD_MS } from '@eam/shared';

const now = () => new Date().toISOString();
const requireEmployee = (req, res, next) => req.auth?.role === 'employee' ? next() : res.status(req.auth ? 403 : 401).json({ error: req.auth ? 'Employee access required' : 'Authentication required' });

export function createActivityRouter({ db, io }) {
  const router = Router();
  router.use(requireEmployee);

  router.post('/application-switch', (req, res) => {
    const label = z.string().trim().min(1).max(200);
    const parsed = z.object({
      previousApplication: label.nullable().optional(),
      previousWindowTitle: label.nullable().optional(),
      application: label,
      windowTitle: label
    }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Valid foreground application details are required' });
    const cleanLabel = (value) => value?.replace(/[\u0000-\u001f\u007f]/g, '').trim() || null;
    const application = cleanLabel(parsed.data.application);
    const windowTitle = cleanLabel(parsed.data.windowTitle);
    if (!application || !windowTitle) return res.status(400).json({ error: 'Application name and window title cannot be empty' });
    const previousApplication = cleanLabel(parsed.data.previousApplication);
    const previousWindowTitle = cleanLabel(parsed.data.previousWindowTitle);
    const occurredAt = now();
    const result = db.prepare(`INSERT INTO application_switch_events
      (user_id, auth_session_id, previous_application, previous_window_title, application, window_title, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(req.auth.userId, req.auth.sessionId, previousApplication, previousWindowTitle, application, windowTitle, occurredAt);
    const event = { id: result.lastInsertRowid, previousApplication, previousWindowTitle, application, windowTitle, occurredAt };
    io.to('admins').emit('application:switch', { userId: req.auth.userId, ...event });
    io.to(`user:${req.auth.userId}`).emit('application:switch', event);
    res.status(201).json({ event });
  });

  router.post('/heartbeat', (req, res) => {
    const parsed = z.object({ idleSeconds: z.number().int().min(0).max(86400), locked: z.boolean().optional(), repetitiveInput: z.boolean().optional(), networkSsid: z.string().trim().min(1).max(32).nullable().optional() }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'A valid idleSeconds value and optional lock state are required' });
    const heartbeatAt = now();
    const lastActivityAt = new Date(Date.parse(heartbeatAt) - parsed.data.idleSeconds * 1000).toISOString();
    const networkSsid = parsed.data.networkSsid || null;
    const approvedNetworks = db.prepare('SELECT ssid FROM office_networks WHERE active = 1').all();
    const approvedNetworkCount = approvedNetworks.length;
    const approvedNetwork = networkSsid && approvedNetworkCount && approvedNetworks.some((network) => network.ssid === networkSsid);
    const officeNetworkStatus = !networkSsid ? 'unknown' : approvedNetworkCount === 0 ? 'not_configured' : approvedNetwork ? 'matched' : 'not_matched';
    const networkMatch = officeNetworkStatus === 'matched' ? 1 : officeNetworkStatus === 'not_matched' ? 0 : null;
    const session = db.prepare('SELECT last_heartbeat_at AS lastHeartbeatAt FROM auth_sessions WHERE id = ? AND ended_at IS NULL')
      .get(req.auth.sessionId);
    const current = db.prepare('SELECT status, occurred_at AS occurredAt FROM activity_events WHERE auth_session_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 1')
      .get(req.auth.sessionId);
    const lastHeartbeatAt = Date.parse(session.lastHeartbeatAt);
    const lastKnownAt = Math.max(lastHeartbeatAt, Date.parse(current?.occurredAt) || 0);
    if (current && ['available', 'away'].includes(current.status)
      && Date.parse(heartbeatAt) - lastKnownAt > HEARTBEAT_STALE_THRESHOLD_MS) {
      const offlineAt = new Date(lastKnownAt + HEARTBEAT_STALE_THRESHOLD_MS).toISOString();
      db.prepare(`INSERT INTO activity_events (user_id, auth_session_id, previous_status, status, reason, occurred_at)
        VALUES (?, ?, ?, 'offline', 'heartbeat_timeout', ?)`).run(req.auth.userId, req.auth.sessionId, current.status, offlineAt);
      const event = { userId: req.auth.userId, status: 'offline', reason: 'heartbeat_timeout', occurredAt: offlineAt };
      io.to('admins').emit('agent:stale', event);
      io.to(`user:${req.auth.userId}`).emit('activity:transition', event);
    }
    db.prepare(`UPDATE auth_sessions SET last_heartbeat_at = ?, last_activity_at = ?, last_network_ssid = ?, last_network_match = ?
      WHERE id = ? AND ended_at IS NULL`).run(heartbeatAt, lastActivityAt, networkSsid, networkMatch, req.auth.sessionId);
    const policy = db.prepare('SELECT idle_threshold_seconds AS threshold FROM application_settings WHERE id = 1').get();
    const repetitiveInput = parsed.data.repetitiveInput === true;
    const nextStatus = parsed.data.locked || repetitiveInput || parsed.data.idleSeconds >= policy.threshold ? 'away' : 'available';
    const latestStatus = db.prepare('SELECT status FROM activity_events WHERE auth_session_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 1').get(req.auth.sessionId);
    if (latestStatus?.status !== nextStatus) {
      const reason = parsed.data.locked ? 'screen_locked' : repetitiveInput ? 'repetitive_input_pattern' : nextStatus === 'away' ? 'os_idle_threshold' : 'os_user_activity';
      db.prepare(`INSERT INTO activity_events (user_id, auth_session_id, previous_status, status, reason, occurred_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(req.auth.userId, req.auth.sessionId, latestStatus?.status || 'unknown', nextStatus, reason, heartbeatAt);
      const event = { userId: req.auth.userId, status: nextStatus, reason, occurredAt: heartbeatAt };
      io.to('admins').emit('activity:transition', event);
      io.to(`user:${req.auth.userId}`).emit('activity:transition', event);
    }
    io.to('admins').emit('agent:heartbeat', { userId: req.auth.userId, lastHeartbeatAt: heartbeatAt, status: nextStatus, networkSsid, officeNetworkStatus });
    res.json({ receivedAt: heartbeatAt, status: nextStatus, idleThresholdSeconds: policy.threshold, officeNetworkStatus });
  });
  return router;
}
