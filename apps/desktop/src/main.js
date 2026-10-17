import { app, BrowserWindow, Menu, Tray, nativeImage, powerMonitor, screen, session } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { getAwayPopupAction } from '@eam/shared';

const apiOrigin = process.env.EAM_API_ORIGIN || 'http://localhost:3000';
const workforceOrigin = new URL(apiOrigin).origin;
const cookieName = 'eam_session';
const execFileAsync = promisify(execFile);
const activeWindowScript = resolve(dirname(fileURLToPath(import.meta.url)), 'active-window.ps1');
let windowRef;
let tray;
let awayPopup;
let heartbeatTimer;
let activeWindowProcess;
let activeWindowBuffer = '';
let previousForegroundWindow = null;
let applicationSwitchQueue = Promise.resolve();
let currentStatus = 'unknown';
let currentRole = null;
let currentNetworkStatus = 'unknown';
let cameraWindowShownForAwayPeriod = false;
let cameraEligibilityCheckedForAwayPeriod = false;
let quitting = false;
let quitReady = false;
let requestInFlight = false;
let screenLocked = false;
let systemSuspended = false;

function stopApplicationMonitor() {
  const monitor = activeWindowProcess;
  activeWindowProcess = null;
  activeWindowBuffer = '';
  previousForegroundWindow = null;
  monitor?.kill();
}

function reportForegroundWindow(windowInfo) {
  if (currentRole !== 'employee' || currentNetworkStatus !== 'matched' || screenLocked || !windowInfo?.application || !windowInfo?.windowTitle) return;
  const knownNames = { Code: 'Visual Studio Code', chrome: 'Google Chrome', msedge: 'Microsoft Edge', firefox: 'Mozilla Firefox' };
  const current = { application: knownNames[windowInfo.application] || windowInfo.application, windowTitle: windowInfo.windowTitle.trim() };
  if (!current.windowTitle) return;
  const key = `${current.application}\0${current.windowTitle}`;
  if (previousForegroundWindow?.key === key) return;
  const previous = previousForegroundWindow;
  previousForegroundWindow = { ...current, key };
  const body = JSON.stringify({
    previousApplication: previous?.application || null,
    previousWindowTitle: previous?.windowTitle || null,
    ...current
  });
  applicationSwitchQueue = applicationSwitchQueue.then(async () => {
    if (currentRole !== 'employee' || currentNetworkStatus !== 'matched' || screenLocked) return;
    const response = await request('/api/activity/application-switch', { method: 'POST', body });
    if (!response.ok) console.error(`Application switch report failed (${response.status})`);
  }).catch((error) => console.error('Application switch report failed', error));
}

function startApplicationMonitor() {
  if (process.platform !== 'win32' || activeWindowProcess) return;
  const monitor = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', activeWindowScript,
    '-ExcludeProcessId', String(process.pid)
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  activeWindowProcess = monitor;
  monitor.stdout.setEncoding('utf8');
  monitor.stdout.on('data', (chunk) => {
    activeWindowBuffer += chunk;
    const lines = activeWindowBuffer.split(/\r?\n/);
    activeWindowBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try { reportForegroundWindow(JSON.parse(line)); } catch {}
    }
  });
  monitor.once('error', (error) => {
    if (activeWindowProcess === monitor) stopApplicationMonitor();
    console.error('Foreground application monitor failed', error);
  });
  monitor.once('close', () => {
    if (activeWindowProcess === monitor) stopApplicationMonitor();
  });
}

