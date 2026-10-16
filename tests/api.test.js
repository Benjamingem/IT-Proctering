import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import bcrypt from 'bcryptjs';
import { io as connectSocket } from 'socket.io-client';
import { calculateDurations, getAwayPopupAction } from '@eam/shared';
import { createActivityTracker } from '../apps/web/activity-tracker.js';
import { createCsv, parseDashboardDayStart } from '../apps/api/src/services/activity-summary.js';

let server;
let io;
let db;
let origin;
let temporaryDirectory;
let adminCookie;
let employeeCookie;
let adminSocket;

async function login(email, password) {
  const response = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return { response, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function api(path, cookie, options = {}) {
  return fetch(`${origin}/api${path}`, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie, ...options.headers } });
}

before(async () => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'eam-api-'));
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_PATH = join(temporaryDirectory, 'test.sqlite');
  ({ server, io } = await import('../apps/api/src/index.js'));
  ({ db } = await import('../apps/api/src/db.js'));
  const passwordHash = await bcrypt.hash('Admin-password-for-tests-42!', 4);
  db.prepare("INSERT INTO users (email, password_hash, role, full_name) VALUES (?, ?, 'admin', ?)").run('admin@test.local', passwordHash, 'Test Administrator');
  await new Promise((resolve) => server.listen(0, resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  adminSocket?.disconnect();
  if (io) await new Promise((resolve) => io.close(resolve));
  db?.close();
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('duration boundaries and spreadsheet-safe CSV values', () => {
  const start = Date.parse('2026-10-14T09:00:00.000Z');
  const events = [
    { status: 'available', occurredAt: new Date(start + 60_000).toISOString() },
    { status: 'away', occurredAt: new Date(start + 4 * 60_000).toISOString() },
    { status: 'available', occurredAt: new Date(start + 6 * 60_000).toISOString() },
    { status: 'offline', occurredAt: new Date(start + 9 * 60_000).toISOString() }
  ];
  assert.deepEqual(calculateDurations(events, start, start + 10 * 60_000), { availableMs: 6 * 60_000, awayMs: 2 * 60_000, awaySessions: 1 });
  assert.equal(createCsv([['=HYPERLINK("x")']]), '"\'=HYPERLINK(""x"")"');
});

test('dashboard day start accepts an explicit device-local boundary and rejects invalid or future values', () => {
  const referenceDate = new Date('2026-10-16T12:00:00.000Z');
  assert.equal(parseDashboardDayStart('2026-10-15T18:30:00.000Z', referenceDate), '2026-10-15T18:30:00.000Z');
  assert.equal(parseDashboardDayStart(undefined, referenceDate), '2026-10-16T00:00:00.000Z');
  assert.throws(() => parseDashboardDayStart('not-a-date', referenceDate), /valid ISO timestamp/);
  assert.throws(() => parseDashboardDayStart('2026-10-16T12:00:01.000Z', referenceDate), /no later than now/);
});

test('Away popup appears once per Away period and closes when status changes', () => {
  assert.equal(getAwayPopupAction('available', 'away'), 'show');
  assert.equal(getAwayPopupAction('away', 'away'), 'keep');
  assert.equal(getAwayPopupAction('away', 'available'), 'close');
  assert.equal(getAwayPopupAction('away', 'offline'), 'close');
  assert.equal(getAwayPopupAction('unknown', 'unknown'), 'none');
});

test('browser activity tracker detects repetitive clicks, motion, and long presses without retaining input data', () => {
  const clicks = createActivityTracker({ now: () => 0 });
  clicks.noteClick('save-button', 0);
  clicks.noteClick('save-button', 2500);
  assert.equal(clicks.getState(2500).repetitiveInput, false);
  clicks.noteClick('save-button', 5100);
  assert.equal(clicks.getState(5100).repetitiveInput, true);
  clicks.noteClick('save-button', 6000);
  assert.equal(clicks.getState(6000).repetitiveInput, true);
  clicks.noteKeyboardActivity(6100);
  assert.equal(clicks.getState(6100).repetitiveInput, false);

  const movement = createActivityTracker({ now: () => 0 });
  let x = 0;
  movement.notePointerMove(x, 0, 0);
  for (let step = 1; step <= 6; step += 1) {
    x = step % 2 ? 20 : 0;
    movement.notePointerMove(x, 0, step * 1000);
  }
  assert.equal(movement.getState(6000).repetitiveInput, true);
  movement.notePointerMove(0, 100, 7000);
  assert.equal(movement.getState(7000).repetitiveInput, false);

  const hold = createActivityTracker({ now: () => 0 });
  hold.notePointerDown('submit-button', 0);
  assert.equal(hold.getState(4999).repetitiveInput, false);
  assert.equal(hold.getState(5000).repetitiveInput, true);
  hold.notePointerUp('outside-button', 5001);
  hold.noteKeyboardActivity(5002);
  assert.equal(hold.getState(5002).repetitiveInput, false);
});

test('authentication, role isolation, activity transitions, realtime delivery, and logout', async () => {
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 7);
  const invalid = await login('admin@test.local', 'wrong-password');
  assert.equal(invalid.response.status, 401);

  const adminLogin = await login('admin@test.local', 'Admin-password-for-tests-42!');
  assert.equal(adminLogin.response.status, 200);
  adminCookie = adminLogin.cookie;
  assert.ok(adminCookie?.startsWith('eam_session='));
  const adminMe = await api('/auth/me', adminCookie);
  assert.equal((await adminMe.json()).user.role, 'admin');

  adminSocket = connectSocket(origin, { extraHeaders: { Cookie: adminCookie }, transports: ['websocket'] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Socket connection timed out')), 3000);
    adminSocket.once('connect', () => { clearTimeout(timeout); resolve(); });
    adminSocket.once('connect_error', (error) => { clearTimeout(timeout); reject(error); });
  });

  const employeePayload = { fullName: 'Morgan Lee', email: 'morgan@example.test', temporaryPassword: 'Temporary-password-42!', department: 'Engineering', designation: 'Developer' };
  const approvedNetwork = await api('/admin/office-networks', adminCookie, { method: 'POST', body: JSON.stringify({ label: 'Head Office', ssid: 'Northstar-Office' }) });
  assert.equal(approvedNetwork.status, 201);
  const networkId = (await approvedNetwork.json()).network.id;
  const duplicateNetwork = await api('/admin/office-networks', adminCookie, { method: 'POST', body: JSON.stringify({ label: 'Duplicate', ssid: 'Northstar-Office' }) });
  assert.equal(duplicateNetwork.status, 409);
  const currentAdminWifi = await api('/admin/office-networks/current-match', adminCookie, { method: 'POST', body: JSON.stringify({ ssid: 'Northstar-Office' }) });
  assert.equal((await currentAdminWifi.json()).currentDevice.officeNetworkStatus, 'matched');
  const unknownAdminWifi = await api('/admin/office-networks/current-match', adminCookie, { method: 'POST', body: JSON.stringify({ ssid: 'Guest-WiFi' }) });
  assert.equal((await unknownAdminWifi.json()).currentDevice.officeNetworkStatus, 'not_matched');
  const currentAdminWifiRestored = await api('/admin/office-networks/current-match', adminCookie, { method: 'POST', body: JSON.stringify({ ssid: 'Northstar-Office' }) });
  assert.equal((await currentAdminWifiRestored.json()).currentDevice.officeNetworkStatus, 'matched');
  assert.equal((await (await api('/admin/policies', adminCookie)).json()).cameraEnabled, false);
  const created = await api('/admin/employees', adminCookie, { method: 'POST', body: JSON.stringify(employeePayload) });
  assert.equal(created.status, 201);
  const duplicate = await api('/admin/employees', adminCookie, { method: 'POST', body: JSON.stringify(employeePayload) });
  assert.equal(duplicate.status, 409);
  const beforeLogin = await (await api('/admin/dashboard', adminCookie)).json();
  assert.equal(beforeLogin.kpis.absentToday, 1);
  assert.equal(beforeLogin.kpis.offline, 0);
  assert.equal((await api('/admin/dashboard?dayStart=invalid', adminCookie)).status, 400);

  const employeeLogin = await login(employeePayload.email, employeePayload.temporaryPassword);
  assert.equal(employeeLogin.response.status, 200);
  employeeCookie = employeeLogin.cookie;
  const employeeId = db.prepare('SELECT id FROM users WHERE email = ?').get(employeePayload.email).id;
  const utcDayStart = new Date();
  utcDayStart.setUTCHours(0, 0, 0, 0);
  const priorSessionStart = new Date(utcDayStart.getTime() - 2 * 60 * 60 * 1000).toISOString();
  const priorSessionEnd = new Date(utcDayStart.getTime() - 1000).toISOString();
  const priorSession = db.prepare(`INSERT INTO auth_sessions (token_hash, user_id, started_at, expires_at, ended_at, last_heartbeat_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run('ended-prior-day-test-session', employeeId, priorSessionStart, priorSessionEnd, priorSessionEnd, priorSessionEnd);
  db.prepare(`INSERT INTO activity_events (user_id, auth_session_id, previous_status, status, reason, occurred_at)
    VALUES (?, ?, 'unknown', 'available', 'test_prior_day_status', ?)`)
    .run(employeeId, priorSession.lastInsertRowid, new Date(utcDayStart.getTime() - 30 * 60 * 1000).toISOString());
  const applicationSwitchResponse = await api('/activity/application-switch', employeeCookie, { method: 'POST', body: JSON.stringify({
    previousApplication: 'Code', previousWindowTitle: 'main.js - Visual Studio Code', application: 'chrome', windowTitle: 'YouTube\n - Google Chrome'
  }) });
  assert.equal(applicationSwitchResponse.status, 201);
  const applicationSwitch = (await applicationSwitchResponse.json()).event;
  assert.equal(applicationSwitch.previousApplication, 'Code');
  assert.equal(applicationSwitch.windowTitle, 'YouTube - Google Chrome');
  const clientSessionId = '41b5d202-142c-4380-aa91-bfd56b11a400';
  const attendanceStart = await api('/employee/attendance/start', employeeCookie, { method: 'POST', body: JSON.stringify({ clientSessionId }) });
  assert.equal(attendanceStart.status, 201);
  const attendanceStartData = await attendanceStart.json();
  assert.equal(attendanceStartData.created, true);
  const duplicateAttendanceStart = await api('/employee/attendance/start', employeeCookie, { method: 'POST', body: JSON.stringify({ clientSessionId }) });
  assert.deepEqual(await duplicateAttendanceStart.json(), { startedAt: attendanceStartData.startedAt, created: false });
  assert.equal((await api('/employee/attendance/start', employeeCookie, { method: 'POST', body: JSON.stringify({ clientSessionId: 'invalid' }) })).status, 400);
  const employeeDashboardAtLogin = await (await api('/employee/dashboard', employeeCookie)).json();
  assert.equal(employeeDashboardAtLogin.attendanceStartedAt, attendanceStartData.startedAt);
  assert.equal(employeeDashboardAtLogin.availableInteractionMs, 0);
  assert.equal(employeeDashboardAtLogin.awayDurationMs, 0);
  assert.equal(employeeDashboardAtLogin.applicationSwitches[0].application, 'chrome');
  const priorDayDashboard = await (await api(`/employee/dashboard?dayStart=${encodeURIComponent(new Date(utcDayStart.getTime() - 60 * 60 * 1000).toISOString())}`, employeeCookie)).json();
  assert.ok(priorDayDashboard.events.some((event) => event.occurredAt === new Date(utcDayStart.getTime() - 30 * 60 * 1000).toISOString()));
  assert.equal((await api('/employee/dashboard?dayStart=invalid', employeeCookie)).status, 400);
  assert.equal((await (await api('/employee/activity', employeeCookie)).json()).applicationSwitches.length, 1);
  const afterLogin = await (await api('/admin/dashboard', adminCookie)).json();
  assert.equal(afterLogin.kpis.presentToday, 1);
  assert.equal(afterLogin.kpis.absentToday, 0);
  assert.equal(afterLogin.kpis.offline, 1);
  assert.equal(afterLogin.kpis.activeInteractionMs, 0);
  assert.equal((await (await api('/admin/dashboard', employeeCookie)).json().catch(() => ({}))).error, 'Administrator access required');
  assert.equal((await api('/admin/dashboard', employeeCookie)).status, 403);
  assert.equal((await api('/admin/office-networks', employeeCookie)).status, 403);
  assert.equal((await api('/employee/dashboard', adminCookie)).status, 403);

  const transitionNotice = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Realtime status event timed out')), 3000);
    adminSocket.once('activity:transition', (event) => { clearTimeout(timeout); resolve(event); });
  });
  const heartbeatNotice = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Realtime heartbeat event timed out')), 3000);
    adminSocket.once('agent:heartbeat', (event) => { clearTimeout(timeout); resolve(event); });
  });
  const available = await api('/activity/heartbeat', employeeCookie, { method: 'POST', body: JSON.stringify({ idleSeconds: 0, networkSsid: 'Northstar-Office' }) });
  assert.equal(available.status, 200);
  assert.equal((await available.json()).status, 'available');
  assert.ok((await (await api('/employee/dashboard', employeeCookie)).json()).availableInteractionMs < 60_000);
  assert.ok((await (await api('/admin/dashboard', adminCookie)).json()).kpis.activeInteractionMs < 60_000);
  const realtimeEvent = await transitionNotice;
  assert.equal(realtimeEvent.status, 'available');
  assert.equal(realtimeEvent.userId > 0, true);
  assert.ok(Number.isFinite(Date.parse(realtimeEvent.occurredAt)));
  assert.ok(Number.isFinite(Date.parse((await heartbeatNotice).lastHeartbeatAt)));

  const availableDuplicate = await api('/activity/heartbeat', employeeCookie, { method: 'POST', body: JSON.stringify({ idleSeconds: 1, networkSsid: 'northstar-office' }) });
  assert.equal((await availableDuplicate.json()).status, 'available');
  const locked = await api('/activity/heartbeat', employeeCookie, { method: 'POST', body: JSON.stringify({ idleSeconds: 1, locked: true, networkSsid: 'Northstar-Office' }) });
  assert.equal((await locked.json()).status, 'away');
  const unlocked = await api('/activity/heartbeat', employeeCookie, { method: 'POST', body: JSON.stringify({ idleSeconds: 0, locked: false, networkSsid: 'Northstar-Office' }) });
  assert.equal((await unlocked.json()).status, 'available');
  const repetitive = await api('/activity/heartbeat', employeeCookie, { method: 'POST', body: JSON.stringify({ idleSeconds: 5, repetitiveInput: true }) });
  assert.equal((await repetitive.json()).status, 'away');
  const recovered = await api('/activity/heartbeat', employeeCookie, { method: 'POST', body: JSON.stringify({ idleSeconds: 0, repetitiveInput: false }) });
  assert.equal((await recovered.json()).status, 'available');
  const away = await api('/activity/heartbeat', employeeCookie, { method: 'POST', body: JSON.stringify({ idleSeconds: 60, networkSsid: 'Guest-WiFi' }) });
  assert.equal((await away.json()).status, 'away');
  const awayAgain = await api('/activity/heartbeat', employeeCookie, { method: 'POST', body: JSON.stringify({ idleSeconds: 90, networkSsid: 'Guest-WiFi' }) });
  assert.equal((await awayAgain.json()).officeNetworkStatus, 'not_matched');

  const timeline = await (await api('/employee/activity', employeeCookie)).json();
  assert.deepEqual(timeline.events.map((event) => event.status), ['away', 'available', 'away', 'available', 'away', 'available', 'unknown', 'available']);
  assert.equal(timeline.events[0].reason, 'os_idle_threshold');
  assert.equal(timeline.events[2].reason, 'repetitive_input_pattern');
  assert.equal(timeline.events[4].reason, 'screen_locked');
  assert.equal(timeline.events.at(-1).reason, 'test_prior_day_status');
  assert.ok(Number.isFinite(Date.parse(timeline.events[0].occurredAt)));
  const dayEnd = new Date(utcDayStart.getTime() + 86400000);
  const filteredTimeline = await (await api(`/employee/activity?from=${encodeURIComponent(utcDayStart.toISOString())}&to=${encodeURIComponent(dayEnd.toISOString())}`, employeeCookie)).json();
  assert.ok(filteredTimeline.events.length > 0);
  assert.ok(filteredTimeline.events.every((event) => Date.parse(event.occurredAt) >= utcDayStart.getTime() && Date.parse(event.occurredAt) < dayEnd.getTime()));
  assert.equal(filteredTimeline.applicationSwitches.length, 1);
  assert.equal((await api(`/employee/activity?from=${encodeURIComponent(utcDayStart.toISOString())}`, employeeCookie)).status, 400);
  const employeeDashboard = await (await api('/employee/dashboard', employeeCookie)).json();
  assert.equal(Date.parse(employeeDashboard.session.lastHeartbeatAt) - Date.parse(employeeDashboard.lastActivityAt), 90_000);

  const dashboard = await (await api('/admin/dashboard', adminCookie)).json();
  assert.equal(dashboard.kpis.away, 1);
  assert.equal(dashboard.employees[0].status, 'away');
  assert.equal(dashboard.employees[0].lastNetworkSsid, 'Guest-WiFi');
  assert.equal(dashboard.employees[0].officeNetworkStatus, 'not_matched');
  assert.equal((await api('/admin/reports', employeeCookie)).status, 403);
  assert.equal((await api('/employee/reports', adminCookie)).status, 403);
  const range = `?from=${encodeURIComponent(new Date(Date.now() - 3600000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 60000).toISOString())}`;
  const adminReport = await (await api(`/admin/reports${range}`, adminCookie)).json();
  assert.equal(adminReport.employees.length, 1);
  assert.equal(adminReport.employees[0].awaySessions, 3);
  const employeeReport = await (await api(`/employee/reports${range}`, employeeCookie)).json();
  assert.equal(employeeReport.report.awaySessions, 3);
  const csv = await api(`/admin/reports.csv${range}`, adminCookie);
  assert.equal(csv.headers.get('content-type').includes('text/csv'), true);
  assert.match(await csv.text(), /Available interaction minutes/);
  const policy = await api('/admin/policies', adminCookie, { method: 'PATCH', body: JSON.stringify({ idleThresholdSeconds: 90 }) });
  assert.equal(policy.status, 200);
  assert.equal((await (await api('/admin/policies', adminCookie)).json()).idleThresholdSeconds, 90);
  assert.equal((await api('/admin/policies', adminCookie, { method: 'PATCH', body: JSON.stringify({ idleThresholdSeconds: 3601 }) })).status, 400);
  const cameraEnable = await api('/admin/policies', adminCookie, { method: 'PATCH', body: JSON.stringify({ cameraEnabled: true }) });
  assert.equal(cameraEnable.status, 400);

  assert.equal((await api('/auth/logout', employeeCookie, { method: 'POST' })).status, 204);
  assert.equal((await api('/employee/dashboard', employeeCookie)).status, 401);
  const afterLogout = await (await api('/admin/dashboard', adminCookie)).json();
  assert.equal(afterLogout.kpis.presentToday, 1);
  assert.equal(afterLogout.kpis.absentToday, 0);
  assert.equal(afterLogout.kpis.offline, 1);
  const logoutEvents = db.prepare("SELECT status FROM activity_events WHERE user_id = (SELECT id FROM users WHERE email = 'morgan@example.test') ORDER BY id").all();
  assert.equal(logoutEvents.at(-1).status, 'offline');

  const managedEmployee = { ...employeePayload, fullName: 'Taylor Kim', email: 'taylor@example.test' };
  assert.equal((await api('/admin/employees', adminCookie, { method: 'POST', body: JSON.stringify(managedEmployee) })).status, 201);
  const managedLogin = await login(managedEmployee.email, managedEmployee.temporaryPassword);
  const managedId = db.prepare('SELECT id FROM users WHERE email = ?').get(managedEmployee.email).id;
  const deactivated = await api(`/admin/employees/${managedId}`, adminCookie, { method: 'PATCH', body: JSON.stringify({ active: false }) });
  assert.equal(deactivated.status, 200);
  assert.equal((await api('/employee/dashboard', managedLogin.cookie)).status, 401);
  const terminatedSession = db.prepare('SELECT ended_at AS endedAt FROM auth_sessions WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(managedId);
  assert.ok(terminatedSession.endedAt);
  const deactivationEvent = db.prepare('SELECT reason FROM activity_events WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(managedId);
  assert.equal(deactivationEvent.reason, 'account_deactivated');
  assert.equal((await api(`/admin/employees/${managedId}`, adminCookie, { method: 'PATCH', body: JSON.stringify({ active: true }) })).status, 200);
  assert.equal((await api('/employee/dashboard', managedLogin.cookie)).status, 401);
  assert.equal((await login(managedEmployee.email, managedEmployee.temporaryPassword)).response.status, 200);
  assert.equal((await api(`/admin/office-networks/${networkId}`, adminCookie, { method: 'DELETE' })).status, 204);
  const noApprovedNetworks = await (await api('/admin/office-networks', adminCookie)).json();
  assert.equal(noApprovedNetworks.networks.length, 0);
  assert.equal(noApprovedNetworks.currentDevice.officeNetworkStatus, 'not_configured');
  assert.equal((await (await api('/admin/policies', adminCookie)).json()).cameraEnabled, false);
});

test('a long heartbeat gap stops carried-forward dashboard duration after the stale timeout', async () => {
  const employee = { fullName: 'Stale Session Employee', email: 'stale-session@example.test', temporaryPassword: 'Temporary-password-42!' };
  const created = await api('/admin/employees', adminCookie, { method: 'POST', body: JSON.stringify(employee) });
  assert.equal(created.status, 201);
  const employeeLogin = await login(employee.email, employee.temporaryPassword);
  assert.equal(employeeLogin.response.status, 200);
  const userId = db.prepare('SELECT id FROM users WHERE email = ?').get(employee.email).id;
  const session = db.prepare('SELECT id FROM auth_sessions WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId);
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const oldHeartbeat = new Date(dayStart.getTime() - 5 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE auth_sessions SET started_at = ?, last_heartbeat_at = ? WHERE id = ?')
    .run(oldHeartbeat, oldHeartbeat, session.id);
  db.prepare(`UPDATE activity_events SET previous_status = 'unknown', status = 'available', reason = 'test_stale_available', occurred_at = ?
    WHERE auth_session_id = ?`).run(oldHeartbeat, session.id);

  const heartbeat = await api('/activity/heartbeat', employeeLogin.cookie, {
    method: 'POST',
    body: JSON.stringify({ idleSeconds: 0 })
  });
  assert.equal((await heartbeat.json()).status, 'available');
  const offlineEvent = db.prepare(`SELECT occurred_at AS occurredAt FROM activity_events
    WHERE auth_session_id = ? AND reason = 'heartbeat_timeout' ORDER BY occurred_at DESC, id DESC LIMIT 1`).get(session.id);
  assert.equal(offlineEvent.occurredAt, new Date(Date.parse(oldHeartbeat) + 45_000).toISOString());
  const dashboard = await (await api(`/employee/dashboard?dayStart=${encodeURIComponent(dayStart.toISOString())}`, employeeLogin.cookie)).json();
  assert.ok(dashboard.availableInteractionMs < 60_000);
  assert.equal(dashboard.awayDurationMs, 0);
  await api('/auth/logout', employeeLogin.cookie, { method: 'POST' });
});
