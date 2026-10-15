import { createActivityTracker } from './activity-tracker.js';

const app = document.querySelector('#app');
const loginScreen = document.querySelector('#login-screen');
const workspace = document.querySelector('#workspace');
const pageContent = document.querySelector('#page-content');
const navElement = document.querySelector('#navigation');
const state = { user: null, view: 'dashboard', socket: null, employees: [], search: '', activityTracker: null, activityTimer: null, activityHandlers: null, activityHeartbeatInFlight: false, activityStatus: 'unknown', attendanceClientSessionId: null };
const adminNav = [['dashboard', 'Overview', '▦'], ['employees', 'Employees', '♧'], ['reports', 'Reports', '▤'], ['policies', 'Policies', '⚙'], ['audit', 'Audit log', '≡']];
const employeeNav = [['dashboard', 'My dashboard', '▦'], ['attendance', 'Attendance', '◷'], ['activity', 'Activity timeline', '≋'], ['reports', 'My reports', '▤'], ['profile', 'My profile', '○']];
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function toast(message) {
  let element = document.querySelector('#toast');
  if (!element) { element = document.createElement('div'); element.id = 'toast'; element.setAttribute('role', 'status'); document.body.append(element); }
  element.textContent = message;
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => element.remove(), 3200);
}
function statusPill(status) {
  const safeStatus = ['available', 'away', 'offline', 'unknown'].includes(status) ? status : 'unknown';
  return `<span class="pill pill-${safeStatus}">${safeStatus}</span>`;
}
function formatTime(value) {
  if (!value) return 'Not reported';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}
