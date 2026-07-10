// The folder dialog opened *behind* the operator's browser and timed out unseen. Proving the fix
// needs the same conditions: a real browser window holding the Windows foreground, and the dialog
// spawned by a background process that never received a click.
//
//   node tools/folderPickerProbe.mjs
//
// Opens a browser and a folder dialog on your screen for a few seconds, then closes both.

import { spawn, execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { pickFolderScript, powershellPath } from '../src/ui/server.js';

if (process.platform !== 'win32') {
  console.log('windows only — nothing to prove here');
  process.exit(0);
}

const ps = powershellPath();
const checks = [];
const check = (name, pass, detail = '') => {
  checks.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/** Which visible window is in the foreground, and who owns it? */
function foreground() {
  const script = `
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class F {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
'@
$h = [F]::GetForegroundWindow()
$c = New-Object Text.StringBuilder 256; [void][F]::GetClassName($h, $c, 256)
$t = New-Object Text.StringBuilder 256; [void][F]::GetWindowText($h, $t, 256)
$procId = 0; [void][F]::GetWindowThreadProcessId($h, [ref]$procId)
"$($c.ToString())|$($t.ToString())|$procId"
`;
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  const out = execFileSync(ps, ['-NoProfile', '-EncodedCommand', b64], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'], // PowerShell narrates "Preparing modules" onto stderr
  });
  const [cls, title, pid] = out.trim().split('|');
  return { cls, title, pid: Number(pid) };
}

/** Close the foreground dialog the way a Cancel click would, without touching the mouse. */
function closeForegroundDialog() {
  const script = `
$ProgressPreference = 'SilentlyContinue'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class C {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
'@
[void][C]::PostMessage([C]::GetForegroundWindow(), 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
`;
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  execFileSync(ps, ['-NoProfile', '-EncodedCommand', b64], { stdio: 'ignore' });
}

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();
await page.goto('data:text/html,<title>pretend this is the review grid</title><h1>foreground thief</h1>');
await page.bringToFront();
await page.waitForTimeout(1200);

const before = foreground();
check('the browser holds the foreground before we start', /Chrome_WidgetWin/.test(before.cls), `${before.cls} "${before.title}"`);

// Windows only refuses to let another process take the foreground when the one that has it
// *recently received real user input*. The operator clicking "Browse…" is exactly that, and it
// arms the lock against the picker. Playwright's clicks go into Chromium over the debug protocol
// and never touch the OS input queue, so a probe without this line tests the easy case and passes
// while the real thing fails silently behind the browser.
execFileSync(ps, [
  '-NoProfile',
  '-Command',
  `Add-Type -Namespace I -Name K -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte a, byte b, uint c, IntPtr d);'; [I.K]::keybd_event(0x10,0,0,[IntPtr]::Zero); [I.K]::keybd_event(0x10,0,2,[IntPtr]::Zero)`,
]);

// Exactly how the server spawns it: no console, no click, no input of its own.
const encoded = Buffer.from(pickFolderScript('C:\\Users'), 'utf16le').toString('base64');
const child = spawn(ps, ['-NoProfile', '-STA', '-EncodedCommand', encoded], { windowsHide: true });
let stdout = '';
child.stdout.on('data', (d) => (stdout += d));
const exited = new Promise((r) => child.on('close', r));
await new Promise((r) => setTimeout(r, 4500));

const after = foreground();
check('a folder dialog is now the foreground window', after.cls === '#32770', `${after.cls} "${after.title}"`);
check('and it belongs to the picker process', after.pid === child.pid, `dialog pid ${after.pid}, picker pid ${child.pid}`);

// Belt and braces: if Windows ever does refuse to raise it, the operator must still be able to
// find it. A dialog with no taskbar button and no Alt-Tab entry is a dialog that never opened.
const inTaskbar = execFileSync(ps, [
  '-NoProfile',
  '-Command',
  `Add-Type -Namespace T -Name W -MemberDefinition '
     [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
     [DllImport("user32.dll")] public static extern bool EnumWindows(P cb, IntPtr p);
     [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
     [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
     public delegate bool P(IntPtr h, IntPtr p);';
   $found = $false
   $cb = [T.W+P]{ param($h,$p)
     $pid2 = 0; [void][T.W]::GetWindowThreadProcessId($h, [ref]$pid2)
     if ($pid2 -eq ${child.pid} -and [T.W]::IsWindowVisible($h)) {
       $ex = [T.W]::GetWindowLong($h, -20)
       if (($ex -band 0x40000) -ne 0 -or ($ex -band 0x80) -eq 0) { $script:found = $true }
     }
     return $true
   }
   [void][T.W]::EnumWindows($cb, [IntPtr]::Zero)
   $found`,
]).toString().trim();
check('and it can be found in the taskbar or Alt-Tab', inTaskbar === 'True', `WS_EX_APPWINDOW/non-toolwindow: ${inTaskbar}`);

// Cancelling is not a failure. If it exited non-zero the grid would cry "could not open the
// folder picker" at an operator who simply changed their mind.
closeForegroundDialog();
const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 8000))]);
check('cancelling exits cleanly', code === 0, `exit code ${code}`);
check('cancelling selects no folder', stdout.trim() === '', JSON.stringify(stdout.trim()));

if (code === 'timeout') child.kill();
await browser.close();

const failed = checks.filter((c) => !c).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
