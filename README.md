# Ben Infotech Workforce

A development foundation for transparent attendance and device-availability tracking. The API owns authentication, session boundaries, event timestamps, role checks, policy settings, and real-time delivery. The browser never receives an authentication token in JavaScript; sessions use an HTTP-only cookie.

## Architecture

- `apps/api`: Express API, Node built-in SQLite database, bcrypt password hashes, Socket.IO, session and authorization middleware.
- `apps/web`: responsive vanilla HTML/CSS/JavaScript views for Admin and Employee roles, including an in-panel activity calendar whose month and year headings open month and year selection views.
- `apps/desktop`: Electron tray agent for Windows; reads OS idle duration and reports heartbeat state only after sign-in.
- `packages/shared`: shared status constants and time-duration calculation helper.
- `database/migrations`: initial relational schema, indexes, constraints, audit events.
- `tests`: API integration test using a temporary SQLite database and a controlled idle-seconds input.

The development database uses Node's built-in `node:sqlite`; use Node 22.13 or newer (Node 24 recommended). SQLite is local development storage, not a configured multi-host production database.

## Run Locally

1. Install Node.js 24 LTS and npm.
2. From this directory, install dependencies:

   ```powershell
   npm install
   ```

3. Create `.env` from `.env.example`, then set a unique admin email and a strong password of at least 12 characters. Do not commit `.env`.
   Generate a persistent encryption key for optional camera check-ins in PowerShell:

   ```powershell
   $bytes = New-Object byte[] 32
   [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
   [Convert]::ToBase64String($bytes)
   ```

   Put the resulting base64 value in `CAMERA_STORAGE_KEY` in `.env`. Keep it secret and back it up securely; changing or losing it makes previously stored photos unreadable. Do not print it in logs or commit it.
4. Create the first administrator:

   ```powershell
   npm run seed:admin
   ```

   Seeding fails safely if the email already exists. Admins can create employee accounts in the Employees view. Temporary passwords are hashed before storage and are never returned from the API.
5. Start the web application and API:

   ```powershell
   npm run dev
   ```

6. Open `http://localhost:3000` and sign in. To run the desktop agent in a second terminal:

   ```powershell
   npm run desktop
   ```

   The Electron window uses the same login page. The tray menu includes an explicit Start with Windows setting. Set `EAM_API_ORIGIN` if the API is hosted somewhere other than `http://localhost:3000`.

To build a Windows portable ZIP, run `npm run build:desktop`. Extract it to a managed location and deploy it through authorized endpoint-management tooling. This starter does not build an installer or auto-enable startup.

When Electron is installed for the desktop workspace, its package install lifecycle downloads the runtime. Web/API deployments do not need Electron.

## Verification

```powershell
npm test
```

The integration test covers invalid credentials, Admin/Employee login, account creation and duplicate rejection, role isolation, activity transition deduplication, server timestamps, real-time Socket.IO delivery, policy persistence, and logout. Activity tests submit mock OS idle durations; they do not wait for real inactivity.

## Privacy and Boundaries

- Optional camera check-ins are disabled by default and require both Admin enablement and explicit, revocable employee consent. On a current exact approved office Wi-Fi match, one still photo may be taken per Away period after a five-second visible countdown; the employee can cancel. The camera-active indicator and preview remain visible during capture. No audio or continuous video is captured.
- Photos are AES-256-GCM encrypted in the database, accessible only to the employee and authorized Admins, and automatically deleted after 30 days. Image access is audited. The encryption key must remain stable and backed up securely; rotating it requires re-encrypting existing photos first.
- This optional photo is a check-in record, not an emergency-response system, proof of absence, or reliable way to detect a collapse. It cannot guarantee that anyone will see or respond to a photo.
- No screenshots, saved video, typed content, clipboard data, or synthetic activity are collected or generated.
- Available means recent OS-reported user interaction, not productive or verified work time.
- Dashboard daily totals use the viewer's device-local midnight; interaction durations refresh every minute and all dashboard data reloads at midnight. A heartbeat gap closes Available or Away time after the 45-second stale timeout, including after a server restart. Report ranges are separate from this dashboard day boundary.
- The Windows desktop agent reports OS idle duration every 15 seconds and records foreground application/window-title changes for Employee sessions only while its reported SSID exactly matches an active office allowlist entry. Without a match, including when no SSID is reported, the session is marked Offline and activity details are not recorded. Browser-only employee sessions cannot report Wi-Fi and remain Offline; use the Windows desktop agent for office-only monitoring. Window titles may reveal webpage or document names. No typed content, raw coordinates, or click targets are sent or persisted. System suspend stops desktop heartbeats. On network loss, the next heartbeat marks the session Offline; if heartbeats stop entirely, the server marks stale sessions Offline after 45 seconds. After reconnect, only the current state is recorded. Exact transitions during an outage cannot be reconstructed.
- Admins can maintain an exact-match office SSID allowlist. The Windows agent reports the connected SSID; the Admin dashboard shows match status. SSID names are not secure proof of device identity and can be spoofed, so this is an informational monitoring gate, not a security boundary. Camera check-ins require a current matched approved SSID, employee consent, administrator enablement, and operating-system camera permission. A company-managed network-verification method, leave/shift workflows, scheduled reports, password reset/invitation links, PostgreSQL, and production deployment controls remain unimplemented.
- The endpoint trusts idle seconds reported by the signed-in desktop process; this is not a tamper-proof endpoint-management attestation system.

## Windows Verification

Run the desktop app on supported Windows 10/11 devices and verify OS idle readings, lock/unlock, sleep/wake, tray persistence, user-selected startup behavior, `netsh wlan show interfaces` SSID parsing, network loss/reconnect, session closure, and camera consent/countdown/cancel/permission behavior on an approved SSID. Electron `powerMonitor` provides OS idle time; no Windows input hooks or content capture are used. The agent has not been verified against every Windows build or endpoint-management policy.

## Office Wi-Fi Setup

1. Sign in as Admin using the desktop app to let that machine report its current SSID, or read the SSID from Windows Wi-Fi settings. A browser-only Admin session cannot report the current Wi-Fi.
2. Open Policies and add the exact SSID string as shown by Windows. SSIDs are matched exactly, including capitalization.
3. Keep the Employee desktop agent running. Availability and foreground-app monitoring are recorded only while its reported SSID exactly matches an active allowlist entry. The Admin dashboard shows each reporting device's last SSID and whether it matches the allowlist.

This confirms only the reported Wi-Fi name. SSIDs can be copied or spoofed; do not use this result as a security boundary. A current match is required before an opted-in, Admin-enabled employee can receive the disclosed one-photo check-in; it is not continuous camera monitoring.

Before organizational deployment, add HTTPS, backup/retention controls, invitation and password reset workflows, endpoint identity/attestation as appropriate, and security review. The bundled SQLite database is intended only for local development.
