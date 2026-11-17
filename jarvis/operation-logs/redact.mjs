/** Sanitize before any value reaches the durable index, including embedded JSON and command text. */
const secretKey = /^(?:authorization|proxyauthorization|cookie|setcookie|password|passwd|pwd|pin|secret|clientsecret|privatekey|credential|credentials|encryptedkey|apikey|accesstoken|refreshtoken|authtoken|targettoken|questiontoken|token|csrf|xjarviscsrf|connectionstring)$/i;
const normalizedKey = key => String(key).replace(/[^a-z0-9]/gi, '');
const sensitiveName = name => secretKey.test(normalizedKey(name)) || /(?:password|secret|credential)/i.test(name) || /modelkey$/i.test(normalizedKey(name)) || /(?:api|auth|access|refresh|session|private|csrf).*?(?:key|token)(?:id)?$/i.test(normalizedKey(name));
const textAssignment = /(?<![a-z0-9_.-])(["']?)([a-z_][a-z0-9_.-]{0,127})\1\s*[:=]\s*/gi;
const assignmentValue = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}&\]]+/y;

function redactAssignments(text) {
  const parts=[];let cursor=0;
  for(const match of text.matchAll(textAssignment)) {
    if(!sensitiveName(match[2])||match.index<cursor)continue;
    const start=match.index+match[0].length;assignmentValue.lastIndex=start;
    const value=assignmentValue.exec(text);if(!value||value[0].startsWith('[REDACTED'))continue;
    parts.push(text.slice(cursor,start),'[REDACTED]');cursor=start+value[0].length;
  }
  parts.push(text.slice(cursor));return parts.join('');
}

export function redactText(value) {
  let text = String(value);
  if (/^\s*[\[{]/.test(text)) {
    try { return JSON.stringify(redact(JSON.parse(text))); } catch { /* Embedded fragments are handled below. */ }
  }
  text = text.replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
  text = text.replace(/((?:^|\n)\s*(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*)[^\r\n]*/gi, '$1[REDACTED]');
  text = text.replace(/\b(?:Basic|Bearer)\s+[^\s"'<>;,}\]]+/gi, '[REDACTED AUTHORIZATION]');
  text = text.replace(/\bBearer\s+[^\s"'<>;,}\]]+/gi, 'Bearer [REDACTED]');
  text = text.replace(/\b(?:sk-[A-Za-z0-9_-]{6,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g, '[REDACTED]');
  text = text.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED JWT]');
  text = text.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
  text = text.replace(/([?&])([^=&\s]+)=([^&#\s"'<>]*)/g, (all, separator, name) => {
    let decoded = name; try { decoded = decodeURIComponent(name); } catch { /* Keep literal malformed names. */ }
    return sensitiveName(decoded) ? `${separator}${name}=[REDACTED]` : all;
  });
  return redactAssignments(text);
}

export function redact(value, ancestors = new Set()) {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return String(value);
  if (value === undefined) return null;
  if (typeof value !== 'object') return String(value);
  if (ancestors.has(value)) return '[Circular]';
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => redact(item, ancestors));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      sensitiveName(key) ? '[REDACTED]' : redact(item, ancestors)]));
  } finally { ancestors.delete(value); }
}
