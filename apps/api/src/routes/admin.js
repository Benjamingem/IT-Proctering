import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { createCsv, parseDashboardDayStart, parseReportRange, summarizeActivity } from '../services/activity-summary.js';
import { decryptCameraImage, getCameraStorageKey, purgeExpiredCameraCheckins } from '../services/camera-checkins.js';

const now = () => new Date().toISOString();
const employeeInput = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254),
  temporaryPassword: z.string().min(12).max(200),
  department: z.string().trim().max(100).default(''),
  designation: z.string().trim().max(100).default('')
});
const requireAdmin = (req, res, next) => req.auth?.role === 'admin' ? next() : res.status(req.auth ? 403 : 401).json({ error: req.auth ? 'Administrator access required' : 'Authentication required' });

export function createAdminRouter({ db, io }) {
  const router = Router();
  router.use(requireAdmin);

  router.get('/dashboard', (req, res) => {
    const observedAt = now();
    let dayStart;
    try { dayStart = parseDashboardDayStart(req.query.dayStart, new Date(observedAt)); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    const employees = db.prepare(`SELECT u.id, u.full_name AS fullName, u.email, u.department, u.designation, u.active,
      (SELECT e.status FROM activity_events e WHERE e.user_id = u.id ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1) AS status,
      (SELECT s.last_heartbeat_at FROM auth_sessions s WHERE s.user_id = u.id AND s.ended_at IS NULL
       ORDER BY s.started_at DESC LIMIT 1) AS lastHeartbeat,
      (SELECT s.last_network_ssid FROM auth_sessions s WHERE s.user_id = u.id AND s.ended_at IS NULL
       ORDER BY s.started_at DESC LIMIT 1) AS lastNetworkSsid,
      (SELECT s.last_network_match FROM auth_sessions s WHERE s.user_id = u.id AND s.ended_at IS NULL
       ORDER BY s.started_at DESC LIMIT 1) AS officeNetworkMatch,
      (SELECT CASE
        WHEN s.last_network_ssid IS NULL THEN 'unknown'
        WHEN NOT EXISTS (SELECT 1 FROM office_networks WHERE active = 1) THEN 'not_configured'
        WHEN s.last_network_match = 1 THEN 'matched'
        ELSE 'not_matched' END
       FROM auth_sessions s WHERE s.user_id = u.id AND s.ended_at IS NULL ORDER BY s.started_at DESC LIMIT 1) AS officeNetworkStatus,
      EXISTS (SELECT 1 FROM auth_sessions s WHERE s.user_id = u.id AND s.ended_at IS NULL AND s.expires_at > ?) AS sessionActive,
      EXISTS (SELECT 1 FROM activity_events e WHERE e.user_id = u.id AND e.reason = 'login' AND e.occurred_at >= ?) AS loggedInToday
      FROM users u WHERE u.role = 'employee' AND u.active = 1 ORDER BY u.full_name COLLATE NOCASE`).all(observedAt, dayStart);
    const present = employees.filter((employee) => employee.sessionActive || employee.loggedInToday).length;
    const offline = employees.filter((employee) => (employee.sessionActive || employee.loggedInToday) && ['offline', 'unknown', null].includes(employee.status)).length;
    const rangeEnd = new Date(observedAt);
    const durations = employees.reduce((totals, employee) => {
      const summary = summarizeActivity(db, employee.id, dayStart, rangeEnd, { carryForwardOnlyFromOngoingSession: true });
      totals.activeInteractionMs += summary.availableMs;
      totals.awayMs += summary.awayMs;
      return totals;
    }, { activeInteractionMs: 0, awayMs: 0 });
    res.json({ kpis: {
      totalEmployees: employees.length,
      presentToday: present,
      available: employees.filter((employee) => employee.status === 'available').length,
      away: employees.filter((employee) => employee.status === 'away').length,
      offline,
      absentToday: Math.max(0, employees.length - present),
      ...durations
    }, employees });
  });

  function employeeReportRows(range) {
    const employees = db.prepare("SELECT id, full_name AS fullName, email FROM users WHERE role = 'employee' ORDER BY full_name COLLATE NOCASE").all();
    return employees.map((employee) => ({ ...employee, ...summarizeActivity(db, employee.id, range.start, range.end) }));
  }
  router.get('/reports', (req, res) => {
    try {
      const range = parseReportRange(req.query);
      res.json({ range, note: 'Available duration is interaction-derived time, not verified productive work.', employees: employeeReportRows(range) });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  router.get('/reports.csv', (req, res) => {
    try {
      const range = parseReportRange(req.query);
      const rows = employeeReportRows(range);
      const csv = createCsv([
        ['Employee ID', 'Full name', 'Email', 'Available interaction minutes', 'Away minutes', 'Away sessions'],
        ...rows.map((row) => [row.id, row.fullName, row.email, Math.round(row.availableMs / 60000), Math.round(row.awayMs / 60000), row.awaySessions])
      ]);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="employee-activity-report.csv"');
      res.send(csv);
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  router.get('/employees', (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.max(1, Math.min(100, Number(req.query.pageSize) || 25));
    const search = String(req.query.search || '').trim().slice(0, 100);
    const department = String(req.query.department || '').trim().slice(0, 100);
    const rows = db.prepare(`SELECT id, email, full_name AS fullName, department, designation, active, created_at AS createdAt
      FROM users WHERE role = 'employee' AND (? = '' OR full_name LIKE ? OR email LIKE ?)
      AND (? = '' OR department = ?) ORDER BY full_name COLLATE NOCASE LIMIT ? OFFSET ?`)
      .all(search, `%${search}%`, `%${search}%`, department, department, pageSize, (page - 1) * pageSize);
    res.json({ employees: rows, page, pageSize });
  });

  router.get('/employees/:id/camera-checkins', (req, res) => {
    const employeeId = Number(req.params.id);
    if (!Number.isInteger(employeeId)) return res.status(400).json({ error: 'Invalid employee id' });
    if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'employee'").get(employeeId)) return res.status(404).json({ error: 'Employee not found' });
    purgeExpiredCameraCheckins(db);
    const checkins = db.prepare(`SELECT id, captured_at AS capturedAt FROM employee_camera_checkins
      WHERE user_id = ? ORDER BY captured_at DESC LIMIT 500`).all(employeeId);
    res.json({ checkins });
  });

  router.get('/employees/:id/camera-checkins/:checkinId/image', (req, res, next) => {
    try {
      const employeeId = Number(req.params.id);
      const checkinId = Number(req.params.checkinId);
      if (!Number.isInteger(employeeId) || !Number.isInteger(checkinId)) return res.status(400).json({ error: 'Invalid camera check-in id' });
      if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'employee'").get(employeeId)) return res.status(404).json({ error: 'Employee not found' });
      purgeExpiredCameraCheckins(db);
      const checkin = db.prepare(`SELECT id, activity_event_id AS activityEventId, encrypted_image AS encryptedImage
        FROM employee_camera_checkins WHERE id = ? AND user_id = ?`).get(checkinId, employeeId);
      if (!checkin) return res.status(404).json({ error: 'Camera check-in not found or expired' });
      const image = decryptCameraImage(checkin.encryptedImage, employeeId, checkin.activityEventId);
      db.prepare('INSERT INTO audit_logs (actor_user_id, action, target_user_id, details, occurred_at) VALUES (?, ?, ?, ?, ?)')
        .run(req.auth.userId, 'camera_checkin.viewed', employeeId, JSON.stringify({ checkinId }), now());
      res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
      res.send(image);
    } catch (error) { next(error); }
  });

  router.post('/employees', async (req, res, next) => {
    try {
      const parsed = employeeInput.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid employee details', details: parsed.error.flatten().fieldErrors });
      const input = parsed.data;
      const passwordHash = await bcrypt.hash(input.temporaryPassword, 12);
      const createdAt = now();
      try {
        const result = db.prepare(`INSERT INTO users (email, password_hash, role, full_name, department, designation, created_at, updated_at)
          VALUES (?, ?, 'employee', ?, ?, ?, ?, ?)`).run(input.email, passwordHash, input.fullName, input.department, input.designation, createdAt, createdAt);
        db.prepare('INSERT INTO audit_logs (actor_user_id, action, target_user_id, details, occurred_at) VALUES (?, ?, ?, ?, ?)')
          .run(req.auth.userId, 'employee.created', result.lastInsertRowid, JSON.stringify({ email: input.email }), createdAt);
        io.to('admins').emit('employee:created', { id: result.lastInsertRowid, fullName: input.fullName });
        res.status(201).json({ employee: { id: result.lastInsertRowid, ...input, temporaryPassword: undefined, active: 1 } });
      } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.errcode === 2067) return res.status(409).json({ error: 'An account with this email already exists' });
        throw error;
      }
    } catch (error) { next(error); }
  });

  router.patch('/employees/:id', (req, res) => {
    const id = Number(req.params.id);
    const patch = z.object({ fullName: z.string().trim().min(2).max(120).optional(), department: z.string().trim().max(100).optional(), designation: z.string().trim().max(100).optional(), active: z.boolean().optional() }).strict().safeParse(req.body);
    if (!Number.isInteger(id) || !patch.success || Object.keys(patch.data).length === 0) return res.status(400).json({ error: 'Invalid employee update' });
    const existing = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'employee'").get(id);
    if (!existing) return res.status(404).json({ error: 'Employee not found' });
    const columns = { fullName: 'full_name', department: 'department', designation: 'designation', active: 'active' };
    const assignments = Object.entries(patch.data).map(([key]) => `${columns[key]} = ?`);
    const values = Object.entries(patch.data).map(([key, value]) => key === 'active' ? Number(value) : value);
    const occurredAt = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      if (patch.data.active === false) {
        const sessions = db.prepare(`SELECT s.id AS sessionId, e.status FROM auth_sessions s
          LEFT JOIN activity_events e ON e.id = (SELECT latest.id FROM activity_events latest
            WHERE latest.auth_session_id = s.id ORDER BY latest.occurred_at DESC, latest.id DESC LIMIT 1)
          WHERE s.user_id = ? AND s.ended_at IS NULL`).all(id);
        const insertOffline = db.prepare(`INSERT INTO activity_events (user_id, auth_session_id, previous_status, status, reason, occurred_at)
          VALUES (?, ?, ?, 'offline', 'account_deactivated', ?)`);
        for (const session of sessions) {
          if (session.status && session.status !== 'offline') insertOffline.run(id, session.sessionId, session.status, occurredAt);
        }
        db.prepare('UPDATE auth_sessions SET ended_at = ? WHERE user_id = ? AND ended_at IS NULL').run(occurredAt, id);
      }
      db.prepare(`UPDATE users SET ${assignments.join(', ')}, updated_at = ? WHERE id = ?`).run(...values, occurredAt, id);
      db.prepare('INSERT INTO audit_logs (actor_user_id, action, target_user_id, details, occurred_at) VALUES (?, ?, ?, ?, ?)')
        .run(req.auth.userId, 'employee.updated', id, JSON.stringify(patch.data), occurredAt);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (patch.data.active === false) io.in(`user:${id}`).disconnectSockets(true);
    io.to('admins').emit('employee:updated', { id, ...patch.data });
    res.json({ updated: true });
  });

  router.get('/employees/:id/activity', (req, res) => {
    const employeeId = Number(req.params.id);
    if (!Number.isInteger(employeeId)) return res.status(400).json({ error: 'Invalid employee id' });
    const events = db.prepare(`SELECT id, previous_status AS previousStatus, status, reason, occurred_at AS occurredAt
      FROM activity_events WHERE user_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 500`).all(employeeId);
    res.json({ events });
  });

  router.get('/office-networks', (_req, res) => {
    const networks = db.prepare(`SELECT id, label, ssid, active, created_at AS createdAt
      FROM office_networks ORDER BY label COLLATE NOCASE, ssid COLLATE NOCASE`).all();
    const currentDevice = db.prepare(`SELECT last_network_ssid AS ssid, last_network_match AS matched, last_heartbeat_at AS checkedAt
      FROM auth_sessions WHERE id = ?`).get(_req.auth.sessionId);
    const approvedCount = db.prepare('SELECT COUNT(*) AS count FROM office_networks WHERE active = 1').get().count;
    const officeNetworkStatus = !currentDevice?.ssid ? 'unknown' : approvedCount === 0 ? 'not_configured' : currentDevice.matched === 1 ? 'matched' : 'not_matched';
    res.json({ networks, currentDevice: { ...currentDevice, officeNetworkStatus } });
  });

  router.post('/office-networks/current-match', (req, res) => {
    const parsed = z.object({ ssid: z.string().trim().min(1).max(32).nullable() }).strict().safeParse(req.body);
    if (!parsed.success || Buffer.byteLength(parsed.data?.ssid || '', 'utf8') > 32) return res.status(400).json({ error: 'Invalid Wi-Fi SSID' });
    const ssid = parsed.data.ssid || null;
    const approvedCount = db.prepare('SELECT COUNT(*) AS count FROM office_networks WHERE active = 1').get().count;
    const isMatch = ssid && approvedCount
      ? db.prepare('SELECT 1 AS matched FROM office_networks WHERE ssid = ? AND active = 1').get(ssid)
      : null;
    const status = !ssid ? 'unknown' : approvedCount === 0 ? 'not_configured' : isMatch ? 'matched' : 'not_matched';
    const checkedAt = now();
    db.prepare(`UPDATE auth_sessions SET last_network_ssid = ?, last_network_match = ?, last_heartbeat_at = ?
      WHERE id = ? AND ended_at IS NULL`).run(ssid, status === 'matched' ? 1 : status === 'not_matched' ? 0 : null, checkedAt, req.auth.sessionId);
    const currentDevice = { ssid, officeNetworkStatus: status, checkedAt };
    io.to('admins').emit('office-network:device', currentDevice);
    res.json({ currentDevice });
  });

  router.post('/office-networks', (req, res) => {
    const parsed = z.object({ label: z.string().trim().min(1).max(80), ssid: z.string().trim().min(1).max(32) }).strict().safeParse(req.body);
    if (!parsed.success || Buffer.byteLength(parsed.data?.ssid || '', 'utf8') > 32) return res.status(400).json({ error: 'Enter a network label and an SSID no longer than 32 bytes' });
    const occurredAt = now();
    try {
      const result = db.prepare('INSERT INTO office_networks (label, ssid, created_by, created_at) VALUES (?, ?, ?, ?)')
        .run(parsed.data.label, parsed.data.ssid, req.auth.userId, occurredAt);
      db.prepare('INSERT INTO audit_logs (actor_user_id, action, details, occurred_at) VALUES (?, ?, ?, ?)')
        .run(req.auth.userId, 'office_network.created', JSON.stringify({ label: parsed.data.label, ssid: parsed.data.ssid }), occurredAt);
      const network = { id: result.lastInsertRowid, label: parsed.data.label, ssid: parsed.data.ssid, active: 1, createdAt: occurredAt };
      io.to('admins').emit('office-network:updated', network);
      res.status(201).json({ network });
    } catch (error) {
      if (error.code === 'ERR_SQLITE_ERROR' && error.errcode === 2067) return res.status(409).json({ error: 'That Wi-Fi SSID is already approved' });
      throw error;
    }
  });

  router.delete('/office-networks/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid network id' });
    const network = db.prepare('SELECT id, label, ssid FROM office_networks WHERE id = ?').get(id);
    if (!network) return res.status(404).json({ error: 'Office network not found' });
    const occurredAt = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE auth_sessions SET last_network_match = 0 WHERE last_network_ssid = ? AND ended_at IS NULL').run(network.ssid);
      db.prepare('DELETE FROM office_networks WHERE id = ?').run(id);
      db.prepare('INSERT INTO audit_logs (actor_user_id, action, details, occurred_at) VALUES (?, ?, ?, ?)')
        .run(req.auth.userId, 'office_network.removed', JSON.stringify(network), occurredAt);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    io.to('admins').emit('office-network:removed', { id });
    res.status(204).end();
  });

  router.get('/policies', (_req, res) => {
    const policy = db.prepare('SELECT idle_threshold_seconds AS idleThresholdSeconds, camera_enabled AS cameraEnabled, camera_requires_office_network AS cameraRequiresOfficeNetwork, organization_timezone AS organizationTimezone FROM application_settings WHERE id = 1').get();
    res.json({ ...policy, cameraEnabled: Boolean(policy.cameraEnabled), cameraRequiresOfficeNetwork: Boolean(policy.cameraRequiresOfficeNetwork), cameraStorageReady: Boolean(getCameraStorageKey()) });
  });

  router.patch('/policies', (req, res) => {
    const parsed = z.object({ idleThresholdSeconds: z.number().int().min(1).max(3600).optional(), cameraEnabled: z.boolean().optional(), cameraRequiresOfficeNetwork: z.literal(true).optional(), organizationTimezone: z.string().min(1).max(80).optional() }).strict().safeParse(req.body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) return res.status(400).json({ error: 'Invalid policy update' });
    if (parsed.data.cameraEnabled === true && !getCameraStorageKey()) return res.status(503).json({ error: 'Configure CAMERA_STORAGE_KEY with a base64-encoded 32-byte key before enabling camera check-ins' });
    const columns = { idleThresholdSeconds: 'idle_threshold_seconds', cameraEnabled: 'camera_enabled', cameraRequiresOfficeNetwork: 'camera_requires_office_network', organizationTimezone: 'organization_timezone' };
    const entries = Object.entries(parsed.data);
    db.prepare(`UPDATE application_settings SET ${entries.map(([key]) => `${columns[key]} = ?`).join(', ')} WHERE id = 1`)
      .run(...entries.map(([key, value]) => typeof value === 'boolean' ? Number(value) : value));
    const occurredAt = now();
    db.prepare('INSERT INTO audit_logs (actor_user_id, action, details, occurred_at) VALUES (?, ?, ?, ?)')
      .run(req.auth.userId, 'policy.updated', JSON.stringify(parsed.data), occurredAt);
    io.to('admins').emit('policy:updated', parsed.data);
    if (typeof parsed.data.cameraEnabled === 'boolean') io.to('employees').emit('policy:updated', parsed.data);
    res.json({ updated: true });
  });

  router.get('/audit-logs', (req, res) => {
    const logs = db.prepare(`SELECT a.id, a.action, a.target_user_id AS targetUserId, a.details, a.occurred_at AS occurredAt, u.full_name AS actorName
      FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id ORDER BY a.occurred_at DESC LIMIT ?`).all(Math.min(200, Math.max(1, Number(req.query.limit) || 100)));
    res.json({ logs });
  });
  return router;
}