function formatDuration(milliseconds) {
  const minutes = Math.floor(Math.max(0, Number(milliseconds) || 0) / 60000);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function officeNetworkStatusLabel(status) {
  return ({ matched: 'Approved Wi-Fi', not_matched: 'Not approved', not_configured: 'Allowlist empty', unknown: 'Not reported' })[status] || 'Unknown';
}
function showAwayStatusPopup() {
  if (document.querySelector('#activity-status-popup')) return;
  const popup = document.createElement('section');
  popup.id = 'activity-status-popup';
  popup.setAttribute('role', 'alert');
  popup.setAttribute('aria-live', 'assertive');
  const heading = document.createElement('strong');
  heading.textContent = 'You are marked Away';
  const message = document.createElement('p');
  message.textContent = 'Meaningful activity in this tab will return your status to Available.';
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = 'Dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss Away status message');
  dismiss.addEventListener('click', () => popup.remove());
  popup.append(heading, message, dismiss);
  document.body.append(popup);
}
function setEmployeeActivityStatus(status) {
  const previousStatus = state.activityStatus;
  state.activityStatus = status;
  if (status === 'away' && previousStatus !== 'away') showAwayStatusPopup();
  else if (status === 'available') {
    document.querySelector('#activity-status-popup')?.remove();
    if (previousStatus === 'away') toast('Your status is now Available');
  } else if (status === 'offline' || status === 'unknown') {
    document.querySelector('#activity-status-popup')?.remove();
  }
  if (previousStatus !== status && state.view === 'dashboard') loadView();
}
function getActivityTarget(event) {
  const target = event.target;
  return target instanceof Element ? target.closest('button, a, input, select, textarea, [role="button"]') || target : target;
}
function combineTimelineEvents(statusEvents, applicationSwitches = []) {
  return [
    ...statusEvents.map((event) => ({ ...event, timelineType: 'status' })),
    ...applicationSwitches.map((event) => ({ ...event, timelineType: 'application' }))
  ].sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt));
}
function describeApplicationSwitch(event) {
  const from = event.previousApplication
    ? `${event.previousApplication}${event.previousWindowTitle ? ` [${event.previousWindowTitle}]` : ''}`
    : null;
  const to = `${event.application}${event.windowTitle ? ` [${event.windowTitle}]` : ''}`;
  return from ? `Switched from ${from} to ${to}` : `Active window: ${to}`;
}
function renderTimelineRow(event, detailed = false) {
  const description = event.timelineType === 'application'
    ? escapeHtml(describeApplicationSwitch(event))
    : detailed
      ? `${escapeHtml(event.reason)} · <strong>${escapeHtml(event.previousStatus)} → ${escapeHtml(event.status)}</strong>`
      : `Changed to <strong>${escapeHtml(event.status)}</strong>`;
  const rowType = event.timelineType === 'application' ? 'event-row-application' : '';
  return `<div class="event-row ${rowType}"><time class="event-time">${formatTime(event.occurredAt)}</time><span class="event-marker"></span><span class="event-description">${description}</span></div>`;
}
function renderNavigation() {
  const nav = state.user.role === 'admin' ? adminNav : employeeNav;
  navElement.innerHTML = nav.map(([id, label, icon]) => `<button class="nav-item ${state.view === id ? 'active' : ''}" data-view="${id}"><span class="nav-icon" aria-hidden="true">${icon}</span>${label}</button>`).join('');
  navElement.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.view)));
}
function showWorkspace() {
  loginScreen.classList.add('hidden');
  workspace.classList.remove('hidden');
  document.querySelector('#user-name').textContent = state.user.fullName;
  document.querySelector('#user-role').textContent = state.user.role;
  document.querySelector('#user-avatar').textContent = state.user.fullName.slice(0, 1).toUpperCase();
  renderNavigation();
  loadView();
  if (window.io) {
    state.socket?.disconnect();
    state.socket = window.io();
    const setConnection = (connected) => {
      document.querySelector('[data-service-indicator]')?.classList.toggle('online', connected);
      const label = document.querySelector('[data-service-label]');
      if (label) label.textContent = connected ? 'Service connected' : 'Reconnecting';
    };
    state.socket.on('connect', () => setConnection(true));
    state.socket.on('disconnect', () => setConnection(false));
    state.socket.on('activity:transition', (event) => {
      if (state.user.role === 'admin') toast(`${event.status} status updated`);
      if (state.user.role === 'employee' && event.userId === state.user.id) setEmployeeActivityStatus(event.status);
      if (state.view === 'dashboard') loadView();
    });
    state.socket.on('agent:stale', () => { if (state.view === 'dashboard') loadView(); });
    state.socket.on('application:switch', (event) => {
      if (state.user.role === 'employee' && event.userId === state.user.id && ['dashboard', 'activity'].includes(state.view)) loadView();
    });
    state.socket.on('agent:heartbeat', (event) => {
      if (state.user.role !== 'admin') return;
      const heartbeat = document.querySelector(`[data-employee-heartbeat="${event.userId}"]`);
      if (heartbeat) heartbeat.textContent = formatTime(event.lastHeartbeatAt);
      const network = document.querySelector(`[data-employee-network="${event.userId}"]`);
      if (network) network.textContent = event.networkSsid ? `${event.networkSsid} · ${officeNetworkStatusLabel(event.officeNetworkStatus)}` : officeNetworkStatusLabel(event.officeNetworkStatus);
    });
    state.socket.on('office-network:device', (device) => {
      if (state.user.role !== 'admin') return;
      const current = document.querySelector('#current-admin-network');
      if (current) current.textContent = device.ssid ? `${device.ssid} · ${officeNetworkStatusLabel(device.officeNetworkStatus)}` : officeNetworkStatusLabel(device.officeNetworkStatus);
      const cameraNetworkStatus = document.querySelector('#camera-network-status');
      if (cameraNetworkStatus) cameraNetworkStatus.textContent = officeNetworkStatusLabel(device.officeNetworkStatus);
    });
    state.socket.on('office-network:updated', () => { if (state.view === 'policies') renderPolicies(); });
    state.socket.on('office-network:removed', () => { if (state.view === 'policies') renderPolicies(); });
    state.socket.on('employee:created', () => { if (state.view === 'employees') loadEmployees(); });
    state.socket.on('employee:updated', () => { if (state.view === 'employees') loadEmployees(); });
  }
  if (state.user.role === 'employee') startBrowserActivityMonitor();
}
function startBrowserActivityMonitor() {
  if (state.activityTimer || state.activityTracker) return;
  state.activityStatus = 'unknown';
  const storageKey = `biw-attendance-session-${state.user.id}`;
  state.attendanceClientSessionId = sessionStorage.getItem(storageKey) || crypto.randomUUID();
  sessionStorage.setItem(storageKey, state.attendanceClientSessionId);
  const tracker = createActivityTracker();
  state.activityTracker = tracker;
  let attendanceReady = false;
  const onPointerMove = (event) => tracker.notePointerMove(event.clientX, event.clientY);
  const onPointerDown = (event) => tracker.notePointerDown(getActivityTarget(event));
  const onPointerUp = (event) => tracker.notePointerUp(getActivityTarget(event));
  const onClick = (event) => tracker.noteClick(getActivityTarget(event));
  const onKeyDown = (event) => { if (!event.repeat) tracker.noteKeyboardActivity(); };
  const onScroll = () => tracker.noteKeyboardActivity();
  document.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', onScroll, { passive: true });
  state.activityHandlers = { onClick, onKeyDown, onPointerDown, onPointerMove, onPointerUp, onScroll };
  const report = async () => {
    if (!attendanceReady || state.activityHeartbeatInFlight || !state.activityTracker) return;
    state.activityHeartbeatInFlight = true;
    try {
      const activity = tracker.getState();
      const result = await api('/activity/heartbeat', { method: 'POST', body: JSON.stringify({ ...activity, locked: false }) });
      setEmployeeActivityStatus(result.status);
    } catch {
      setEmployeeActivityStatus('unknown');
    } finally {
      state.activityHeartbeatInFlight = false;
    }
  };
  const startAttendance = async () => {
    try {
      await api('/employee/attendance/start', { method: 'POST', body: JSON.stringify({ clientSessionId: state.attendanceClientSessionId }) });
    } catch {}
    attendanceReady = true;
    if (state.view === 'dashboard') loadView();
    void report();
  };
  void startAttendance();
  state.activityTimer = window.setInterval(report, 5000);
}
function stopBrowserActivityMonitor() {
  if (state.activityTimer) window.clearInterval(state.activityTimer);
  state.activityTimer = null;
  state.activityTracker = null;
  state.activityStatus = 'unknown';
  document.querySelector('#activity-status-popup')?.remove();
  if (!state.activityHandlers) return;
  document.removeEventListener('pointermove', state.activityHandlers.onPointerMove);
  document.removeEventListener('pointerdown', state.activityHandlers.onPointerDown, true);
  document.removeEventListener('pointerup', state.activityHandlers.onPointerUp, true);
  document.removeEventListener('click', state.activityHandlers.onClick, true);
  document.removeEventListener('keydown', state.activityHandlers.onKeyDown, true);
  window.removeEventListener('scroll', state.activityHandlers.onScroll);
  state.activityHandlers = null;
}
function navigate(view) { state.view = view; renderNavigation(); loadView(); }
async function loadView() {
  const titles = { dashboard: 'Dashboard', employees: 'Employees', policies: 'Policies', audit: 'Audit log', reports: 'Reports', attendance: 'Attendance', activity: 'Activity timeline', profile: 'My profile' };
  const title = titles[state.view] || 'Dashboard';
  document.querySelector('#page-title').textContent = title;
  document.querySelector('#top-eyebrow').textContent = state.user.role === 'admin' ? 'ADMINISTRATION' : 'MY WORKSPACE';
  pageContent.innerHTML = '<div class="empty-state">Loading current records…</div>';
  try {
    if (state.view === 'dashboard') state.user.role === 'admin' ? await renderAdminDashboard() : await renderEmployeeDashboard();
    else if (state.view === 'employees') await renderEmployees();
    else if (state.view === 'policies') await renderPolicies();
    else if (state.view === 'audit') await renderAudit();
    else if (state.view === 'reports') await renderReports();
    else if (state.view === 'attendance' || state.view === 'activity') await renderEmployeeEvents();
    else if (state.view === 'profile') await renderProfile();
  } catch (error) { pageContent.innerHTML = `<div class="notice">${escapeHtml(error.message)}</div>`; }
}
async function renderAdminDashboard() {
  const { kpis, employees } = await api('/admin/dashboard');
  const cards = [['Total employees', kpis.totalEmployees], ['Present today', kpis.presentToday], ['Available now', kpis.available], ['Away now', kpis.away], ['Offline / unknown', kpis.offline], ['Absent today', kpis.absentToday], ['Available interaction today', formatDuration(kpis.activeInteractionMs)], ['Away duration today', formatDuration(kpis.awayMs)]];
  pageContent.innerHTML = `<div class="page-heading"><div><h2>Team overview</h2><p>Current session and device status, based on the latest server event.</p></div><div class="connection"><span class="status-dot online"></span> Live connection</div></div>
    <div class="kpi-grid">${cards.map(([label, value]) => `<article class="kpi"><div class="kpi-label">${label}</div><strong class="kpi-number">${value}</strong>${label.includes('interaction') || label.includes('duration') ? '<div class="kpi-sub">Not verified productive work</div>' : ''}</article>`).join('')}</div>
    <section class="panel"><div class="panel-header"><div><h3>Live employee status</h3><p>Unknown is kept separate from confirmed Available and Away status.</p></div><div class="filters"><input id="dashboard-search" type="search" aria-label="Search employees" placeholder="Search name or email"></div></div><div class="table-wrap"><table><thead><tr><th>Employee</th><th>Department</th><th>Status</th><th>Last heartbeat</th><th>Reported Wi-Fi</th></tr></thead><tbody id="dashboard-rows"></tbody></table></div></section>`;
  const search = document.querySelector('#dashboard-search');
  const draw = () => {
    const term = search.value.trim().toLowerCase();
    const filtered = employees.filter((employee) => `${employee.fullName} ${employee.email}`.toLowerCase().includes(term));
    document.querySelector('#dashboard-rows').innerHTML = filtered.length ? filtered.map((employee) => `<tr><td><div class="person"><span class="avatar">${escapeHtml(employee.fullName.slice(0, 1).toUpperCase())}</span><div><div class="person-name">${escapeHtml(employee.fullName)}</div><div class="person-email">${escapeHtml(employee.email)}</div></div></div></td><td>${escapeHtml(employee.department || '—')}</td><td>${statusPill(employee.status)}</td><td data-employee-heartbeat="${employee.id}">${formatTime(employee.lastHeartbeat)}</td><td data-employee-network="${employee.id}">${employee.lastNetworkSsid ? `${escapeHtml(employee.lastNetworkSsid)} · ${officeNetworkStatusLabel(employee.officeNetworkStatus)}` : officeNetworkStatusLabel(employee.officeNetworkStatus)}</td></tr>`).join('') : '<tr><td colspan="5" class="empty-state">No employees match this search.</td></tr>';
  };
  search.addEventListener('input', draw);
  draw();
}
async function renderEmployeeDashboard() {
  const data = await api('/employee/dashboard');
  const events = combineTimelineEvents(data.events, data.applicationSwitches || []).slice(0, 200);
  pageContent.innerHTML = `<div class="page-heading"><div><h2>Your day at a glance</h2><p>Attendance and interaction signals are shown separately from productive work.</p></div><div class="connection"><span class="status-dot online"></span> Signed in</div></div>
    <div class="status-hero"><div><p class="eyebrow">CURRENT DEVICE STATUS</p><h2>${escapeHtml(data.status)}</h2><p class="muted">Last activity signal: ${formatTime(data.lastActivityAt)}</p></div><span class="status-orb" aria-hidden="true">◉</span></div>
    <div class="two-column" style="margin-top:15px"><section><div class="metric-list"><div class="metric-row"><span>Website login time</span><strong>${formatTime(data.attendanceStartedAt || data.session.startedAt)}</strong></div><div class="metric-row"><span>First available</span><strong>${formatTime(data.firstAvailableAt)}</strong></div><div class="metric-row"><span>Away sessions today</span><strong>${data.awaySessions}</strong></div><div class="metric-row"><span>Available interaction</span><strong>${formatDuration(data.availableInteractionMs)}</strong></div><div class="metric-row"><span>Away duration</span><strong>${formatDuration(data.awayDurationMs)}</strong></div></div><div class="notice" style="margin-top:14px">The Windows desktop agent records foreground app and window-title changes; titles may reveal webpage or document names. Browser status uses activity in this tab only. No typed content, raw coordinates, or click targets are sent or persisted. Available time is not verified work time.</div></section>
    <section class="panel timeline-panel"><div class="panel-header"><div><h3>Today's timeline</h3><p>Status and foreground app changes</p></div></div><div class="panel-body"><div class="event-list">${events.length ? events.map((event) => renderTimelineRow(event)).join('') : '<div class="empty-state">No activity recorded yet.</div>'}</div></div></section></div>`;
}
async function loadEmployees() {
  const data = await api(`/admin/employees?search=${encodeURIComponent(state.search)}`);
  state.employees = data.employees;
  drawEmployeeRows();
}
function drawEmployeeRows() {
  const tbody = document.querySelector('#employee-rows');
  if (!tbody) return;
  tbody.innerHTML = state.employees.length ? state.employees.map((employee) => `<tr><td><div class="person"><span class="avatar">${escapeHtml(employee.fullName.slice(0, 1).toUpperCase())}</span><div><div class="person-name">${escapeHtml(employee.fullName)}</div><div class="person-email">${escapeHtml(employee.email)}</div></div></div></td><td>${escapeHtml(employee.department || '—')}</td><td>${escapeHtml(employee.designation || '—')}</td><td>${employee.active ? 'Active' : 'Deactivated'}</td><td><button class="button button-secondary table-action" data-account-toggle="${employee.id}" data-active="${employee.active ? 'true' : 'false'}">${employee.active ? 'Deactivate' : 'Reactivate'}</button></td></tr>`).join('') : '<tr><td colspan="5" class="empty-state">No employee accounts found.</td></tr>';
  tbody.querySelectorAll('[data-account-toggle]').forEach((button) => button.addEventListener('click', async () => {
    const active = button.dataset.active === 'true';
    if (active && !window.confirm('Deactivate this account and end its active sessions?')) return;
    try {
      await api(`/admin/employees/${button.dataset.accountToggle}`, { method: 'PATCH', body: JSON.stringify({ active: !active }) });
      toast(active ? 'Employee deactivated' : 'Employee reactivated');
      await loadEmployees();
    } catch (error) { toast(error.message); }
  }));
}
async function renderEmployees() {
  pageContent.innerHTML = `<div class="page-heading"><div><h2>Employee directory</h2><p>Create and manage employee accounts. Passwords are stored only as hashes.</p></div><button id="add-employee-toggle" class="button button-primary">Add employee</button></div>
    <section id="employee-form-panel" class="panel hidden" style="margin-bottom:16px"><div class="panel-header"><div><h3>New employee account</h3><p>Use a temporary password and deliver it securely to the employee.</p></div></div><div class="panel-body"><form id="employee-form"><div class="form-grid"><div class="field"><label for="new-name">Full name</label><input id="new-name" name="fullName" required minlength="2" maxlength="120"></div><div class="field"><label for="new-email">Work email</label><input id="new-email" name="email" type="email" required maxlength="254"></div><div class="field"><label for="new-department">Department</label><input id="new-department" name="department" maxlength="100"></div><div class="field"><label for="new-designation">Designation</label><input id="new-designation" name="designation" maxlength="100"></div><div class="field"><label for="new-password">Temporary password</label><input id="new-password" name="temporaryPassword" type="password" required minlength="12" autocomplete="new-password"></div></div><p class="form-error" id="employee-error" role="alert"></p><button class="button button-primary" type="submit">Create account</button></form></div></section>
    <section class="panel"><div class="panel-header"><h3>Employees</h3><div class="filters"><input id="employee-search" type="search" placeholder="Search employees" aria-label="Search employees"></div></div><div class="table-wrap"><table><thead><tr><th>Employee</th><th>Department</th><th>Designation</th><th>Account</th><th>Actions</th></tr></thead><tbody id="employee-rows"></tbody></table></div></section>`;
  document.querySelector('#add-employee-toggle').addEventListener('click', () => document.querySelector('#employee-form-panel').classList.toggle('hidden'));
  document.querySelector('#employee-search').addEventListener('input', (event) => { state.search = event.target.value; loadEmployees().catch((error) => toast(error.message)); });
  document.querySelector('#employee-form').addEventListener('submit', createEmployee);
  await loadEmployees();
}
async function createEmployee(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const payload = Object.fromEntries(form.entries());
  const errorElement = document.querySelector('#employee-error');
  errorElement.textContent = '';
  try {
    await api('/admin/employees', { method: 'POST', body: JSON.stringify(payload) });
    formElement.reset();
    document.querySelector('#employee-form-panel').classList.add('hidden');
    toast('Employee account created');
    await loadEmployees();
  } catch (error) { errorElement.textContent = error.message; }
}
async function renderPolicies() {
  const [policy, networkData] = await Promise.all([api('/admin/policies'), api('/admin/office-networks')]);
  const current = networkData.currentDevice || {};
  const approvedRows = networkData.networks.length ? networkData.networks.map((network) => `<tr><td>${escapeHtml(network.label)}</td><td>${escapeHtml(network.ssid)}</td><td>${network.active ? 'Active' : 'Inactive'}</td><td><button class="button button-secondary table-action" type="button" data-remove-network="${network.id}">Remove</button></td></tr>`).join('') : '<tr><td colspan="4" class="empty-state">No approved Wi-Fi networks. Add the office SSID to enable matching.</td></tr>';
  pageContent.innerHTML = `<div class="page-heading"><div><h2>Monitoring policy</h2><p>Changes are audited and take effect for subsequent device reports.</p></div></div>
    <section class="panel"><div class="panel-header"><div><h3>Availability detection</h3><p>Uses only an idle duration reported by the employee's desktop agent.</p></div></div><div class="panel-body"><form id="policy-form"><div class="policy-row"><div><strong>Idle threshold</strong><p>After this interval without OS-reported input, status changes to Away.</p></div><div class="threshold-input"><input name="idleThresholdValue" type="number" min="1" max="60" step="1" required aria-label="Idle threshold value"><select name="idleThresholdUnit" aria-label="Idle threshold unit"><option value="minutes">Minutes</option><option value="seconds">Seconds</option></select></div></div><div class="policy-row"><div><strong>Camera access</strong><p>Camera capture is not implemented and remains disabled. Office Wi-Fi match: <span id="camera-network-status">${officeNetworkStatusLabel(current.officeNetworkStatus)}</span>. A match does not grant camera permission.</p></div><span class="policy-value">Disabled</span></div><div class="policy-actions"><button class="button button-primary" type="submit">Save idle policy</button><span class="muted" id="policy-result" role="status"></span></div></form></div></section>
    <section class="panel network-policy-panel"><div class="panel-header"><div><h3>Office Wi-Fi verification</h3><p>The Windows desktop agent reports its connected SSID. A match is informational, not proof of identity.</p></div></div><div class="panel-body"><div class="policy-row current-network"><div><strong>This Admin device</strong><p>Last checked: ${formatTime(current.checkedAt)}</p></div><span class="policy-value" id="current-admin-network">${current.ssid ? `${escapeHtml(current.ssid)} · ${officeNetworkStatusLabel(current.officeNetworkStatus)}` : officeNetworkStatusLabel(current.officeNetworkStatus)}</span></div><form id="office-network-form" class="network-form"><div class="form-grid"><div class="field"><label for="network-label">Network label</label><input id="network-label" name="label" required maxlength="80" placeholder="Office Wi-Fi"></div><div class="field"><label for="network-ssid">Wi-Fi name (SSID)</label><input id="network-ssid" name="ssid" required maxlength="32" placeholder="Exact Windows network name" value="${escapeHtml(current.ssid || '')}"></div></div><p class="form-error" id="network-error" role="alert"></p><button class="button button-primary" type="submit">Approve Wi-Fi</button></form><div class="table-wrap network-table"><table><thead><tr><th>Label</th><th>Wi-Fi SSID</th><th>Status</th><th>Action</th></tr></thead><tbody id="approved-network-rows">${approvedRows}</tbody></table></div><p class="network-caveat">Browser-only sessions cannot report Wi-Fi. SSID matching can be spoofed and does not enable camera access. Add an organization-managed network verification method before relying on this for access control.</p></div></section>`;
  const form = document.querySelector('#policy-form');
  const thresholdInMinutes = policy.idleThresholdSeconds % 60 === 0;
  form.elements.idleThresholdUnit.value = thresholdInMinutes ? 'minutes' : 'seconds';
  form.elements.idleThresholdValue.value = thresholdInMinutes ? policy.idleThresholdSeconds / 60 : policy.idleThresholdSeconds;
  form.elements.idleThresholdValue.max = thresholdInMinutes ? 60 : 3600;
  form.elements.idleThresholdUnit.addEventListener('change', () => {
    form.elements.idleThresholdValue.max = form.elements.idleThresholdUnit.value === 'minutes' ? 60 : 3600;
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const multiplier = form.elements.idleThresholdUnit.value === 'minutes' ? 60 : 1;
    try { await api('/admin/policies', { method: 'PATCH', body: JSON.stringify({ idleThresholdSeconds: Number(form.elements.idleThresholdValue.value) * multiplier }) }); document.querySelector('#policy-result').textContent = 'Saved'; }
    catch (error) { document.querySelector('#policy-result').textContent = error.message; }
  });
  document.querySelector('#office-network-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      await api('/admin/office-networks', { method: 'POST', body: JSON.stringify(values) });
      await renderPolicies();
      toast('Approved Wi-Fi added');
    } catch (error) { document.querySelector('#network-error').textContent = error.message; }
  });
  document.querySelectorAll('[data-remove-network]').forEach((button) => button.addEventListener('click', async () => {
    if (!window.confirm('Remove this approved Wi-Fi network?')) return;
    try {
      await api(`/admin/office-networks/${button.dataset.removeNetwork}`, { method: 'DELETE' });
      await renderPolicies();
      toast('Approved Wi-Fi removed');
    } catch (error) { toast(error.message); }
  }));
}
async function renderAudit() {
  const { logs } = await api('/admin/audit-logs');
  pageContent.innerHTML = `<div class="page-heading"><div><h2>Administrative activity</h2><p>Privileged account and policy changes.</p></div></div><section class="panel"><div class="table-wrap"><table><thead><tr><th>Time</th><th>Administrator</th><th>Action</th><th>Details</th></tr></thead><tbody>${logs.length ? logs.map((log) => `<tr><td>${formatTime(log.occurredAt)}</td><td>${escapeHtml(log.actorName || 'System')}</td><td>${escapeHtml(log.action)}</td><td>${escapeHtml(log.details)}</td></tr>`).join('') : '<tr><td colspan="4" class="empty-state">No audit events recorded.</td></tr>'}</tbody></table></div></section>`;
}
async function renderReports() {
  const admin = state.user.role === 'admin';
  const report = await api(admin ? '/admin/reports' : '/employee/reports');
  const downloadPath = admin ? '/admin/reports.csv' : '/employee/reports.csv';
  const rows = admin ? report.employees.map((employee) => `<tr><td>${escapeHtml(employee.fullName)}</td><td>${escapeHtml(employee.email)}</td><td>${formatDuration(employee.availableMs)}</td><td>${formatDuration(employee.awayMs)}</td><td>${employee.awaySessions}</td></tr>`).join('') : `<tr><td>${formatDuration(report.report.availableMs)}</td><td>${formatDuration(report.report.awayMs)}</td><td>${report.report.awaySessions}</td></tr>`;
  pageContent.innerHTML = `<div class="page-heading"><div><h2>${admin ? 'Team activity report' : 'Your activity report'}</h2><p>${escapeHtml(report.note)} Period: ${new Date(report.range.start).toLocaleDateString()} to ${new Date(report.range.end).toLocaleDateString()}.</p></div><button id="download-report" class="button button-secondary">Download CSV</button></div><section class="panel"><div class="table-wrap"><table><thead><tr>${admin ? '<th>Employee</th><th>Email</th>' : ''}<th>Available interaction</th><th>Away duration</th><th>Away sessions</th></tr></thead><tbody>${rows || `<tr><td colspan="${admin ? 5 : 3}" class="empty-state">No report rows for this period.</td></tr>`}</tbody></table></div></section>`;
  document.querySelector('#download-report').addEventListener('click', async () => {
    try {
      const response = await fetch(`/api${downloadPath}`, { credentials: 'same-origin' });
      if (!response.ok) throw new Error('Report download failed');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = admin ? 'employee-activity-report.csv' : 'my-activity-report.csv';
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) { toast(error.message); }
  });
}
async function renderEmployeeEvents() {
  const path = state.view === 'attendance' ? '/employee/attendance' : '/employee/activity';
  const { events: statusEvents, applicationSwitches = [], note } = await api(path);
  const events = combineTimelineEvents(statusEvents, state.view === 'activity' ? applicationSwitches : []).slice(0, 500);
  pageContent.innerHTML = `<div class="page-heading"><div><h2>${state.view === 'attendance' ? 'Attendance events' : 'Personal activity timeline'}</h2><p>Only your account's records are available in this view.</p></div></div>${note ? `<div class="notice" style="margin-bottom:14px">${escapeHtml(note)}</div>` : ''}<section class="panel timeline-panel"><div class="panel-header"><h3>Recorded activity</h3></div><div class="panel-body"><div class="event-list">${events.length ? events.map((event) => renderTimelineRow(event, true)).join('') : '<div class="empty-state">There are no recorded events yet.</div>'}</div></div></section>`;
}
async function renderProfile() {
  const { user } = await api('/employee/profile');
  pageContent.innerHTML = `<div class="page-heading"><div><h2>Your profile</h2><p>Profile details are managed by your administrator.</p></div></div><section class="panel"><div class="panel-body"><div class="metric-list"><div class="metric-row"><span>Full name</span><strong>${escapeHtml(user.fullName)}</strong></div><div class="metric-row"><span>Work email</span><strong>${escapeHtml(user.email)}</strong></div><div class="metric-row"><span>Department</span><strong>${escapeHtml(user.department || '—')}</strong></div><div class="metric-row"><span>Designation</span><strong>${escapeHtml(user.designation || '—')}</strong></div></div></div></section>`;
}
document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const error = document.querySelector('#login-error');
  error.textContent = '';
  try {
    const { user } = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) });
    state.user = user;
    state.view = 'dashboard';
    showWorkspace();
  } catch (reason) { error.textContent = reason.message; }
});
document.querySelector('#logout-button').addEventListener('click', async () => {
  try { await api('/auth/logout', { method: 'POST' }); } finally { stopBrowserActivityMonitor(); state.socket?.disconnect(); state.user = null; workspace.classList.add('hidden'); loginScreen.classList.remove('hidden'); document.querySelector('#login-form').reset(); }
});
try {
  const { user } = await api('/auth/me');
  state.user = user;
  showWorkspace();
} catch { app.classList.remove('loading'); }
