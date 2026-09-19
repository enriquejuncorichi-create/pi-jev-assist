import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/** Reconstruct the file as it would be after this write/edit (pi-jev-code). */
export function reconstruct(path: string, cwd: string, input: Record<string, unknown>, limit = 8_000): string | undefined {
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  if (typeof input.content === 'string') return input.content.slice(0, limit);
  let body = '';
  try { if (existsSync(abs)) body = readFileSync(abs, 'utf8'); } catch { return undefined; }
  const edits = Array.isArray(input.edits) ? input.edits : (typeof input.oldText === 'string' ? [{ oldText: input.oldText, newText: input.newText }] : []);
  if (!edits.length) return body.slice(0, limit);
  for (const raw of edits) {
    const e = raw as { oldText?: unknown; newText?: unknown };
    if (typeof e.oldText !== 'string' || typeof e.newText !== 'string') return undefined;
    const at = body.indexOf(e.oldText);
    if (at < 0) return undefined;
    body = body.slice(0, at) + e.newText + body.slice(at + e.oldText.length);
  }
  return body.slice(0, limit);
}
