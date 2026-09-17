import { redact as upstreamRedact } from 'pi-warden';

// Extend, rather than replace, Warden's token and private-key redaction.
export const secretKey = /^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|client[-_]?secret|secret|password|passwd|pwd|authori[sz]ation|private[-_]?key)$/i;
const quotedAssignment = /(["'](?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|client[-_]?secret|secret|password|passwd|pwd|authori[sz]ation|private[-_]?key)["']\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,\s}\]]+)/gi;
export function redact(text: string): string {
  return upstreamRedact(text.replace(quotedAssignment, '$1"[redacted]"'));
}
