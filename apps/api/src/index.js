import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { Server as SocketServer } from 'socket.io';
import { parse } from 'cookie';
import { db } from './db.js';
import { createAuthRouter, createSessionMiddleware, COOKIE_NAME, hashToken } from './routes/auth.js';
import { createAdminRouter } from './routes/admin.js';
import { createEmployeeRouter } from './routes/employee.js';
import { createActivityRouter } from './routes/activity.js';

const app = express();
const server = createServer(app);
const io = new SocketServer(server, { serveClient: true });
const webDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  connectSrc: ["'self'", 'ws:', 'wss:'],
  imgSrc: ["'self'", 'data:'],
  objectSrc: ["'none'"],
  frameAncestors: ["'none'"]
} } }));
app.use(express.json({ limit: '32kb' }));
app.use(createSessionMiddleware(db));
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false }));
app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.use('/api/auth', createAuthRouter({ db }));
app.use('/api/admin', createAdminRouter({ db, io }));
app.use('/api/employee', createEmployeeRouter({ db }));
app.use('/api/activity', createActivityRouter({ db, io }));
app.use(express.static(webDirectory));
app.get('*', (_req, res) => res.sendFile(resolve(webDirectory, 'index.html')));
app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.status ? error.message : 'Internal server error' });
});

io.use((socket, next) => {
  const token = parse(socket.handshake.headers.cookie || '')[COOKIE_NAME];
  if (!token) return next(new Error('Unauthorized'));
  const session = db.prepare(`SELECT s.id, s.user_id AS userId, u.role FROM auth_sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.ended_at IS NULL AND s.expires_at > ? AND u.active = 1`)
    .get(hashToken(token), new Date().toISOString());
  if (!session) return next(new Error('Unauthorized'));
  socket.data.userId = session.userId;
  socket.data.role = session.role;
  next();
});
io.on('connection', (socket) => {
  socket.join(socket.data.role === 'admin' ? 'admins' : `user:${socket.data.userId}`);
});

const port = Number(process.env.PORT || 3000);
if (process.env.NODE_ENV !== 'test') {
  const staleTimer = setInterval(() => {
    const observedAt = new Date().toISOString();
    const cutoff = new Date(Date.now() - 45_000).toISOString();
    const staleSessions = db.prepare(`SELECT s.id AS sessionId, s.user_id AS userId, e.status AS previousStatus
      FROM auth_sessions s JOIN users u ON u.id = s.user_id
      JOIN activity_events e ON e.id = (SELECT latest.id FROM activity_events latest
        WHERE latest.auth_session_id = s.id ORDER BY latest.occurred_at DESC, latest.id DESC LIMIT 1)
      WHERE s.ended_at IS NULL AND s.expires_at > ? AND s.last_heartbeat_at < ? AND e.status IN ('available', 'away') AND u.active = 1`)
      .all(observedAt, cutoff);
    const insertOffline = db.prepare(`INSERT INTO activity_events (user_id, auth_session_id, previous_status, status, reason, occurred_at)
      VALUES (?, ?, ?, 'offline', 'heartbeat_timeout', ?)`);
    for (const stale of staleSessions) {
      insertOffline.run(stale.userId, stale.sessionId, stale.previousStatus, observedAt);
      io.to('admins').emit('agent:stale', { userId: stale.userId, status: 'offline', reason: 'heartbeat_timeout', occurredAt: observedAt });
      io.to(`user:${stale.userId}`).emit('activity:transition', { userId: stale.userId, status: 'offline', reason: 'heartbeat_timeout', occurredAt: observedAt });
    }
  }, 10_000);
  staleTimer.unref();
  server.listen(port, () => console.log(`Employee Activity Monitor listening on http://localhost:${port}`));
}

export { app, server, io };
