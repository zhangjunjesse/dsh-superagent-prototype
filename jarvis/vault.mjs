import { execFileSync } from 'node:child_process';

// Secret input travels over stdin, never process arguments, files or logging.
function transform(value, decrypt) {
  if (process.platform !== 'win32') throw new Error('保存密钥需要 Windows 当前用户加密服务');
  const operation = decrypt ? 'Unprotect' : 'Protect';
  const script = `Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $result=[Security.Cryptography.ProtectedData]::${operation}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: value, encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
export const vault = {
  seal: text => transform(Buffer.from(text, 'utf8').toString('base64'), false),
  open: encrypted => Buffer.from(transform(encrypted, true), 'base64').toString('utf8'),
};
