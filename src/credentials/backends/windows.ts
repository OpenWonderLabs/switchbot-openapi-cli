/**
 * Windows Credential Manager backend.
 *
 * Uses PowerShell + Win32 P/Invoke (`CredReadW` / `CredWriteW` /
 * `CredDeleteW`) instead of a native binding so `npm install` stays
 * toolchain-free on Windows runners. `cmdkey.exe` could create and
 * delete credentials but can't read the password back — reading is the
 * whole point, so PowerShell is mandatory.
 *
 * Target-name shape is `com.openclaw.switchbot:<profile>:<field>` so
 * `rundll32.exe keymgr.dll,KRShowKeyMgr` displays our entries in a
 * clear, groupable list.
 *
 * Credential values are passed to the child process via environment
 * variables, not argv — this keeps them out of any process listing
 * and out of the PowerShell command history. Env blocks on Windows
 * are only visible to the current user (and admins), so this is a
 * reasonable trade versus the alternatives (stdin requires a second
 * round-trip; temp files leave disk residue).
 */

import { spawn } from 'node:child_process';
import {
  accountFor,
  CREDENTIAL_SERVICE,
  CredentialBundle,
  CredentialStore,
  CredentialStoreDescribe,
  KeychainError,
} from '../keychain.js';

const PS_HEADER = `$ErrorActionPreference = 'Stop'
Add-Type -MemberDefinition @'
[DllImport("Advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern bool CredReadW(string target, int type, int flags, out System.IntPtr credentialPtr);

[DllImport("Advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern bool CredWriteW(ref CREDENTIAL cred, int flags);

[DllImport("Advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern bool CredDeleteW(string target, int type, int flags);

[DllImport("Advapi32.dll", SetLastError=true)]
public static extern void CredFree(System.IntPtr buffer);

[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct CREDENTIAL {
    public int Flags;
    public int Type;
    public System.IntPtr TargetName;
    public System.IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize;
    public System.IntPtr CredentialBlob;
    public int Persist;
    public int AttributeCount;
    public System.IntPtr Attributes;
    public System.IntPtr TargetAlias;
    public System.IntPtr UserName;
}
'@ -Name CredApi -Namespace Win32 | Out-Null
`;

const PS_GET = `${PS_HEADER}
$target = $env:SWITCHBOT_CRED_TARGET
$ptr = [System.IntPtr]::Zero
$ok = [Win32.CredApi]::CredReadW($target, 1, 0, [ref]$ptr)
if (-not $ok) { exit 2 }
$cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][Win32.CredApi+CREDENTIAL])
$bytes = New-Object byte[] $cred.CredentialBlobSize
[System.Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)
[Win32.CredApi]::CredFree($ptr) | Out-Null
$password = [System.Text.Encoding]::Unicode.GetString($bytes)
[Console]::Out.Write([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($password)))
`;

const PS_SET = `${PS_HEADER}
$target = $env:SWITCHBOT_CRED_TARGET
$user = $env:SWITCHBOT_CRED_USER
$value = $env:SWITCHBOT_CRED_VALUE
$bytes = [System.Text.Encoding]::Unicode.GetBytes($value)
$blob = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
[System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
$cred = New-Object Win32.CredApi+CREDENTIAL
$cred.Flags = 0
$cred.Type = 1
$cred.TargetName = [System.Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($target)
$cred.UserName = [System.Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($user)
$cred.CredentialBlob = $blob
$cred.CredentialBlobSize = $bytes.Length
$cred.Persist = 2
$cred.AttributeCount = 0
$ok = [Win32.CredApi]::CredWriteW([ref]$cred, 0)
[System.Runtime.InteropServices.Marshal]::FreeCoTaskMem($cred.TargetName)
[System.Runtime.InteropServices.Marshal]::FreeCoTaskMem($cred.UserName)
[System.Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
if (-not $ok) { exit 3 }
`;

const PS_DELETE = `${PS_HEADER}
$target = $env:SWITCHBOT_CRED_TARGET
$ok = [Win32.CredApi]::CredDeleteW($target, 1, 0)
if (-not $ok) {
  $errno = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  # 1168 = ERROR_NOT_FOUND — tolerate as idempotent delete.
  if ($errno -ne 1168) { exit 4 }
}
`;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function encodePs(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function runPowerShell(script: string, env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePs(script)],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
      },
    );
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (buf) => {
      stdout += buf.toString('utf-8');
    });
    proc.stderr.on('data', (buf) => {
      stderr += buf.toString('utf-8');
    });
    proc.on('error', () => resolve({ code: 127, stdout, stderr }));
    proc.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

function targetFor(profile: string, field: 'token' | 'secret'): string {
  return `${CREDENTIAL_SERVICE}:${accountFor(profile, field)}`;
}

export async function windowsAvailable(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  return new Promise((resolve) => {
    const proc = spawn('where', ['powershell.exe'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let ok = false;
    proc.stdout.on('data', (buf) => {
      if (buf.toString().trim().length > 0) ok = true;
    });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(ok && (code ?? 0) === 0));
  });
}

async function readField(profile: string, field: 'token' | 'secret'): Promise<string | null> {
  const res = await runPowerShell(PS_GET, {
    SWITCHBOT_CRED_TARGET: targetFor(profile, field),
  });
  if (res.code !== 0) return null;
  try {
    const decoded = Buffer.from(res.stdout, 'base64').toString('utf-8');
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

async function writeField(profile: string, field: 'token' | 'secret', value: string): Promise<void> {
  const res = await runPowerShell(PS_SET, {
    SWITCHBOT_CRED_TARGET: targetFor(profile, field),
    SWITCHBOT_CRED_USER: accountFor(profile, field),
    SWITCHBOT_CRED_VALUE: value,
  });
  if (res.code !== 0) {
    throw new KeychainError('credman', 'set', `CredWrite exit ${res.code}`);
  }
}

async function deleteField(profile: string, field: 'token' | 'secret'): Promise<void> {
  const res = await runPowerShell(PS_DELETE, {
    SWITCHBOT_CRED_TARGET: targetFor(profile, field),
  });
  if (res.code !== 0) {
    throw new KeychainError('credman', 'delete', `CredDelete exit ${res.code}`);
  }
}

export function createWindowsBackend(): CredentialStore {
  return {
    name: 'credman',
    async get(profile: string): Promise<CredentialBundle | null> {
      const token = await readField(profile, 'token');
      const secret = await readField(profile, 'secret');
      if (!token || !secret) return null;
      return { token, secret };
    },
    async set(profile: string, creds: CredentialBundle): Promise<void> {
      await writeField(profile, 'token', creds.token);
      await writeField(profile, 'secret', creds.secret);
    },
    async delete(profile: string): Promise<void> {
      await deleteField(profile, 'token');
      await deleteField(profile, 'secret');
    },
    describe(): CredentialStoreDescribe {
      return {
        backend: 'Credential Manager (Windows)',
        tag: 'credman',
        writable: true,
        notes: `Stored under target "${CREDENTIAL_SERVICE}:*" via Win32 CredRead/CredWrite.`,
      };
    },
  };
}
