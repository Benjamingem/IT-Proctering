import { createHash, randomBytes } from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { parse, serialize } from 'cookie';
import { z } from 'zod';

const COOKIE_NAME = 'eam_session';
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const now = () => new Date().toISOString();
const cookieOptions = () => ({ httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/' });

export function createSessionMiddleware(db) {
  return (req, _res, next) => {
    const token = parse(req.headers.cookie || '')[COOKIE_NAME];
    if (token) {
      const record = db.prepare(`SELECT s.id AS sessionId, s.user_id AS userId, s.expires_at AS expiresAt,
        u.email, u.full_name AS fullName, u.role, u.department, u.designation
        FROM auth_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.ended_at IS NULL AND s.expires_at > ? AND u.active = 1`).get(hashToken(token), now());
      if (record) req.auth = record;
    }
    next();
  };
}
export function createAuthRouter({ db }) {
  const router = Router();
  router.post('/login', async (req, res, next) => {
    try {
      const input = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) }).safeParse(req.body);
      if (!input.success) return res.status(400).json({ error: 'Valid email and password are required' });
      const user = db.prepare('SELECT id, email, full_name, role, department, designation, password_hash FROM users WHERE email = ? COLLATE NOCASE AND active = 1').get(input.data.email);
      if (!user || !(await bcrypt.compare(input.data.password, user.password_hash))) return res.status(401).json({ error: 'Invalid email or password' });

      const token = randomBytes(32).toString('base64url');
      const startedAt = now();
      const ttlHours = Math.max(1, Math.min(24, Number(process.env.SESSION_TTL_HOURS || 12)));
      const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();
      const result = db.prepare('INSERT INTO auth_sessions (token_hash, user_id, started_at, expires_at, last_heartbeat_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(hashToken(token), user.id, startedAt, expiresAt, startedAt, startedAt);
      db.prepare(`INSERT INTO activity_events (user_id, auth_session_id, previous_status, status, reason, occurred_at)
        VALUES (?, ?, 'offline', 'unknown', 'login', ?)`).run(user.id, result.lastInsertRowid, startedAt);
      res.setHeader('Set-Cookie', serialize(COOKIE_NAME, token, { ...cookieOptions(), expires: new Date(expiresAt) }));
      res.json({ user: { id: user.id, email: user.email, fullName: user.full_name, role: user.role, department: user.department, designation: user.designation } });
    } catch (error) { next(error); }
  });

  router.get('/me', (req, res) => {
    if (!req.auth) return res.status(401).json({ error: 'Authentication required' });
    const { userId, sessionId, email, fullName, role, department, designation, expiresAt } = req.auth;
    res.json({ user: { id: userId, email, fullName, role, department, designation }, session: { id: sessionId, expiresAt } });
  });

  router.post('/logout', (req, res) => {
    if (req.auth) {
      const current = db.prepare('SELECT status FROM activity_events WHERE auth_session_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 1').get(req.auth.sessionId);
      const endedAt = now();
      if (current && current.status !== 'offline') {
        db.prepare(`INSERT INTO activity_events (user_id, auth_session_id, previous_status, status, reason, occurred_at)
          VALUES (?, ?, ?, 'offline', 'logout', ?)`).run(req.auth.userId, req.auth.sessionId, current.status, endedAt);
      }
      db.prepare('UPDATE auth_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(endedAt, req.auth.sessionId);
    }
    res.setHeader('Set-Cookie', serialize(COOKIE_NAME, '', { ...cookieOptions(), expires: new Date(0) }));
    res.status(204).end();
  });
  return router;
}

export { COOKIE_NAME, hashToken };
