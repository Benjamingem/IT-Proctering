const $ = (selector) => document.querySelector(selector);
const state = {
  user: null,
  status: 'unknown',
  officeNetworkStatus: 'unknown',
  dashboard: null,
  refreshTimer: null,
  awayPeriodKey: null,
  handledAwayPeriodKey: null,
  cameraTimer: null,
  cameraStream: null,
  cameraCancelled: false
};

const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

function formatTime(value) {
  if (!value) return 'Not reported';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

function formatDuration(milliseconds) {
  const minutes = Math.floor(Math.max(0, Number(milliseconds) || 0) / 60000);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function showLogin() {
  stopCamera();
  window.clearInterval(state.refreshTimer);
  state.refreshTimer = null;
  state.user = null;
  $('#workspace').classList.add('hidden');
  $('#admin-notice').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
}

function showAccount(user) {
  state.user = user;
  $('#login-view').classList.add('hidden');
  if (user.role === 'admin') {
    $('#workspace').classList.add('hidden');
    $('#admin-notice').classList.remove('hidden');
    return;
  }
  $('#admin-notice').classList.add('hidden');
  $('#workspace').classList.remove('hidden');
  $('#user-name').textContent = user.fullName;
  $('#user-email').textContent = user.email;
  $('#avatar').textContent = user.fullName.slice(0, 1).toUpperCase();
  void refreshDashboard();
  window.clearInterval(state.refreshTimer);
  state.refreshTimer = window.setInterval(() => { void refreshDashboard(); }, 15_000);
}

function renderStatus(status, networkStatus, lastHeartbeatAt) {
  if (status) state.status = status;
  if (networkStatus) state.officeNetworkStatus = networkStatus;
  const card = $('.status-card');
  card.dataset.status = state.status;
  $('#current-status').textContent = state.status;
  $('#status-detail').textContent = lastHeartbeatAt
    ? `Last device report: ${formatTime(lastHeartbeatAt)}`
    : 'Waiting for the Windows agent.';
  const labels = {
    matched: 'Approved Wi-Fi',
    not_matched: 'Not approved',
    not_configured: 'No approved Wi-Fi configured',
    unknown: 'Wi-Fi not reported'
  };
  const networkLabel = labels[state.officeNetworkStatus] || 'Wi-Fi status unknown';
  $('#network-notice').textContent = state.officeNetworkStatus === 'matched'
    ? `Your device is on ${networkLabel}. The Windows agent is reporting activity.`
    : `Availability, Away status, and camera check-ins require the Windows desktop app to report an exact match to an approved office Wi-Fi network. Current status: ${networkLabel}.`;
  $('#service-dot').classList.toggle('online', state.officeNetworkStatus === 'matched');
  $('#service-label').textContent = state.officeNetworkStatus === 'matched' ? 'Agent connected' : 'Waiting for office Wi-Fi';
}

function renderTimeline(events = []) {
  const rows = events.slice(-12).reverse();
  $('#event-list').innerHTML = rows.length
    ? rows.map((event) => `<li><span class="event-time">${escapeHtml(formatTime(event.occurredAt))}</span><span>Changed to <strong>${escapeHtml(event.status)}</strong></span></li>`).join('')
    : '<li class="muted">No activity recorded yet. The agent will add Available/Away events after an approved Wi-Fi match.</li>';
}

function stopCamera() {
  window.clearInterval(state.cameraTimer);
  state.cameraTimer = null;
  state.cameraStream?.getTracks().forEach((track) => track.stop());
  state.cameraStream = null;
  const video = $('#camera-preview');
  if (video) video.srcObject = null;
  $('#camera-panel')?.classList.add('hidden');
}

function setCameraResult(message, imageUrl = null) {
  $('#camera-panel').classList.remove('hidden');
  $('#camera-message').textContent = message;
  $('#camera-preview').classList.add('hidden');
  if (imageUrl) {
    $('#camera-photo').src = imageUrl;
    $('#camera-photo').classList.remove('hidden');
  }
  $('#cancel-camera').classList.add('hidden');
}

async function startCameraCheckin(periodKey) {
  state.handledAwayPeriodKey = periodKey;
  state.cameraCancelled = false;
  $('#camera-panel').classList.remove('hidden');
  $('#camera-photo').classList.add('hidden');
  $('#camera-error').textContent = '';
  $('#camera-preview').classList.add('hidden');
  $('#cancel-camera').classList.remove('hidden');
  let countdown = 5;
  $('#camera-message').textContent = `Camera check-in starts in ${countdown} seconds. Keep this indicator visible; no audio or video is recorded.`;
  state.cameraTimer = window.setInterval(async () => {
    countdown -= 1;
    if (countdown > 0) {
      $('#camera-message').textContent = `Camera check-in starts in ${countdown} seconds. Keep this indicator visible; no audio or video is recorded.`;
      return;
    }
    window.clearInterval(state.cameraTimer);
    state.cameraTimer = null;
    const dashboard = state.dashboard;
    if (state.cameraCancelled || document.hidden || state.status !== 'away' || state.awayPeriodKey !== periodKey
      || !dashboard?.cameraPolicy?.enabled || !dashboard?.cameraConsent?.enabled
      || state.officeNetworkStatus !== 'matched') {
      stopCamera();
      return;
    }
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is unavailable in this app.');
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      if (state.cameraCancelled || document.hidden || state.status !== 'away' || state.awayPeriodKey !== periodKey) {
        stream.getTracks().forEach((track) => track.stop());
        stopCamera();
        return;
      }
      state.cameraStream = stream;
      const video = $('#camera-preview');
      video.srcObject = stream;
      video.classList.remove('hidden');
      $('#camera-message').textContent = 'Camera active — capturing one still photo. You can cancel now.';
      await video.play();
      if (!video.videoWidth || !video.videoHeight) throw new Error('The camera did not provide an image.');
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('The camera photo could not be prepared.');
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve, reject) => canvas.toBlob((image) => {
        if (image) resolve(image);
        else reject(new Error('The camera photo could not be created.'));
      }, 'image/jpeg', 0.82));
      if (state.cameraCancelled || document.hidden || state.status !== 'away' || state.awayPeriodKey !== periodKey) {
        stopCamera();
        return;
      }
      $('#cancel-camera').disabled = true;
      $('#camera-message').textContent = 'Saving the one photo check-in securely.';
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const result = await window.workforceDesktop.uploadCamera(bytes);
      const imageUrl = result.captured ? URL.createObjectURL(blob) : null;
      stopCamera();
      setCameraResult(result.captured
        ? 'Photo check-in saved securely. It is visible to you and authorized Admins and will be deleted after 30 days.'
        : 'A photo check-in is already saved for this Away period.', imageUrl);
    } catch (error) {
      stopCamera();
      $('#camera-panel').classList.remove('hidden');
      $('#camera-message').textContent = 'No photo was saved. Check camera permission and your approved office Wi-Fi connection.';
      $('#camera-error').textContent = `Camera check-in failed: ${error.message}`;
      $('#cancel-camera').textContent = 'Dismiss';
      $('#cancel-camera').classList.remove('hidden');
    } finally {
      $('#cancel-camera').disabled = false;
    }
  }, 1000);
}

