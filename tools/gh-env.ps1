# Activate the workspace-local GitHub CLI for the current shell.
#
# Why a local copy: the machine has no `gh`, and installing one system-wide is not
# necessary. `tools/install-gh.ps1` unpacks it under .toolchain/gh, and this
# script puts it on PATH and authenticates it for the current process only.
#
# Why not `gh auth login`: that path validates the token's scopes and demands
# `read:org`, which the stored Git Credential Manager token (scopes: gist, repo,
# workflow) does not have. Supplying the token through GH_TOKEN skips that check
# and works for `gh release`, `gh api`, and `gh repo`.
#
# The token is never written to disk, never printed, and never passed on a
# command line. It is read from Windows Credential Manager into the process
# environment and is gone when the shell exits.
#
# Usage:
#   . .\tools\gh-env.ps1
#   gh release list --repo yueshen0211/dsh-android

$ErrorActionPreference = 'Stop'

$WorkspaceRoot = Split-Path -Parent $PSScriptRoot
$GhExe = Join-Path $WorkspaceRoot '.toolchain\gh\bin\gh.exe'

if (-not (Test-Path $GhExe)) {
    throw "gh not found at $GhExe - run .\tools\install-gh.ps1 first"
}

# Read the stored GitHub credential: target, Type=1 (generic), no flags.
$credSource = @'
using System;
using System.Runtime.InteropServices;
public class DshCredReader {
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr credential);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  public static string Read(string target) {
    IntPtr handle;
    if (!CredRead(target, 1, 0, out handle)) { return ""; }
    var credential = (CREDENTIAL)Marshal.PtrToStructure(handle, typeof(CREDENTIAL));
    string secret = "";
    if (credential.CredentialBlobSize > 0 && credential.CredentialBlob != IntPtr.Zero) {
      var bytes = new byte[credential.CredentialBlobSize];
      Marshal.Copy(credential.CredentialBlob, bytes, 0, credential.CredentialBlobSize);
      secret = System.Text.Encoding.Unicode.GetString(bytes);
    }
    CredFree(handle);
    return secret;
  }
}
'@

if (-not ('DshCredReader' -as [type])) {
    Add-Type -TypeDefinition $credSource -Language CSharp
}

$token = [DshCredReader]::Read('LegacyGeneric:target=git:https://github.com')
if (-not $token) {
    throw "No stored GitHub credential found. Run 'git push' once against GitHub to let Git Credential Manager store one, or set GH_TOKEN yourself."
}

# GH_TOKEN is read by gh per invocation; it is scoped to this shell only.
$env:GH_TOKEN = $token
$env:PATH = (Join-Path $WorkspaceRoot '.toolchain\gh\bin') + ';' + $env:PATH

Write-Host "gh ready (token from Windows Credential Manager, this shell only)" -ForegroundColor Green
Write-Host "  gh  : $GhExe"
Write-Host "  repo: https://github.com/yueshen0211/dsh-android"