function getTrayImage() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect x="1" y="1" width="30" height="30" rx="9" fill="#d8f36a"/><path d="M9 23V9h4l6 8V9h4v14h-4l-6-8v8z" fill="#173b3e"/></svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}
function getSessionCookie() {
  return session.defaultSession.cookies.get({ url: apiOrigin }).then((cookies) => cookies.find((item) => item.name === cookieName)?.value || null);
}
async function request(path, options = {}) {
  const token = await getSessionCookie();
  if (!token) return { status: 401 };
  return fetch(new URL(path, apiOrigin), {
    ...options,
    headers: { Cookie: `${cookieName}=${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
  });
}
async function getCurrentWifiSsid() {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await execFileAsync('netsh.exe', ['wlan', 'show', 'interfaces'], { windowsHide: true, timeout: 2500, maxBuffer: 65536 });
    return stdout.match(/^\s*SSID\s*:\s*(.+?)\s*$/mi)?.[1] || null;
  } catch {
    return null;
  }
}
function updateTray(status) {
  const popupAction = getAwayPopupAction(currentStatus, status);
  currentStatus = status;
  if (status !== 'away') {
    cameraWindowShownForAwayPeriod = false;
    cameraEligibilityCheckedForAwayPeriod = false;
  }
  tray?.setToolTip(`Ben Infotech Workforce | ${status[0].toUpperCase()}${status.slice(1)}`);
  if (popupAction === 'show') showAwayPopup();
  if (popupAction === 'close') closeAwayPopup();
}
async function showCameraCheckinWindowIfEligible() {
  if (cameraEligibilityCheckedForAwayPeriod || cameraWindowShownForAwayPeriod || currentRole !== 'employee' || currentStatus !== 'away'
    || currentNetworkStatus !== 'matched') return;
  const response = await request('/api/employee/dashboard');
  if (!response.ok) {
    console.error(`Camera check-in eligibility check failed (${response.status})`);
    return;
  }
  const dashboard = await response.json();
  if (dashboard.status !== 'away' || dashboard.officeNetworkStatus !== 'matched'
    || !dashboard.cameraPolicy?.enabled || !dashboard.cameraConsent?.enabled) return;
  cameraEligibilityCheckedForAwayPeriod = true;
  cameraWindowShownForAwayPeriod = true;
  windowRef?.showInactive();
}
function updateAdminNetwork(status) {
  currentNetworkStatus = status;
  tray?.setToolTip(`Ben Infotech Workforce | Office Wi-Fi: ${status.replaceAll('_', ' ')}`);
}
function showAwayPopup() {
  if (awayPopup && !awayPopup.isDestroyed()) return;
  const workArea = screen.getPrimaryDisplay().workArea;
  const width = 340;
  const height = 112;
  awayPopup = new BrowserWindow({
    x: workArea.x + workArea.width - width - 18,
    y: workArea.y + workArea.height - height - 18,
    width,
    height,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    show: false,
    backgroundColor: '#173b3e',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  const content = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Availability status</title><body style="margin:0;background:#173b3e;color:#fff;font:13px 'Segoe UI',sans-serif"><main style="height:112px;box-sizing:border-box;padding:19px 20px;border-left:4px solid #d8f36a"><div style="font-size:10px;letter-spacing:1px;color:#d8f36a;font-weight:700">BEN INFOTECH WORKFORCE</div><strong style="display:block;margin-top:8px;font-size:17px">You are Away</strong><div style="margin-top:5px;color:#d4e3e0;font-size:11px">Move your mouse or use your keyboard to return to Available.</div></main></body></html>`;
  awayPopup.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(content)}`);
  awayPopup.once('ready-to-show', () => awayPopup?.showInactive());
  const popup = awayPopup;
  popup.on('closed', () => { if (awayPopup === popup) awayPopup = null; });
}
function closeAwayPopup() {
  if (awayPopup && !awayPopup.isDestroyed()) awayPopup.close();
  awayPopup = null;
}
function buildTrayMenu() {
  const loginItem = app.getLoginItemSettings();
  return Menu.buildFromTemplate([
    { label: currentRole === 'admin' ? `Office Wi-Fi: ${currentNetworkStatus.replaceAll('_', ' ')}` : `Current status: ${currentStatus}`, enabled: false },
    { label: 'Open workforce dashboard', click: () => { windowRef?.show(); windowRef?.focus(); } },
    { label: 'Start with Windows', type: 'checkbox', checked: loginItem.openAtLogin, click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
    { label: 'Sign out', click: async () => { try { await request('/api/auth/logout', { method: 'POST' }); } finally { updateTray('unknown'); windowRef?.webContents.reload(); } } },
    { type: 'separator' },
    { label: 'Quit and end session', click: () => app.quit() }
  ]);
}
function refreshMenu() { if (tray) tray.setContextMenu(buildTrayMenu()); }
async function reportHeartbeat() {
  if (requestInFlight || !app.isReady() || systemSuspended) return;
  requestInFlight = true;
  try {
    const response = await request('/api/auth/me');
    if (!response.ok) { currentRole = null; currentNetworkStatus = 'unknown'; stopApplicationMonitor(); updateTray('unknown'); refreshMenu(); return; }
    const auth = await response.json();
    const networkSsid = await getCurrentWifiSsid();
    if (auth.user.role === 'admin') {
      currentNetworkStatus = 'unknown';
      stopApplicationMonitor();
      currentRole = 'admin';
      const networkResponse = await request('/api/admin/office-networks/current-match', { method: 'POST', body: JSON.stringify({ ssid: networkSsid }) });
      if (networkResponse.ok) {
        const result = await networkResponse.json();
        updateAdminNetwork(result.currentDevice.officeNetworkStatus);
      } else {
        updateAdminNetwork('unknown');
      }
      return;
    }
    currentRole = 'employee';
    const idleSeconds = powerMonitor.getSystemIdleTime();
    const heartbeat = await request('/api/activity/heartbeat', { method: 'POST', body: JSON.stringify({ idleSeconds, locked: screenLocked, networkSsid }) });
    if (heartbeat.ok) {
      const result = await heartbeat.json();
      currentNetworkStatus = result.officeNetworkStatus;
      if (result.officeNetworkStatus === 'matched') startApplicationMonitor();
      else stopApplicationMonitor();
      updateTray(result.status);
      await showCameraCheckinWindowIfEligible();
    } else {
      currentNetworkStatus = 'unknown';
      stopApplicationMonitor();
      updateTray('unknown');
    }
  } catch {
    currentNetworkStatus = 'unknown';
    stopApplicationMonitor();
    updateTray('unknown');
  } finally {
    requestInFlight = false;
    refreshMenu();
  }
}
function createWindow() {
  windowRef = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 700,
    minHeight: 560,
    show: false,
    backgroundColor: '#f5f8f8',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  windowRef.loadURL(apiOrigin);
  windowRef.once('ready-to-show', () => windowRef.show());
  windowRef.on('close', (event) => {
    if (!quitting) { event.preventDefault(); windowRef.hide(); }
  });
  windowRef.webContents.on('did-finish-load', reportHeartbeat);
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const isWorkforceWindow = windowRef && webContents === windowRef.webContents;
    const isCameraRequest = permission === 'media'
      && details.isMainFrame
      && details.mediaTypes?.length === 1
      && details.mediaTypes.includes('video');
    let isWorkforceOrigin = false;
    try { isWorkforceOrigin = new URL(details.requestingUrl).origin === workforceOrigin; } catch {}
    callback(Boolean(isWorkforceWindow && isCameraRequest && isWorkforceOrigin));
  });
  if (process.platform === 'win32' && process.env.EAM_ENABLE_STARTUP === '1') {
    app.setLoginItemSettings({ openAtLogin: true });
  }
  tray = new Tray(getTrayImage());
  tray.setToolTip('Ben Infotech Workforce | Unknown');
  refreshMenu();
  tray.on('double-click', () => { windowRef?.show(); windowRef?.focus(); });
  createWindow();
  heartbeatTimer = setInterval(reportHeartbeat, 15_000);
  heartbeatTimer.unref();
  powerMonitor.on('suspend', () => { systemSuspended = true; });
  powerMonitor.on('resume', () => { systemSuspended = false; reportHeartbeat(); });
  powerMonitor.on('lock-screen', () => { screenLocked = true; reportHeartbeat(); });
  powerMonitor.on('unlock-screen', () => { screenLocked = false; reportHeartbeat(); });
});

app.on('activate', () => { if (windowRef) { windowRef.show(); windowRef.focus(); } else createWindow(); });
app.on('before-quit', (event) => {
  if (quitReady) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  clearInterval(heartbeatTimer);
  stopApplicationMonitor();
  closeAwayPopup();
  request('/api/auth/logout', { method: 'POST' }).catch(() => {}).finally(() => {
    quitReady = true;
    app.quit();
  });
});
app.on('window-all-closed', () => {});
