# Windows desktop agent

After Employee sign-in, the agent reports operating-system idle duration and, on Windows, foreground application/window-title changes. Titles can reveal webpage or document names and are shown in the employee Activity timeline. Admin sessions report only their own current SSID for the network settings view. On Windows, the agent reads the SSID with `netsh wlan show interfaces`. When the server reports Away, a small desktop banner appears and stays visible until status returns to Available; the tray tooltip also shows current state. Windows lock/unlock is reported as Away/Available, and system suspend stops heartbeats so the server can mark the session Offline. It does not capture typed content, screenshots, audio, or camera images.

An Admin can add exact SSID strings under Policies. Match state is informational because SSIDs can be spoofed. An approved match never activates the camera; camera access and capture remain disabled.

Start the API first, then run `npm run desktop` from the project root. The tray menu provides the dashboard, explicit Start with Windows opt-in, sign-out, and quit. Closing the window hides it to the tray; quitting ends the server session. Set `EAM_API_ORIGIN` to the API origin when it is not `http://localhost:3000`.

To create a Windows portable ZIP, run `npm run build:desktop` from the project root. Extract it to a managed location and deploy it through the organization's authorized endpoint-management process. This starter does not produce an installer or enable startup automatically.

The agent reports the current idle state after a network reconnect; it does not fabricate timestamps for transitions that could not be observed while disconnected. The server marks a live session Offline after 45 seconds without an agent heartbeat. Verify the idle timer, lock/unlock and suspend/resume behavior, startup opt-in, and packaging on supported Windows 10/11 machines before deployment.
