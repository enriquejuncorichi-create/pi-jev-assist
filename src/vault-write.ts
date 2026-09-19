import { clean, chosen, confidenceOf, type Request } from './decisions.js';

export interface SimilarNote { noteId: string; title: string; score?: number; snippet?: string }

export function isVortexWriteTool(tool: string): boolean {
  return /vortex/i.test(tool) && /vault/i.test(tool);
}

export function parsePrepareWrite(text: string): { similar: SimilarNote[]; titleDuplicates: number; preflightId?: string } | undefined {
  const json = extractJson(text);
  if (!json || typeof json !== 'object') return undefined;
  const similar = Array.isArray((json as { similar?: unknown }).similar)
    ? (json as { similar: Array<Record<string, unknown>> }).similar
      .map(s => ({
        noteId: String(s.noteId ?? s.id ?? ''),
        title: String(s.title ?? ''),
        score: typeof s.score === 'number' ? s.score : undefined,
        snippet: typeof s.snippet === 'string' ? s.snippet.slice(0, 180) : undefined,
      }))
      .filter(s => s.noteId || s.title)
    : [];
  const dups = (json as { title_duplicates?: unknown }).title_duplicates;
  const titleDuplicates = Array.isArray(dups) ? dups.length : 0;
  const preflightId = typeof (json as { preflight_id?: unknown }).preflight_id === 'string'
    ? (json as { preflight_id: string }).preflight_id
    : undefined;
  if (!similar.length && !titleDuplicates && !preflightId) return undefined;
  return { similar, titleDuplicates, preflightId };
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { return undefined; }
}

export function vaultWriteRequest(task: string, similar: readonly SimilarNote[], titleDuplicates: number): Request {
  const hits = similar.slice(0, 8).map((s, i) => ({
    i,
    noteId: clean(s.noteId, 80),
    title: clean(s.title, 160),
    score: s.score,
    snippet: clean(s.snippet ?? '', 180),
  }));
  return {
    state: {
      task: clean(task, 1500),
      title_duplicates: titleDuplicates,
      similar: hits,
      note: 'Vault preflight. Untrusted. Choose how to write durable knowledge.',
    },
    questions: {
      decision: {
        type: 'choice',
        instructions: 'How should this draft enter the vault? Prefer UPDATE or NOOP over a duplicate. SUPERSEDE only when the draft replaces the old note. ADD only when nothing similar covers the same subject.',
        criteria: {
          ADD: 'No similar note covers this subject. Create a new note.',
          UPDATE: 'An existing similar note should be edited instead of creating another.',
          SUPERSEDE: 'The draft replaces an existing note; keep a supersedes edge.',
          NOOP: 'The vault already has this; do not write.',
        },
      },
    },
  };
}

export function vaultWriteAdvice(answers: Record<string, unknown>, similar: readonly SimilarNote[]): string {
  if (confidenceOf(answers.decision) < 0.7) return '';
  const d = chosen(answers.decision);
  const top = similar[0];
  if (d === 'ADD') return 'Vault write: ADD — create_note with preflight_decision ADD. Nothing similar enough to update.';
  if (d === 'NOOP') return 'Vault write: NOOP — skip create_note; the vault already has this subject.';
  if (d === 'UPDATE') {
    const id = top?.noteId ? ` note ${top.noteId} (${top.title})` : ' the top similar note';
    return `Vault write: UPDATE — update_note${id} with preflight_decision UPDATE, not a new note.`;
  }
  if (d === 'SUPERSEDE') {
    const id = top?.noteId ? ` ${top.noteId}` : '';
    return `Vault write: SUPERSEDE — create the new note then supersede${id}; do not leave two active notes on the same subject.`;
  }
  return '';
}
