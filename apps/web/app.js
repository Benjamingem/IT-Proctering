const app = document.querySelector('#app');
const loginScreen = document.querySelector('#login-screen');
const workspace = document.querySelector('#workspace');
const pageContent = document.querySelector('#page-content');
const navElement = document.querySelector('#navigation');
const state = { user: null, view: 'dashboard', socket: null, employees: [], search: '', activityTimer: null, dashboardRefreshTimer: null, dashboardMidnightTimer: null, activityHeartbeatInFlight: false, activityStatus: 'unknown', awayStartedAt: null, officeNetworkStatus: 'unknown', cameraPolicy: { enabled: false, requiresOfficeNetwork: true }, cameraConsent: false, cameraPromptDismissed: false, cameraAwayPeriodKey: null, cameraCaptureTimer: null, cameraCaptureInFlight: false, cameraCaptureAbortController: null, cameraStream: null };
const adminNav = [['dashboard', 'Overview', '▦'], ['employees', 'Employees', '♧'], ['reports', 'Reports', '▤'], ['policies', 'Policies', '⚙'], ['audit', 'Audit log', '≡']];
const employeeNav = [['dashboard', 'My dashboard', '▦'], ['attendance', 'Attendance', '◷'], ['activity', 'Activity timeline', '≋'], ['reports', 'My reports', '▤'], ['profile', 'My profile', '○']];
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function getPasswordStrength(value = '') {
  if (!value) return { score: 0, label: '' };
  const score = [
    value.length >= 12,
    /[a-z]/.test(value) && /[A-Z]/.test(value),
    /\d/.test(value),
    /[^A-Za-z0-9]/.test(value)
  ].filter(Boolean).length;
  const labels = ['', 'Weak', 'Fair', 'Good', 'Strong'];
  return { score, label: labels[score] };
}

function attachPasswordField(input) {
  if (!(input instanceof HTMLInputElement) || (input.type !== 'password' && input.type !== 'text')) return;
  if (input.dataset.passwordBound === 'true') return;
  const wrapper = input.closest('.password-input-wrap');
  if (!wrapper) return;
  input.dataset.passwordBound = 'true';
  const toggle = wrapper.querySelector('.password-toggle');
  const meter = wrapper.parentElement?.querySelector('.password-strength');
  const bar = meter?.querySelector('.password-meter');
  const label = meter?.querySelector('.password-strength-label');

  const updateMeter = () => {
    if (!meter || !bar || !label) return;
    const strength = getPasswordStrength(input.value);
    bar.dataset.score = String(strength.score);
    bar.setAttribute('aria-valuenow', String(strength.score));
    bar.setAttribute('aria-valuetext', strength.label || 'No password entered');
    label.textContent = strength.label;
  };

  if (toggle) {
    toggle.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      toggle.textContent = show ? '🙈' : '👁';
      toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      toggle.setAttribute('aria-pressed', String(show));
      input.focus();
    });
  }

  input.addEventListener('input', updateMeter);
  input.form?.addEventListener('reset', () => queueMicrotask(updateMeter));
  updateMeter();
}

