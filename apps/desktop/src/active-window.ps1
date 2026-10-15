param(
  [int]$ExcludeProcessId = -1,
  [switch]$Once
)

$signature = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class BenInfotechActiveWindow
{
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr windowHandle, StringBuilder text, int maxCount);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr windowHandle, out uint processId);
}
'@

if (-not ('BenInfotechActiveWindow' -as [type])) {
  Add-Type -TypeDefinition $signature
}

do {
  try {
    $windowHandle = [BenInfotechActiveWindow]::GetForegroundWindow()
    [uint32]$processId = 0
    [void][BenInfotechActiveWindow]::GetWindowThreadProcessId($windowHandle, [ref]$processId)
    if ($processId -ne $ExcludeProcessId) {
      $process = Get-Process -Id $processId -ErrorAction Stop
      $title = [System.Text.StringBuilder]::new(512)
      [void][BenInfotechActiveWindow]::GetWindowText($windowHandle, $title, $title.Capacity)
      if ($process.ProcessName -and $title.Length -gt 0) {
        [pscustomobject]@{ application = $process.ProcessName; windowTitle = $title.ToString() } | ConvertTo-Json -Compress
      }
    }
  } catch {}

  if ($Once) { break }
  [System.Threading.Thread]::Sleep(2000)
} while ($true)