function syncCamera(data) {
  const nextAwayPeriod = data.status === 'away' ? data.awayStartedAt : null;
  if (state.awayPeriodKey !== nextAwayPeriod) {
    stopCamera();
    state.awayPeriodKey = nextAwayPeriod;
    if (!nextAwayPeriod) state.handledAwayPeriodKey = null;
  }
  const eligible = data.status === 'away'
    && data.cameraPolicy?.enabled
    && data.cameraPolicy?.requiresOfficeNetwork
    && data.cameraConsent?.enabled
    && data.officeNetworkStatus === 'matched';
  if (data.currentAwayCheckin && eligible) {
    state.handledAwayPeriodKey = nextAwayPeriod;
    stopCamera();
    setCameraResult('A photo check-in is already saved for this Away period.');
    return;
  }
  if (!eligible) {
    stopCamera();
    return;
  }
  if (state.handledAwayPeriodKey !== nextAwayPeriod && !document.hidden) void startCameraCheckin(nextAwayPeriod);
}

async function refreshDashboard() {
  if (!state.user || state.user.role !== 'employee') return;
  try {
    const data = await window.workforceDesktop.dashboard();
    state.dashboard = data;
    renderStatus(data.status, data.officeNetworkStatus, data.session?.lastHeartbeatAt);
    $('#first-available').textContent = formatTime(data.firstAvailableAt);
    $('#away-sessions').textContent = String(data.awaySessions);
    $('#available-time').textContent = formatDuration(data.availableInteractionMs);
    $('#away-time').textContent = formatDuration(data.awayDurationMs);
    $('#camera-policy').textContent = `Admin policy: ${data.cameraPolicy.enabled ? 'enabled' : 'disabled'} · Office Wi-Fi required`;
    $('#camera-consent').checked = Boolean(data.cameraConsent.enabled);
    $('#consent-result').textContent = data.cameraConsent.enabled
      ? 'Consent is on. You may revoke it at any time.'
      : 'Camera check-ins are off until you opt in.';
    renderTimeline(data.events);
    syncCamera(data);
  } catch (error) {
    $('#network-notice').textContent = error.message;
    $('#service-label').textContent = 'Unable to refresh';
  }
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const button = $('#login-button');
  $('#login-error').textContent = '';
  button.disabled = true;
  try {
    const user = await window.workforceDesktop.login({
      email: form.get('email'),
      password: form.get('password')
    });
    showAccount(user);
  } catch (error) {
    $('#login-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

async function signOut() {
  try {
    await window.workforceDesktop.logout();
    $('#login-form').reset();
    showLogin();
  } catch (error) {
    $('#login-error').textContent = `Sign out failed: ${error.message}`;
  }
}
$('#logout-button').addEventListener('click', signOut);
$('#admin-signout').addEventListener('click', signOut);

$('#save-consent').addEventListener('click', async () => {
  const button = $('#save-consent');
  button.disabled = true;
  $('#consent-result').textContent = 'Saving…';
  try {
    const result = await window.workforceDesktop.saveConsent($('#camera-consent').checked);
    $('#consent-result').textContent = result.enabled
      ? 'Consent saved. You may revoke it at any time.'
      : 'Consent revoked. No new photos will be captured.';
    await refreshDashboard();
  } catch (error) {
    $('#consent-result').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$('#cancel-camera').addEventListener('click', () => {
  state.cameraCancelled = true;
  stopCamera();
});

$('#start-with-windows').addEventListener('change', async (event) => {
  event.currentTarget.disabled = true;
  try {
    await window.workforceDesktop.setStartWithWindows(event.currentTarget.checked);
  } catch (error) {
    event.currentTarget.checked = !event.currentTarget.checked;
    $('#network-notice').textContent = `Startup preference could not be saved: ${error.message}`;
  } finally {
    event.currentTarget.disabled = false;
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && (state.cameraTimer || state.cameraStream || !$('#camera-panel').classList.contains('hidden'))) {
    state.cameraCancelled = true;
    stopCamera();
  }
});

window.workforceDesktop.onStatus((status) => {
  renderStatus(status.status, status.officeNetworkStatus, status.lastHeartbeatAt);
  if (status.signedOut) showLogin();
  else if (state.user?.role === 'employee') void refreshDashboard();
});
window.workforceDesktop.onSessionEnded(showLogin);

try {
  $('#start-with-windows').checked = await window.workforceDesktop.getStartWithWindows();
  const user = await window.workforceDesktop.currentUser();
  if (user) showAccount(user);
} catch (error) {
  $('#login-error').textContent = error.message;
}
