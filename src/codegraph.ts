/**
 * The Vortex code graph, as a blast-radius source.
 *
 * Measured against the grep enumerator on one symbol (`uploadToLibrary`):
 * the graph walks real `Calls` edges transitively — depth 1 `attachBlob`, five
 * at depth 2, two at depth 3 including `recordInbound`, which contains the
 * symbol's name NOWHERE and no text search can reach at any effort. It also
 * ignored a same-named twin in another package that grep reported as related.
 *
 * And it FAILS LOUD: an unindexed workspace returns `workspace_not_indexed`
 * naming what is indexed, rather than an empty list. That is the property that
 * makes an empty result meaningful — but only when the call SUCCEEDED, which is
 * why every failure here falls back to the mechanical enumerator and says so
 * instead of reporting nothing.
 *
 * Transport is a `vortexd --mcp` child over stdio: 523 ms to handshake, 610 ms
 * to answer, so one is kept warm per session rather than spawned per call.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface GraphCaller { symbol: string; path: string; depth: number }
export interface BlastRadius {
  callers: GraphCaller[];
  riskLevel?: string;
  indexedCommit?: string;
  liveHead?: string;
  hiddenCoupling?: string[];
}

const INIT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 30_000;

/** MCP tool results are JSON, JSON-in-fences, or structuredContent. Never throw 'unparseable' on a fence. */
export function parseIntelligence(message: {
  result?: { content?: Array<{ text?: string }>; structuredContent?: unknown; isError?: boolean };
  error?: { message?: string };
}): Record<string, unknown> {
  if (message.error) throw new Error(message.error.message ?? 'intelligence error');
  const structured = message.result?.structuredContent;
  if (structured && typeof structured === 'object' && !Array.isArray(structured)) return structured as Record<string, unknown>;
  const text = (message.result?.content ?? []).map(c => c.text ?? '').join('');
  if (message.result?.isError || /^\s*Error:/.test(text)) throw new Error(text.slice(0, 200) || 'intelligence error');
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const tryParse = (raw: string): Record<string, unknown> | undefined => {
    try {
      const value = JSON.parse(raw) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
      if (Array.isArray(value)) return { hits: value };
    } catch { /* next */ }
    return undefined;
  };
  const direct = tryParse(stripped);
  if (direct) return direct;
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const nested = tryParse(stripped.slice(start, end + 1));
    if (nested) return nested;
  }
  const bracket = stripped.indexOf('[');
  const bracketEnd = stripped.lastIndexOf(']');
  if (bracket >= 0 && bracketEnd > bracket) {
    const nested = tryParse(stripped.slice(bracket, bracketEnd + 1));
    if (nested) return nested;
  }
  throw new Error('unparseable intelligence response');
}

export class CodeGraph {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, { resolve: (m: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 0;
  private buffer = '';
  private ready?: Promise<void>;
  /** Once the transport has failed, stop paying for it every run. */
  private broken = false;

  constructor(private readonly command = 'vortexd') {}

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try { child = spawn(this.command, ['--mcp'], { stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch (error) { this.broken = true; reject(error as Error); return; }
      this.child = child;
      // A live child keeps Node's event loop open, so a host that has finished
      // its work would hang waiting for a daemon it no longer needs. Unref means
      // this process can exit whenever it likes; the child is killed on
      // session_shutdown anyway. Found by the test suite hanging forever.
      child.unref();
      child.on('error', error => { this.broken = true; this.failAll(error as Error); reject(error as Error); });
      child.on('exit', () => { this.broken = true; this.failAll(new Error('vortexd exited')); });
      child.stderr.on('data', () => {}); // diagnostics only; never parsed
      child.stdout.on('data', chunk => this.consume(String(chunk)));
      this.request('initialize', {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'pi-jev-assist', version: '1' },
      }, INIT_TIMEOUT_MS).then(() => {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
        resolve();
      }, reject);
    });
    return this.ready;
  }