function setupPasswordFields(root = document) {
  root.querySelectorAll('.password-input-wrap input').forEach((input) => attachPasswordField(input));
}

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
function getLocalDayStart() {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  return dayStart.toISOString();
}
function scheduleDayBoundaryRefresh() {
  window.clearTimeout(state.dashboardMidnightTimer);
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 0, 0);
  state.dashboardMidnightTimer = window.setTimeout(() => {
    state.dashboardMidnightTimer = null;
    if (['dashboard', 'attendance'].includes(state.view) && state.user) loadView();
  }, nextMidnight.getTime() - now.getTime());
}
function dashboardApiPath(path) {
  return `${path}?dayStart=${encodeURIComponent(getLocalDayStart())}`;
}
function formatDuration(milliseconds) {
  const minutes = Math.floor(Math.max(0, Number(milliseconds) || 0) / 60000);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}h ${String(minutes % 60).padStart(2, '0')}m`;
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
  message.textContent = 'Use your mouse or keyboard on this device to return your status to Available.';
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = 'Dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss Away status message');
  dismiss.addEventListener('click', () => popup.remove());
  popup.append(heading, message, dismiss);
  document.body.append(popup);
}
function stopAwayCamera(removePanel = true) {
  window.clearInterval(state.cameraCaptureTimer);
  state.cameraCaptureTimer = null;
  state.cameraCaptureAbortController?.abort();
  state.cameraCaptureAbortController = null;
  state.cameraStream?.getTracks().forEach((track) => track.stop());
  state.cameraStream = null;
  if (removePanel) document.querySelector('#away-camera-panel')?.remove();
}
function syncAwayCameraPrompt() {
  const eligible = state.user?.role === 'employee'
    && state.activityStatus === 'away'
    && state.cameraPolicy.enabled
    && state.cameraPolicy.requiresOfficeNetwork
    && state.officeNetworkStatus === 'matched'
    && state.cameraConsent;
  if (!eligible) {
    stopAwayCamera();
    state.cameraAwayPeriodKey = null;
    return;
  }
  const periodKey = state.awayStartedAt;
  if (!periodKey || state.cameraPromptDismissed || state.cameraAwayPeriodKey === periodKey || document.hidden) return;
  state.cameraAwayPeriodKey = periodKey;

  const panel = document.createElement('section');
  panel.id = 'away-camera-panel';
  panel.setAttribute('role', 'status');
  panel.setAttribute('aria-labelledby', 'away-camera-title');
  const heading = document.createElement('strong');
  heading.id = 'away-camera-title';
  heading.textContent = 'Camera check-in';
  const message = document.createElement('p');
  message.setAttribute('aria-live', 'assertive');
  message.textContent = 'You are marked Away. A single photo check-in will begin in 5 seconds. Keep this indicator visible; no audio or video is recorded.';
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  video.setAttribute('aria-label', 'Visible camera check-in preview');
  video.className = 'away-camera-preview hidden';
  const photo = document.createElement('img');
  photo.className = 'away-camera-photo hidden';
  photo.alt = 'Saved camera check-in photo';
  const error = document.createElement('p');
  error.className = 'away-camera-error';
  error.setAttribute('role', 'alert');
  const actions = document.createElement('div');
  actions.className = 'away-camera-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'button button-secondary';
  cancel.textContent = 'Cancel this check-in';
  cancel.addEventListener('click', () => {
    state.cameraPromptDismissed = true;
    stopAwayCamera();
  });
  actions.append(cancel);
  panel.append(heading, message, video, photo, error, actions);
  document.body.append(panel);

  let countdown = 5;
  state.cameraCaptureTimer = window.setInterval(async () => {
    if (!document.body.contains(panel)) {
      stopAwayCamera();
      return;
    }
    countdown -= 1;
    if (countdown > 0) {
      message.textContent = `Camera check-in starts in ${countdown} seconds. Keep this indicator visible; no audio or video is recorded.`;
      return;
    }
    window.clearInterval(state.cameraCaptureTimer);
    state.cameraCaptureTimer = null;
    if (state.cameraCaptureInFlight || state.cameraPromptDismissed || document.hidden || state.activityStatus !== 'away'
      || state.awayStartedAt !== periodKey || state.officeNetworkStatus !== 'matched'
      || !state.cameraPolicy.enabled || !state.cameraConsent) {
      stopAwayCamera();
      return;
    }
    state.cameraCaptureInFlight = true;
    error.textContent = '';
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is unavailable in this app window.');
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      if (state.cameraPromptDismissed || !document.body.contains(panel) || document.hidden || state.activityStatus !== 'away' || state.awayStartedAt !== periodKey
        || state.officeNetworkStatus !== 'matched' || !state.cameraPolicy.enabled || !state.cameraConsent) {
        stream.getTracks().forEach((track) => track.stop());
        stopAwayCamera();
        return;
      }
      state.cameraStream = stream;
      video.srcObject = stream;
      video.classList.remove('hidden');
      message.textContent = 'Camera active — capturing one still photo. You can cancel now.';
      await video.play();
      if (!video.videoWidth || !video.videoHeight) throw new Error('The camera did not provide an image.');
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('The camera photo could not be prepared.');
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = await new Promise((resolve, reject) => canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('The camera photo could not be created.'));
      }, 'image/jpeg', 0.82));
      if (state.cameraPromptDismissed || !document.body.contains(panel) || document.hidden || state.activityStatus !== 'away' || state.awayStartedAt !== periodKey
        || state.officeNetworkStatus !== 'matched' || !state.cameraPolicy.enabled || !state.cameraConsent) {
        stopAwayCamera();
        return;
      }
      state.cameraCaptureAbortController = new AbortController();
      cancel.disabled = true;
      message.textContent = 'Saving the one photo check-in securely.';
      const response = await fetch('/api/activity/camera-checkins', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'image/jpeg' },
        body: image,
        signal: state.cameraCaptureAbortController.signal
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `Camera check-in failed (${response.status})`);
      state.cameraPromptDismissed = true;
      if (result.captured) {
        photo.src = URL.createObjectURL(image);
        photo.classList.remove('hidden');
        message.textContent = 'Photo check-in saved. It is visible to you and authorized Admins and will be deleted after 30 days.';
      } else {
        message.textContent = 'A photo check-in is already saved for this Away period.';
      }
      video.classList.add('hidden');
      stopAwayCamera(false);
      cancel.classList.add('hidden');
    } catch (reason) {
      error.textContent = `Camera could not start or the photo could not be saved: ${reason.message}`;
      message.textContent = 'No photo was saved. Check your camera permission and office Wi-Fi connection.';
      state.cameraPromptDismissed = true;
      stopAwayCamera(false);
      cancel.textContent = 'Dismiss';
    } finally {
      state.cameraCaptureInFlight = false;
    }
  }, 1000);
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    const captureWasShown = Boolean(state.cameraCaptureTimer || state.cameraStream || document.querySelector('#away-camera-panel'));
    if (captureWasShown) state.cameraPromptDismissed = true;
    stopAwayCamera();
  } else {
    syncAwayCameraPrompt();
  }
});
function setEmployeeActivityStatus(status, occurredAt = null, refreshDashboard = true) {
  const previousStatus = state.activityStatus;
  state.activityStatus = status;
  if (status === 'away' && previousStatus !== 'away') {
    state.awayStartedAt = occurredAt || new Date().toISOString();
    state.cameraPromptDismissed = false;
    state.cameraAwayPeriodKey = null;
  } else if (status !== 'away') {
    state.awayStartedAt = null;
    state.cameraPromptDismissed = false;
    state.cameraAwayPeriodKey = null;
  }
  if (status === 'away' && previousStatus !== 'away') showAwayStatusPopup();
  else if (status === 'available') {
    document.querySelector('#activity-status-popup')?.remove();
    if (previousStatus === 'away') toast('Your status is now Available');
  } else if (status === 'offline' || status === 'unknown') {
    document.querySelector('#activity-status-popup')?.remove();
  }
  syncAwayCameraPrompt();
  if (refreshDashboard && previousStatus !== status && state.view === 'dashboard') loadView();
}
function updateEmployeeCameraState(dashboardData) {
  const nextAwayStartedAt = dashboardData.status === 'away' ? dashboardData.awayStartedAt : null;
  if (state.awayStartedAt && nextAwayStartedAt && state.awayStartedAt !== nextAwayStartedAt) {
    stopAwayCamera();
    state.cameraPromptDismissed = false;
    state.cameraAwayPeriodKey = null;
  }
  state.officeNetworkStatus = dashboardData.officeNetworkStatus;
  state.cameraPolicy = dashboardData.cameraPolicy;
  state.cameraConsent = Boolean(dashboardData.cameraConsent?.enabled);
  if (state.activityStatus !== dashboardData.status) {
    setEmployeeActivityStatus(dashboardData.status, dashboardData.awayStartedAt, false);
  }
  state.awayStartedAt = nextAwayStartedAt;
  if (nextAwayStartedAt && dashboardData.currentAwayCheckin) {
    state.cameraPromptDismissed = true;
    state.cameraAwayPeriodKey = nextAwayStartedAt;
    stopAwayCamera(false);
  }
  syncAwayCameraPrompt();
}
function combineTimelineEvents(statusEvents, applicationSwitches = [], cameraCheckins = [], cameraImagePath = '/employee/camera-checkins') {
  return [
    ...statusEvents.map((event) => ({ ...event, timelineType: 'status' })),
    ...applicationSwitches.map((event) => ({ ...event, timelineType: 'application' })),
    ...cameraCheckins.map((event) => ({ ...event, timelineType: 'camera', cameraImagePath }))
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
  if (event.timelineType === 'camera') {
    const imageUrl = `${event.cameraImagePath}/${Number(event.id)}/image`;
    return `<div class="event-row event-row-camera"><time class="event-time">${formatTime(event.occurredAt)}</time><span class="event-marker"></span><span class="event-description"><strong>Camera safety check-in</strong><img class="timeline-camera-image" src="/api${imageUrl}" alt="Camera check-in captured at ${escapeHtml(formatTime(event.occurredAt))}" loading="lazy"><span class="muted">Visible to you and authorized Admins · deleted after 30 days</span></span></div>`;
  }
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
      if (state.user.role === 'employee' && event.userId === state.user.id) setEmployeeActivityStatus(event.status, event.occurredAt);
      if (state.view === 'dashboard' || (state.view === 'attendance' && state.user.role === 'employee' && event.userId === state.user.id)) loadView();
    });
    state.socket.on('agent:stale', () => { if (state.view === 'dashboard') loadView(); });
    state.socket.on('application:switch', (event) => {
      if (state.user.role === 'employee' && event.userId === state.user.id && ['dashboard', 'activity'].includes(state.view)) loadView();
    });
    state.socket.on('agent:heartbeat', (event) => {
      if (state.user.role === 'admin') {
        const heartbeat = document.querySelector(`[data-employee-heartbeat="${event.userId}"]`);
        if (heartbeat) heartbeat.textContent = formatTime(event.lastHeartbeatAt);
        const network = document.querySelector(`[data-employee-network="${event.userId}"]`);
        if (network) network.textContent = event.networkSsid ? `${event.networkSsid} · ${officeNetworkStatusLabel(event.officeNetworkStatus)}` : officeNetworkStatusLabel(event.officeNetworkStatus);
      } else if (event.userId === state.user.id) {
        state.officeNetworkStatus = event.officeNetworkStatus;
        setEmployeeActivityStatus(event.status);
      }
    });
    state.socket.on('camera-checkin:created', (checkin) => {
      if (state.user.role === 'employee' && ['dashboard', 'activity'].includes(state.view)) loadView();
      if (state.user.role === 'admin') toast('A camera safety check-in was saved');
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
    state.socket.on('policy:updated', (policy) => {
      if (state.user.role !== 'employee' || typeof policy.cameraEnabled !== 'boolean') return;
      state.cameraPolicy.enabled = policy.cameraEnabled;
      const policyLabel = document.querySelector('#camera-consent-policy-status');
      if (policyLabel) policyLabel.textContent = `Admin policy: ${policy.cameraEnabled ? 'enabled' : 'disabled'} · Office Wi-Fi required`;
      syncAwayCameraPrompt();
    });
  }
  if (state.user.role === 'employee') {
    if (navigator.userAgent.includes('Electron')) return;
    else startBrowserOfflineReporter();
  }
}
function startBrowserOfflineReporter() {
  if (state.activityTimer) return;
  state.activityStatus = 'unknown';
  const reportOffline = async () => {
    if (state.activityHeartbeatInFlight) return;
    state.activityHeartbeatInFlight = true;
    try {
      const result = await api('/activity/heartbeat', {
        method: 'POST',
        body: JSON.stringify({ idleSeconds: 0, locked: false, networkSsid: null })
      });
      state.officeNetworkStatus = result.officeNetworkStatus;
      setEmployeeActivityStatus(result.status);
    } catch {
      setEmployeeActivityStatus('unknown');
    } finally {
      state.activityHeartbeatInFlight = false;
    }
  };
  void reportOffline();
  state.activityTimer = window.setInterval(() => { void reportOffline(); }, 15_000);
}
function stopBrowserOfflineReporter() {
  if (state.activityTimer) window.clearInterval(state.activityTimer);
  state.activityTimer = null;
  state.activityStatus = 'unknown';
  document.querySelector('#activity-status-popup')?.remove();
  state.cameraPromptDismissed = false;
  stopAwayCamera();
}
function navigate(view) { state.view = view; renderNavigation(); loadView(); }
async function loadView() {
  window.clearInterval(state.dashboardRefreshTimer);
  state.dashboardRefreshTimer = null;
  window.clearTimeout(state.dashboardMidnightTimer);
  state.dashboardMidnightTimer = null;
  const titles = { dashboard: 'Dashboard', employees: 'Employees', policies: 'Policies', audit: 'Audit log', reports: 'Reports', attendance: 'Attendance', activity: 'Activity timeline', profile: 'My profile' };
  const title = titles[state.view] || 'Dashboard';
  document.querySelector('#page-title').textContent = title;
  document.querySelector('#top-eyebrow').textContent = state.user.role === 'admin' ? 'ADMINISTRATION' : 'MY WORKSPACE';
  pageContent.innerHTML = '<div class="empty-state">Loading current records…</div>';
  try {
    if (state.view === 'dashboard' || state.view === 'attendance') scheduleDayBoundaryRefresh();
    if (state.view === 'dashboard') state.user.role === 'admin' ? await renderAdminDashboard() : await renderEmployeeDashboard();
    else if (state.view === 'employees') await renderEmployees();
    else if (state.view === 'policies') await renderPolicies();
    else if (state.view === 'audit') await renderAudit();
    else if (state.view === 'reports') await renderReports();
    else if (state.view === 'attendance' || state.view === 'activity') await renderEmployeeEvents();
    else if (state.view === 'profile') await renderProfile();
    setupPasswordFields(document);
  } catch (error) { pageContent.innerHTML = `<div class="notice">${escapeHtml(error.message)}</div>`; }
}
async function renderAdminDashboard() {
  const { kpis, employees } = await api(dashboardApiPath('/admin/dashboard'));
  const cards = [['Total employees', kpis.totalEmployees], ['Present today', kpis.presentToday], ['Available now', kpis.available], ['Away now', kpis.away], ['Offline / unknown', kpis.offline], ['Absent today', kpis.absentToday], ['Available interaction today', formatDuration(kpis.activeInteractionMs)], ['Away duration today', formatDuration(kpis.awayMs)]];
  pageContent.innerHTML = `<div class="page-heading"><div><h2>Team overview</h2><p>Current session and device status, based on the latest server event.</p></div><div class="connection"><span class="status-dot online"></span> Live connection</div></div>
    <div class="kpi-grid">${cards.map(([label, value]) => `<article class="kpi"><div class="kpi-label">${label}</div><strong class="kpi-number" ${label === 'Available interaction today' ? 'data-dashboard-kpi="availableInteraction"' : label === 'Away duration today' ? 'data-dashboard-kpi="awayDuration"' : ''}>${value}</strong>${label.includes('interaction') || label.includes('duration') ? '<div class="kpi-sub">Not verified productive work</div>' : ''}</article>`).join('')}</div>
    <section class="panel"><div class="panel-header"><div><h3>Live employee status</h3><p>Unknown is kept separate from confirmed Available and Away status.</p></div><div class="filters"><input id="dashboard-search" type="search" aria-label="Search employees" placeholder="Search name or email"></div></div><div class="table-wrap"><table><thead><tr><th>Employee</th><th>Department</th><th>Status</th><th>Last heartbeat</th><th>Reported Wi-Fi</th></tr></thead><tbody id="dashboard-rows"></tbody></table></div></section>`;
  const search = document.querySelector('#dashboard-search');
  const draw = () => {
    const term = search.value.trim().toLowerCase();
    const filtered = employees.filter((employee) => `${employee.fullName} ${employee.email}`.toLowerCase().includes(term));
    document.querySelector('#dashboard-rows').innerHTML = filtered.length ? filtered.map((employee) => `<tr><td><div class="person"><span class="avatar">${escapeHtml(employee.fullName.slice(0, 1).toUpperCase())}</span><div><div class="person-name">${escapeHtml(employee.fullName)}</div><div class="person-email">${escapeHtml(employee.email)}</div></div></div></td><td>${escapeHtml(employee.department || '—')}</td><td>${statusPill(employee.status)}</td><td data-employee-heartbeat="${employee.id}">${formatTime(employee.lastHeartbeat)}</td><td data-employee-network="${employee.id}">${employee.lastNetworkSsid ? `${escapeHtml(employee.lastNetworkSsid)} · ${officeNetworkStatusLabel(employee.officeNetworkStatus)}` : officeNetworkStatusLabel(employee.officeNetworkStatus)}</td></tr>`).join('') : '<tr><td colspan="5" class="empty-state">No employees match this search.</td></tr>';
  };
  search.addEventListener('input', draw);
  draw();
  state.dashboardRefreshTimer = window.setInterval(async () => {
    if (state.view !== 'dashboard' || state.user?.role !== 'admin') return;
    try {
      const refreshed = await api(dashboardApiPath('/admin/dashboard'));
      const available = pageContent.querySelector('[data-dashboard-kpi="availableInteraction"]');
      const away = pageContent.querySelector('[data-dashboard-kpi="awayDuration"]');
      if (available) available.textContent = formatDuration(refreshed.kpis.activeInteractionMs);
      if (away) away.textContent = formatDuration(refreshed.kpis.awayMs);
    } catch (error) {
      toast(`Dashboard refresh failed: ${error.message}`);
    }
  }, 60_000);
}
async function renderEmployeeDashboard() {
  const data = await api(dashboardApiPath('/employee/dashboard'));
  updateEmployeeCameraState(data);
  const updateDashboard = (dashboardData) => {
    updateEmployeeCameraState(dashboardData);
    const timeline = pageContent.querySelector('[data-dashboard-timeline]');
    const scrollContainer = timeline?.parentElement;
    const scrollTop = scrollContainer?.scrollTop || 0;
    const events = combineTimelineEvents(dashboardData.events, dashboardData.applicationSwitches || [], dashboardData.cameraCheckins || []).slice(0, 200);
    const values = {
      status: dashboardData.status,
      login: formatTime(dashboardData.attendanceStartedAt || dashboardData.session.startedAt),
      firstAvailable: formatTime(dashboardData.firstAvailableAt),
      awaySessions: dashboardData.awaySessions,
      availableInteraction: formatDuration(dashboardData.availableInteractionMs),
      awayDuration: formatDuration(dashboardData.awayDurationMs),
      lastActivity: `Last activity signal: ${formatTime(dashboardData.lastActivityAt)}`
    };
    for (const [key, value] of Object.entries(values)) {
      const element = pageContent.querySelector(`[data-dashboard-value="${key}"]`);
      if (element) element.textContent = value;
    }
    if (timeline) {
      timeline.innerHTML = events.length ? events.map((event) => renderTimelineRow(event)).join('') : '<div class="empty-state">No activity recorded yet.</div>';
      if (scrollContainer) scrollContainer.scrollTop = scrollTop;
    }
  };
  const events = combineTimelineEvents(data.events, data.applicationSwitches || [], data.cameraCheckins || []).slice(0, 200);
  const networkNotice = data.officeNetworkStatus === 'matched'
    ? `Office Wi-Fi matched: ${escapeHtml(data.officeNetworkSsid)}. Availability and foreground-app monitoring are active while this exact approved network is reported.`
    : 'Availability and foreground-app monitoring are paused and your status is Offline until the Windows desktop agent reports an exact match to an approved office Wi-Fi network.';
  pageContent.innerHTML = `<div class="page-heading"><div><h2>Your day at a glance</h2><p>Attendance and interaction signals are shown separately from productive work.</p></div><div class="connection"><span class="status-dot online"></span> Signed in</div></div>
    <div class="status-hero"><div><p class="eyebrow">CURRENT DEVICE STATUS</p><h2 data-dashboard-value="status">${escapeHtml(data.status)}</h2><p class="muted" data-dashboard-value="lastActivity">Last activity signal: ${formatTime(data.lastActivityAt)}</p></div><span class="status-orb" aria-hidden="true">◉</span></div>
    <div class="two-column" style="margin-top:15px"><section><div class="notice">${networkNotice}</div><div class="metric-list" style="margin-top:14px"><div class="metric-row"><span>Website login time</span><strong data-dashboard-value="login">${formatTime(data.attendanceStartedAt || data.session.startedAt)}</strong></div><div class="metric-row"><span>First available</span><strong data-dashboard-value="firstAvailable">${formatTime(data.firstAvailableAt)}</strong></div><div class="metric-row"><span>Away sessions today</span><strong data-dashboard-value="awaySessions">${data.awaySessions}</strong></div><div class="metric-row"><span>Available interaction</span><strong data-dashboard-value="availableInteraction">${formatDuration(data.availableInteractionMs)}</strong></div><div class="metric-row"><span>Away duration</span><strong data-dashboard-value="awayDuration">${formatDuration(data.awayDurationMs)}</strong></div></div><div class="notice" style="margin-top:14px">Foreground application and window-title changes are recorded only while connected to an approved office Wi-Fi SSID. Titles may reveal webpage or document names. No typed content, raw coordinates, or click targets are sent or persisted. Available time is not verified work time.</div></section>
    <section class="panel timeline-panel"><div class="panel-header"><div><h3>Today's timeline</h3><p>Status, app changes, and camera check-ins</p></div></div><div class="panel-body"><div class="event-list" data-dashboard-timeline>${events.length ? events.map((event) => renderTimelineRow(event)).join('') : '<div class="empty-state">No activity recorded yet.</div>'}</div></div></section></div>`;
  const consentPanel = document.createElement('section');
  consentPanel.className = 'panel camera-consent-panel';
  consentPanel.innerHTML = `<div class="panel-header"><div><h3>Optional camera safety check-in</h3><p id="camera-consent-policy-status">Admin policy: ${data.cameraPolicy.enabled ? 'enabled' : 'disabled'} · Office Wi-Fi required</p></div></div>
    <div class="panel-body"><p>When enabled by your Admin, opting in allows one still photo after each Away threshold while your device is on the approved office Wi-Fi. A visible countdown and camera-active indicator appear first; you can cancel capture. Photos are encrypted, visible only to you and authorized Admins, and automatically deleted after 30 days. You can revoke consent at any time. No audio or continuous video is captured.</p>
    <p class="muted">This check-in is not emergency-response infrastructure and cannot reliably detect a collapse or guarantee that someone will see an alert.</p>
    <label class="camera-consent-choice"><input id="camera-consent-enabled" type="checkbox" ${data.cameraConsent.enabled ? 'checked' : ''}><span>I consent to the one-photo Away check-in described above.</span></label>
    <div class="policy-actions"><button id="camera-consent-save" class="button button-primary" type="button">Save camera choice</button><span id="camera-consent-result" class="muted" role="status">${data.cameraConsent.enabled ? 'Consent is on. Use the checkbox to revoke it.' : 'Camera check-ins are off until you opt in.'}</span></div></div>`;
  pageContent.querySelector('.status-hero').after(consentPanel);
  document.querySelector('#camera-consent-save').addEventListener('click', async () => {
    const enabled = document.querySelector('#camera-consent-enabled').checked;
    const result = document.querySelector('#camera-consent-result');
    try {
      const consent = await api('/employee/camera-consent', {
        method: 'PUT',
        body: JSON.stringify({ enabled, consentVersion: 'camera-checkin-2026-10-17-v1' })
      });
      state.cameraConsent = consent.enabled;
      result.textContent = consent.enabled ? 'Consent saved. You may revoke it at any time.' : 'Consent revoked. No new photos will be captured.';
      syncAwayCameraPrompt();
    } catch (error) {
      result.textContent = error.message;
    }
  });
  state.dashboardRefreshTimer = window.setInterval(async () => {
    if (state.view !== 'dashboard' || state.user?.role !== 'employee') return;
    try {
      const refreshedData = await api(dashboardApiPath('/employee/dashboard'));
      if (state.view === 'dashboard' && state.user?.role === 'employee') updateDashboard(refreshedData);
    } catch (error) {
      toast(`Dashboard refresh failed: ${error.message}`);
    }
  }, 60_000);
}
async function loadEmployees() {
  const data = await api(`/admin/employees?search=${encodeURIComponent(state.search)}`);
  state.employees = data.employees;
  drawEmployeeRows();
}
async function openAdminCameraCheckins(employeeId, employeeName) {
  const dialog = document.createElement('dialog');
  dialog.className = 'camera-checkins-dialog';
  dialog.innerHTML = `<div class="panel-header"><div><h3>Camera check-ins</h3><p>${escapeHtml(employeeName)}</p></div><button class="button button-secondary table-action" type="button" data-camera-dialog-close>Close</button></div><div class="camera-checkins-content panel-body"><p class="muted">Loading photos…</p></div>`;
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.querySelector('[data-camera-dialog-close]').addEventListener('click', () => dialog.close());
  document.body.append(dialog);
  dialog.showModal();
  try {
    const { checkins } = await api(`/admin/employees/${Number(employeeId)}/camera-checkins`);
    const content = dialog.querySelector('.camera-checkins-content');
    if (!content || !dialog.open) return;
    content.innerHTML = checkins.length
      ? `<div class="camera-checkins-grid">${checkins.map((checkin) => `<figure><img src="/api/admin/employees/${Number(employeeId)}/camera-checkins/${Number(checkin.id)}/image" alt="Camera safety check-in at ${escapeHtml(formatTime(checkin.capturedAt))}" loading="lazy"><figcaption>${formatTime(checkin.capturedAt)} · deleted after 30 days</figcaption></figure>`).join('')}</div>`
      : '<p class="empty-state">No camera check-ins are available for this employee.</p>';
  } catch (error) {
    const content = dialog.querySelector('.camera-checkins-content');
    if (content && dialog.open) content.innerHTML = `<p class="form-error" role="alert">${escapeHtml(error.message)}</p>`;
  }
}
function drawEmployeeRows() {
  const tbody = document.querySelector('#employee-rows');
  if (!tbody) return;
  tbody.innerHTML = state.employees.length ? state.employees.map((employee) => `<tr><td><div class="person"><span class="avatar">${escapeHtml(employee.fullName.slice(0, 1).toUpperCase())}</span><div><div class="person-name">${escapeHtml(employee.fullName)}</div><div class="person-email">${escapeHtml(employee.email)}</div></div></div></td><td>${escapeHtml(employee.department || '—')}</td><td>${escapeHtml(employee.designation || '—')}</td><td>${employee.active ? 'Active' : 'Deactivated'}</td><td><div class="row-actions"><button class="button button-secondary table-action" type="button" data-edit-employee="${employee.id}">Edit</button><button class="button button-secondary table-action" type="button" data-camera-checkins="${employee.id}" data-camera-employee-name="${escapeHtml(employee.fullName)}">Photos</button><button class="button button-secondary table-action" data-account-toggle="${employee.id}" data-active="${employee.active ? 'true' : 'false'}">${employee.active ? 'Deactivate' : 'Reactivate'}</button></div></td></tr>`).join('') : '<tr><td colspan="5" class="empty-state">No employee accounts found.</td></tr>';
  tbody.querySelectorAll('[data-camera-checkins]').forEach((button) => button.addEventListener('click', () => {
    void openAdminCameraCheckins(button.dataset.cameraCheckins, button.dataset.cameraEmployeeName);
  }));
  tbody.querySelectorAll('[data-edit-employee]').forEach((button) => button.addEventListener('click', () => {
    const employee = state.employees.find((item) => String(item.id) === button.dataset.editEmployee);
    if (!employee) return;
    const form = document.querySelector('#employee-form');
    const panel = document.querySelector('#employee-form-panel');
    const title = document.querySelector('#employee-form-title');
    const subtitle = document.querySelector('#employee-form-subtitle');
    const submitButton = document.querySelector('#employee-submit-button');
    form.dataset.employeeId = String(employee.id);
    form.elements.fullName.value = employee.fullName || '';
    form.elements.email.value = employee.email || '';
    form.elements.email.readOnly = true;
    form.elements.department.value = employee.department || '';
    form.elements.designation.value = employee.designation || '';
    form.elements.temporaryPassword.value = '';
    form.elements.temporaryPassword.required = false;
    form.elements.temporaryPassword.closest('.field')?.classList.add('hidden');
    title.textContent = 'Edit employee account';
    subtitle.textContent = 'Update the employee profile details and save changes.';
    submitButton.textContent = 'Save changes';
    panel.classList.remove('hidden');
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }));
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
    <section id="employee-form-panel" class="panel hidden" style="margin-bottom:16px"><div class="panel-header"><div><h3 id="employee-form-title">New employee account</h3><p id="employee-form-subtitle">Use a temporary password and deliver it securely to the employee.</p></div></div><div class="panel-body"><form id="employee-form"><div class="form-grid"><div class="field"><label for="new-name">Full name</label><input id="new-name" name="fullName" required minlength="2" maxlength="120"></div><div class="field"><label for="new-email">Work email</label><input id="new-email" name="email" type="email" required maxlength="254"></div><div class="field"><label for="new-department">Department</label><input id="new-department" name="department" maxlength="100"></div><div class="field"><label for="new-designation">Designation</label><input id="new-designation" name="designation" maxlength="100"></div><div class="field"><label for="new-password">Temporary password</label><div class="password-input-wrap"><input id="new-password" name="temporaryPassword" type="password" required minlength="12" autocomplete="new-password"><button class="password-toggle" type="button" aria-label="Show password" aria-pressed="false">👁</button></div><div class="password-strength"><div class="password-meter" role="meter" aria-label="Password strength" aria-valuemin="0" aria-valuemax="4" aria-valuenow="0" aria-valuetext="No password entered" data-score="0"><span></span><span></span><span></span><span></span></div><span class="password-strength-label"></span><p class="password-guidance">Use at least 12 characters with a mix of uppercase and lowercase letters, numbers, and symbols.</p></div></div></div><p class="form-error" id="employee-error" role="alert"></p><button id="employee-submit-button" class="button button-primary" type="submit">Create account</button></form></div></section>
    <section class="panel"><div class="panel-header"><h3>Employees</h3><div class="filters"><input id="employee-search" type="search" placeholder="Search employees" aria-label="Search employees"></div></div><div class="table-wrap"><table><thead><tr><th>Employee</th><th>Department</th><th>Designation</th><th>Account</th><th>Actions</th></tr></thead><tbody id="employee-rows"></tbody></table></div></section>`;
  const addEmployeeToggle = document.querySelector('#add-employee-toggle');
  setupPasswordFields(document.querySelector('#employee-form-panel'));
  addEmployeeToggle.addEventListener('click', () => {
    const form = document.querySelector('#employee-form');
    const panel = document.querySelector('#employee-form-panel');
    const title = document.querySelector('#employee-form-title');
    const subtitle = document.querySelector('#employee-form-subtitle');
    const submitButton = document.querySelector('#employee-submit-button');
    delete form.dataset.employeeId;
    form.reset();
    form.elements.email.readOnly = false;
    const passwordField = form.elements.temporaryPassword;
    passwordField.required = true;
    passwordField.closest('.field')?.classList.remove('hidden');
    title.textContent = 'New employee account';
    subtitle.textContent = 'Use a temporary password and deliver it securely to the employee.';
    submitButton.textContent = 'Create account';
    panel.classList.remove('hidden');
  });
  document.querySelector('#employee-search').addEventListener('input', (event) => { state.search = event.target.value; loadEmployees().catch((error) => toast(error.message)); });
  document.querySelector('#employee-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const errorElement = document.querySelector('#employee-error');
    errorElement.textContent = '';
    try {
      const employeeId = formElement.dataset.employeeId;
      if (employeeId) {
        const payload = {
          fullName: form.get('fullName'),
          department: form.get('department'),
          designation: form.get('designation')
        };
        await api(`/admin/employees/${employeeId}`, { method: 'PATCH', body: JSON.stringify(payload) });
        formElement.reset();
        formElement.elements.email.readOnly = false;
        delete formElement.dataset.employeeId;
        document.querySelector('#employee-form-panel').classList.add('hidden');
        toast('Employee details updated');
      } else {
        const payload = Object.fromEntries(form.entries());
        await api('/admin/employees', { method: 'POST', body: JSON.stringify(payload) });
        formElement.reset();
        document.querySelector('#employee-form-panel').classList.add('hidden');
        toast('Employee account created');
      }
      await loadEmployees();
    } catch (error) { errorElement.textContent = error.message; }
  });
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
    <section class="panel"><div class="panel-header"><div><h3>Availability detection</h3><p>Uses only an idle duration reported by the employee's desktop agent.</p></div></div><div class="panel-body"><form id="policy-form"><div class="policy-row"><div><strong>Idle threshold</strong><p>After this interval without OS-reported input, status changes to Away.</p></div><div class="threshold-input"><input name="idleThresholdValue" type="number" min="1" max="60" step="1" required aria-label="Idle threshold value"><select name="idleThresholdUnit" aria-label="Idle threshold unit"><option value="minutes">Min</option><option value="seconds">Sec</option></select></div></div><div class="policy-row"><div><strong>Camera check-ins</strong><p>After an employee opts in, one still photo may be captured after each Away threshold on an approved office Wi-Fi. Capture is disclosed, visually indicated, visible to that employee and admins, and deleted after 30 days. No audio or continuous video is captured.</p><label class="policy-toggle"><input name="cameraEnabled" type="checkbox" ${policy.cameraStorageReady ? '' : 'disabled'}><span>Offer camera check-ins after Away status</span></label><p>${policy.cameraStorageReady ? 'Encrypted storage is configured.' : 'Unavailable: configure CAMERA_STORAGE_KEY on the server before enabling camera check-ins.'}</p><p>This Admin device: <span id="camera-network-status">${officeNetworkStatusLabel(current.officeNetworkStatus)}</span>.</p></div><span class="policy-value" id="camera-policy-status">${policy.cameraEnabled ? 'Check-in enabled' : 'Check-in disabled'}</span></div><div class="policy-actions"><button class="button button-primary" type="submit">Save policy</button><span class="muted" id="policy-result" role="status"></span></div></form></div></section>
    <section class="panel network-policy-panel"><div class="panel-header"><div><h3>Office Wi-Fi verification</h3><p>The Windows desktop agent reports its connected SSID. A match is informational, not proof of identity.</p></div></div><div class="panel-body"><div class="policy-row current-network"><div><strong>This Admin device</strong><p>Last checked: ${formatTime(current.checkedAt)}</p></div><span class="policy-value" id="current-admin-network">${current.ssid ? `${escapeHtml(current.ssid)} · ${officeNetworkStatusLabel(current.officeNetworkStatus)}` : officeNetworkStatusLabel(current.officeNetworkStatus)}</span></div><form id="office-network-form" class="network-form"><div class="form-grid"><div class="field"><label for="network-label">Network label</label><input id="network-label" name="label" required maxlength="80" placeholder="Office Wi-Fi"></div><div class="field"><label for="network-ssid">Wi-Fi name (SSID)</label><input id="network-ssid" name="ssid" required maxlength="32" placeholder="Exact Windows network name" value="${escapeHtml(current.ssid || '')}"></div></div><p class="form-error" id="network-error" role="alert"></p><button class="button button-primary" type="submit">Approve Wi-Fi</button></form><div class="table-wrap network-table"><table><thead><tr><th>Label</th><th>Wi-Fi SSID</th><th>Status</th><th>Action</th></tr></thead><tbody id="approved-network-rows">${approvedRows}</tbody></table></div><p class="network-caveat">Browser-only sessions cannot report Wi-Fi. SSID matching can be spoofed and does not enable camera access. Add an organization-managed network verification method before relying on this for access control.</p></div></section>`;
  const form = document.querySelector('#policy-form');
  const thresholdInMinutes = policy.idleThresholdSeconds % 60 === 0;
  form.elements.idleThresholdUnit.value = thresholdInMinutes ? 'minutes' : 'seconds';
  form.elements.idleThresholdValue.value = thresholdInMinutes ? policy.idleThresholdSeconds / 60 : policy.idleThresholdSeconds;
  form.elements.idleThresholdValue.max = thresholdInMinutes ? 60 : 3600;
  form.elements.cameraEnabled.checked = policy.cameraEnabled;
  form.elements.idleThresholdUnit.addEventListener('change', () => {
    form.elements.idleThresholdValue.max = form.elements.idleThresholdUnit.value === 'minutes' ? 60 : 3600;
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const multiplier = form.elements.idleThresholdUnit.value === 'minutes' ? 60 : 1;
    try {
      await api('/admin/policies', { method: 'PATCH', body: JSON.stringify({
        idleThresholdSeconds: Number(form.elements.idleThresholdValue.value) * multiplier,
        cameraEnabled: form.elements.cameraEnabled.checked
      }) });
      document.querySelector('#camera-policy-status').textContent = form.elements.cameraEnabled.checked ? 'Check-in enabled' : 'Check-in disabled';
      document.querySelector('#policy-result').textContent = 'Saved';
    }
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
  const rows = admin ? report.employees.map((employee) => `<tr><td>${escapeHtml(employee.fullName)}</td><td>${escapeHtml(employee.email)}</td><td>${formatDuration(employee.availableMs)}</td><td>${formatDuration(employee.awayMs)}</td><td>${employee.awaySessions}</td><td><button class="button button-secondary table-action" type="button" data-camera-checkins="${employee.id}" data-camera-employee-name="${escapeHtml(employee.fullName)}">Check-in photos</button></td></tr>`).join('') : `<tr><td>${formatDuration(report.report.availableMs)}</td><td>${formatDuration(report.report.awayMs)}</td><td>${report.report.awaySessions}</td></tr>`;
  pageContent.innerHTML = `<div class="page-heading"><div><h2>${admin ? 'Team activity report' : 'Your activity report'}</h2><p>${escapeHtml(report.note)} Period: ${new Date(report.range.start).toLocaleDateString()} to ${new Date(report.range.end).toLocaleDateString()}.</p></div><button id="download-report" class="button button-secondary">Download CSV</button></div><section class="panel"><div class="table-wrap"><table><thead><tr>${admin ? '<th>Employee</th><th>Email</th>' : ''}<th>Available interaction</th><th>Away duration</th><th>Away sessions</th>${admin ? '<th>Photos</th>' : ''}</tr></thead><tbody>${rows || `<tr><td colspan="${admin ? 6 : 3}" class="empty-state">No report rows for this period.</td></tr>`}</tbody></table></div></section>`;
  pageContent.querySelectorAll('[data-camera-checkins]').forEach((button) => button.addEventListener('click', () => {
    void openAdminCameraCheckins(button.dataset.cameraCheckins, button.dataset.cameraEmployeeName);
  }));
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
  if (state.view === 'attendance') {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    const query = `?from=${encodeURIComponent(dayStart.toISOString())}&to=${encodeURIComponent(dayEnd.toISOString())}`;
    const { events: statusEvents, note } = await api(`${path}${query}`);
    const events = combineTimelineEvents(statusEvents).slice(0, 500);
    pageContent.innerHTML = `<div class="page-heading"><div><h2>Attendance events</h2><p>Showing today's records for your account. This view refreshes daily at midnight.</p></div></div>${note ? `<div class="notice" style="margin-bottom:14px">${escapeHtml(note)}</div>` : ''}<section class="panel timeline-panel"><div class="panel-header"><h3>Recorded activity</h3></div><div class="panel-body"><div class="event-list">${events.length ? events.map((event) => renderTimelineRow(event, true)).join('') : '<div class="empty-state">There are no recorded events yet.</div>'}</div></div></section>`;
    return;
  }

  const selectedDate = new Date();
  const dateValue = `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, '0')}-${String(selectedDate.getDate()).padStart(2, '0')}`;
  pageContent.innerHTML = `<div class="page-heading"><div><h2>Personal activity timeline</h2><p>Choose a month and date to view all activity for that day.</p></div></div>
    <section class="panel timeline-panel"><div class="panel-header activity-filter-header"><div><h3>Recorded activity</h3><p data-activity-selected-date></p></div><div class="activity-filters"><div class="activity-date-filter"><span>Date</span><button id="activity-date" class="activity-date-button" type="button" aria-expanded="false" aria-controls="activity-calendar"></button><div id="activity-calendar" class="activity-calendar hidden" aria-label="Choose activity date"></div></div></div></div><div class="panel-body"><div class="event-list" data-activity-events><div class="empty-state">Loading activity…</div></div></div></section>`;
  const dateInput = document.querySelector('#activity-date');
  const calendar = document.querySelector('#activity-calendar');
  let selected = new Date(`${dateValue}T00:00:00`);
  let activityLoadId = 0;
  let calendarView = 'day';
  let calendarYear = selected.getFullYear();
  let calendarMonth = selected.getMonth();
  const dateString = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const setSelectedDate = (date) => {
    selected = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    dateInput.textContent = `${String(selected.getDate()).padStart(2, '0')}-${String(selected.getMonth() + 1).padStart(2, '0')}-${selected.getFullYear()}`;
  };
  const renderCalendar = () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const calendarYearRangeStart = Math.floor(calendarYear / 12) * 12;
    const monthName = new Intl.DateTimeFormat(undefined, { month: 'long' }).format(new Date(calendarYear, calendarMonth, 1));
    const heading = `<div class="activity-calendar-heading"><button type="button" data-calendar-previous aria-label="${calendarView === 'day' ? 'Previous month' : calendarView === 'month' ? 'Previous year' : 'Previous years'}">‹</button><div class="activity-calendar-title">${calendarView === 'year' ? `<button type="button" data-calendar-show-month>${calendarYearRangeStart}–${calendarYearRangeStart + 11}</button>` : `<button type="button" data-calendar-show-month>${monthName}</button><button type="button" data-calendar-show-year>${calendarYear}</button>`}</div><button type="button" data-calendar-next aria-label="${calendarView === 'day' ? 'Next month' : calendarView === 'month' ? 'Next year' : 'Next years'}" ${calendarView !== 'day' && calendarYear > today.getFullYear() ? 'disabled' : ''}>›</button></div>`;
    if (calendarView === 'year') {
      const years = Array.from({ length: 12 }, (_, index) => calendarYearRangeStart + index);
      calendar.innerHTML = `${heading}<div class="activity-calendar-grid activity-calendar-choices">${years.map((year) => `<button type="button" class="activity-calendar-choice ${year === selected.getFullYear() ? 'selected' : ''}" data-calendar-year="${year}" ${year > today.getFullYear() ? 'disabled' : ''}>${year}</button>`).join('')}</div>`;
      calendar.querySelectorAll('[data-calendar-year]').forEach((button) => button.addEventListener('click', () => {
        calendarYear = Number(button.dataset.calendarYear);
        calendarView = 'month';
        renderCalendar();
      }));
    } else if (calendarView === 'month') {
      const months = Array.from({ length: 12 }, (_, month) => month);
      calendar.innerHTML = `${heading}<div class="activity-calendar-grid activity-calendar-choices">${months.map((month) => {
        const futureMonth = calendarYear > today.getFullYear() || (calendarYear === today.getFullYear() && month > today.getMonth());
        const label = new Intl.DateTimeFormat(undefined, { month: 'short' }).format(new Date(calendarYear, month, 1));
        return `<button type="button" class="activity-calendar-choice ${calendarYear === selected.getFullYear() && month === selected.getMonth() ? 'selected' : ''}" data-calendar-month="${month}" ${futureMonth ? 'disabled' : ''}>${label}</button>`;
      }).join('')}</div>`;
      calendar.querySelectorAll('[data-calendar-month]').forEach((button) => button.addEventListener('click', () => {
        calendarMonth = Number(button.dataset.calendarMonth);
        calendarView = 'day';
        renderCalendar();
      }));
    } else {
      const year = calendarYear;
      const month = calendarMonth;
      const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      const weekdayNames = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
      const days = Array.from({ length: 42 }, (_, index) => {
        const day = index - firstWeekday + 1;
        if (day < 1 || day > daysInMonth) return '<span class="activity-calendar-empty" aria-hidden="true"></span>';
        const date = new Date(year, month, day);
        const value = dateString(date);
        const classes = ['activity-calendar-day', value === dateString(selected) ? 'selected' : ''].filter(Boolean).join(' ');
        return `<button class="${classes}" type="button" data-calendar-date="${value}" ${date > today ? 'disabled' : ''} aria-label="${day} ${monthName} ${year}" ${value === dateString(selected) ? 'aria-pressed="true"' : ''}>${day}</button>`;
      }).join('');
      calendar.innerHTML = `${heading}<div class="activity-calendar-grid activity-calendar-weekdays">${weekdayNames.map((day) => `<span>${day}</span>`).join('')}</div><div class="activity-calendar-grid">${days}</div>`;
    }
    calendar.querySelector('[data-calendar-show-month]')?.addEventListener('click', () => { calendarView = 'month'; renderCalendar(); });
    calendar.querySelector('[data-calendar-show-year]')?.addEventListener('click', () => { calendarView = 'year'; renderCalendar(); });
    calendar.querySelector('[data-calendar-previous]')?.addEventListener('click', () => {
      if (calendarView === 'day') {
        const prior = new Date(calendarYear, calendarMonth - 1, 1);
        calendarMonth = prior.getMonth();
        calendarYear = prior.getFullYear();
      } else if (calendarView === 'month') calendarYear -= 1;
      else calendarYear -= 12;
      renderCalendar();
    });
    calendar.querySelector('[data-calendar-next]')?.addEventListener('click', () => {
      if (calendarView === 'day') {
        const next = new Date(calendarYear, calendarMonth + 1, 1);
        if (next.getFullYear() > today.getFullYear() || (next.getFullYear() === today.getFullYear() && next.getMonth() > today.getMonth())) return;
        calendarMonth = next.getMonth();
        calendarYear = next.getFullYear();
      } else if (calendarView === 'month') {
        if (calendarYear >= today.getFullYear()) return;
        calendarYear += 1;
      } else {
        if (calendarYear + 12 > today.getFullYear()) return;
        calendarYear += 12;
      }
      renderCalendar();
    });
    calendar.querySelectorAll('[data-calendar-date]').forEach((button) => button.addEventListener('click', () => {
      const [selectedYear, selectedMonth, selectedDay] = button.dataset.calendarDate.split('-').map(Number);
      setSelectedDate(new Date(selectedYear, selectedMonth - 1, selectedDay));
      calendar.classList.add('hidden');
      calendarView = 'day';
      dateInput.setAttribute('aria-expanded', 'false');
      void loadSelectedDay();
    }));
  };
  const loadSelectedDay = async () => {
    const loadId = ++activityLoadId;
    const year = selected.getFullYear();
    const month = selected.getMonth() + 1;
    const day = selected.getDate();
    const start = new Date(year, month - 1, day);
    const end = new Date(year, month - 1, day + 1);
    const label = `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
    pageContent.querySelector('[data-activity-selected-date]').textContent = `Showing activity for ${label}`;
    const eventList = pageContent.querySelector('[data-activity-events]');
    eventList.innerHTML = '<div class="empty-state">Loading activity…</div>';
    try {
      const query = `?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`;
      const { events: statusEvents, applicationSwitches = [], cameraCheckins = [] } = await api(`${path}${query}`);
      if (loadId !== activityLoadId || state.view !== 'activity' || !pageContent.contains(eventList)) return;
      const events = combineTimelineEvents(statusEvents, applicationSwitches, cameraCheckins);
      eventList.innerHTML = events.length ? events.map((event) => renderTimelineRow(event, true)).join('') : '<div class="empty-state">There is no recorded activity for this date.</div>';
    } catch (error) {
      if (loadId === activityLoadId && state.view === 'activity' && pageContent.contains(eventList)) eventList.innerHTML = `<div class="notice">${escapeHtml(error.message)}</div>`;
    }
  };
  dateInput.addEventListener('click', () => {
    const isOpen = !calendar.classList.contains('hidden');
    calendar.classList.toggle('hidden', isOpen);
    dateInput.setAttribute('aria-expanded', String(!isOpen));
    if (!isOpen) {
      calendarView = 'day';
      calendarYear = selected.getFullYear();
      calendarMonth = selected.getMonth();
      renderCalendar();
    }
  });
  setSelectedDate(selected);
  await loadSelectedDay();
}
async function renderProfile() {
  const { user } = await api('/employee/profile');
  pageContent.innerHTML = `<div class="page-heading"><div><h2>Your profile</h2><p>Profile details are managed by your administrator.</p></div></div><section class="panel"><div class="panel-body"><div class="metric-list"><div class="metric-row"><span>Full name</span><strong>${escapeHtml(user.fullName)}</strong></div><div class="metric-row"><span>Work email</span><strong>${escapeHtml(user.email)}</strong></div><div class="metric-row"><span>Department</span><strong>${escapeHtml(user.department || '—')}</strong></div><div class="metric-row"><span>Designation</span><strong>${escapeHtml(user.designation || '—')}</strong></div></div></div></section>`;
}
setupPasswordFields(document);

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
  try { await api('/auth/logout', { method: 'POST' }); } finally { window.clearInterval(state.dashboardRefreshTimer); state.dashboardRefreshTimer = null; window.clearTimeout(state.dashboardMidnightTimer); state.dashboardMidnightTimer = null; stopBrowserOfflineReporter(); state.socket?.disconnect(); state.user = null; workspace.classList.add('hidden'); loginScreen.classList.remove('hidden'); document.querySelector('#login-form').reset(); }
});
try {
  const { user } = await api('/auth/me');
  state.user = user;
  showWorkspace();
} catch { app.classList.remove('loading'); }