  private failAll(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    // Cap the buffer: a runaway child must not grow this without bound.
    if (this.buffer.length > 8_000_000) this.buffer = this.buffer.slice(-1_000_000);
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as { id?: number };
        if (typeof message.id === 'number') {
          this.pending.get(message.id)?.resolve(message);
          this.pending.delete(message.id);
        }
      } catch { /* not our frame */ }
    }
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      try { this.child!.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error as Error); }
    });
  }

  private async intelligence(action: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.broken) throw new Error('code graph unavailable');
    await this.start();
    const message = await this.request('tools/call', {
      name: 'vortex_intelligence', arguments: { action, ...args },
    }, CALL_TIMEOUT_MS) as { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } };
    if (message.error) throw new Error(message.error.message ?? 'intelligence error');
    try {
      return parseIntelligence(message);
    } catch (error) {
      this.broken = true;
      throw error;
    }
  }

  /**
   * Make sure this workspace HAS an index, and say what state it is in.
   *
   * Indexing a large repo takes minutes, so `start_indexing` is kicked off and
   * NOT waited on: the caller falls back to text search until the walk lands.
   * Blocking a write for minutes to build an index would be a worse failure
   * than the missing caller it is trying to prevent.
   */
  async ensureIndexed(path: string): Promise<'indexed' | 'indexing' | 'unavailable'> {
    try {
      await this.intelligence('index_stats', { path });
      return 'indexed';
    } catch (error) {
      const message = String((error as Error).message ?? '');
      if (!/workspace_not_indexed/.test(message)) return 'unavailable';
      try {
        await this.intelligence('start_indexing', { path });
        return 'indexing';
      } catch { return 'unavailable'; }
    }
  }

  /** Keep the graph current while the agent edits. Best effort: never throws. */
  async watch(path: string): Promise<boolean> {
    try {
      // Workspace-RELATIVE, which the daemon enforces: an absolute path is refused.
      await this.intelligence('watch_directory', { path: '.', worktree: path });
      return true;
    } catch { return false; }
  }

  async blastRadius(symbolId: string, path: string): Promise<BlastRadius> {
    const data = await this.intelligence('blast_radius', { symbolId, path });
    const rows = (key: string): GraphCaller[] =>
      (Array.isArray(data[key]) ? data[key] as Array<Record<string, unknown>> : []).map(r => ({
        symbol: String(r.label ?? ''), path: String(r.file_path ?? ''), depth: Number(r.depth ?? 0),
      }));
    const meta = (data._meta ?? {}) as Record<string, unknown>;
    const coupling = Array.isArray(data.hidden_coupling) ? data.hidden_coupling.map(String) : undefined;
    return {
      callers: [...rows('direct'), ...rows('indirect'), ...rows('transitive')].filter(c => c.symbol),
      riskLevel: typeof data.riskLevel === 'string' ? data.riskLevel : undefined,
      indexedCommit: typeof meta.indexed_commit === 'string' ? meta.indexed_commit : undefined,
      liveHead: typeof meta.live_head === 'string' ? meta.live_head : undefined,
      ...(coupling && coupling.length ? { hiddenCoupling: coupling } : {}),
    };
  }

  async findSymbol(name: string, path: string): Promise<string | undefined> {
    const data = await this.intelligence('search_symbols', { query: name, path, limit: 10 });
    const hits = Array.isArray(data) ? data as Array<Record<string, unknown>>
      : Array.isArray((data as {hits?: unknown}).hits) ? (data as {hits: Array<Record<string, unknown>>}).hits
      : [];
    // Exact label match only: a substring hit is a different symbol, and asking
    // the graph about the wrong one produces a confident answer to no question.
    const exact = hits.find(h => h.label === name && typeof h.id === 'string');
    return exact ? String(exact.id) : undefined;
  }

  dispose(): void {
    this.failAll(new Error('disposed'));
    try { this.child?.kill(); } catch { /* already gone */ }
    this.child = undefined;
    this.ready = undefined;
  }
}
