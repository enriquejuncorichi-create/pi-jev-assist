import { createHash } from "node:crypto";
import { redact } from "./privacy.js";

export interface Observation {
  id: string;
  tool: string;
  call: string;
  output: string;
  status: "error" | "ok" | "unknown";
  mutation: boolean;
  sequence: number;
}
export interface Check {
  id: string;
  kind: "test" | "lint" | "typecheck" | "build" | "check";
  status: "passed" | "failed" | "unknown";
  afterMutation: number;
  call: string;
}
export interface EvidenceSnapshot {
  observations: Observation[];
  mutations: number;
  unknownMutations: number;
  dropped: number;
  checks: Check[];
}

type Entry = {
  observation: Observation;
  generation: number;
  excluded: boolean;
  finished: boolean;
  kind?: Check["kind"];
  check?: Check;
};
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const SENSITIVE = /(?:^|[\s/\\"'])\.?env(?:[.\s/\\"']|$)|auth|credential|private[-_ ]?key|(?:^|[/\\])\.ssh(?:[/\\]|$)|id_(?:rsa|ed25519|ecdsa)|\.(?:pem|key|p12|pfx)(?:$|[\s"'])/i;
const excerpt = (text: string, limit: number): string => redact(text).slice(0, limit);
const entryKey = (id: string): string => createHash("sha256").update(id).digest("hex");

function checkKind(command: string): Check["kind"] | undefined {
  // Deliberately not a shell parser: accept only direct, plain argv commands.
  if (!/^[a-zA-Z0-9_./:@= +,-]+$/.test(command)) return undefined;
  const match = /^(?:bun run (test|lint|typecheck|build|check)|bun (test)|node (--test))(?: |$)/.exec(command);
  if (!match) return undefined;
  return (match[1] ?? "test") as Check["kind"];
}
function exitCode(details: unknown): number | undefined {
  if (!details || typeof details !== "object" || !("exitCode" in details)) return undefined;
  const value = details.exitCode;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/** Bounded observations, not proof. Check freshness uses mutations + unknownMutations. */
export class EvidenceLedger {
  private entries = new Map<string, Entry>();
  private mutations = 0;
  private unknownMutations = 0;
  private dropped = 0;
  private sequence = 0;
  private retired = new Set<string>();

  constructor() {}

  private reserve(): void {
    if (this.entries.size < 120) return;
    const oldest = this.entries.keys().next().value!;
    this.entries.delete(oldest);
    this.retired.add(oldest);
    if (this.retired.size > 256) this.retired.delete(this.retired.values().next().value!);
    this.dropped++;
  }

  recordCall(id: string, tool: string, input: Record<string, unknown>): void {
    const key = entryKey(id);
    if (this.entries.has(key) || this.retired.has(key)) return;
    const mutation = tool === "write" || tool === "edit";
    if (mutation) this.mutations++;
    else if (!READ_TOOLS.has(tool)) this.unknownMutations++;
    const sequence = ++this.sequence;
    if (id.length > 300) { this.dropped++; return; }
    this.reserve();
    const path = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : "";
    const command = typeof input.command === "string" ? input.command : "";
    const glob = typeof input.glob === 'string' ? input.glob : '';
    const excluded = (path !== "" && SENSITIVE.test(path)) || (glob !== '' && SENSITIVE.test(glob)) ||
      (tool === "bash" && (SENSITIVE.test(command) || /\b(?:env|printenv)\b/.test(command)));
    // Never retain edit/write bodies, arbitrary input objects, or raw output/details.
    const call = excluded ? "[sensitive content omitted]" : excerpt(tool === "bash" ? command : `${tool}${path ? ` ${path}` : ""}`, 300);
    this.entries.set(key, {
      observation: { id: excerpt(id, 300), tool: excerpt(tool, 100), call, output: "", status: "unknown", mutation: mutation || !READ_TOOLS.has(tool), sequence },
      generation: this.mutations + this.unknownMutations,
      excluded,
      finished: false,
      kind: tool === "bash" && !excluded ? checkKind(command) : undefined,
    });
  }

  recordResult(id: string, tool: string, content: readonly { type: string; text?: string }[], isError: boolean, details: unknown): void {
    const key = entryKey(id);
    const entry = this.entries.get(key);
    if (entry?.finished || this.retired.has(key)) return;
    if (!entry) {
      // A missing call has no trustworthy generation or classification; discard its content.
      this.unknownMutations++;
      if (id.length > 300) { this.dropped++; return; }
      this.reserve();
      this.entries.set(key, {
        observation: { id: excerpt(id, 300), tool: excerpt(tool, 100), call: "[orphan result]", output: "", status: "unknown", mutation: true, sequence: ++this.sequence },
        generation: this.mutations + this.unknownMutations, excluded: true, finished: true,
      });
      return;
    }
    entry.finished = true;
    const code = exitCode(details);
    const matchesTool = entry.observation.tool === tool;
    entry.observation.status = !matchesTool ? "unknown" : isError || (code !== undefined && code !== 0) ? "error" : code === 0 ? "ok" : "unknown";
    if (!entry.excluded && matchesTool) {
      const text = content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
      // Search results can expose excluded files even when the searched directory is ordinary.
      const sensitiveSource = tool === 'grep' && text.split('\n').some(line => {
        if (line === '' || line === 'No matches found') return false;
        const source = /^(.*?)(?::|-)\d+(?::|-) /.exec(line)?.[1];
        // Unknown format, including truncated rows/notices, is not safe evidence.
        return source === undefined || SENSITIVE.test(source);
      });
      entry.observation.output = sensitiveSource ? '[sensitive search results omitted]' : excerpt(text, 1200);
    }
    if (entry.kind) entry.check = {
      id: entry.observation.id,
      kind: entry.kind,
      status: entry.observation.status === "error" ? "failed" : entry.observation.status === "ok" ? "passed" : "unknown",
      afterMutation: entry.generation,
      call: entry.observation.call,
    };
  }

  snapshot(): EvidenceSnapshot {
    return {
      observations: [...this.entries.values()].map(entry => ({ ...entry.observation })),
      mutations: this.mutations, unknownMutations: this.unknownMutations, dropped: this.dropped,
      checks: [...this.entries.values()].flatMap(entry => entry.check ? [{ ...entry.check }] : []),
    };
  }

  reset(): void {
    this.entries.clear(); this.retired.clear(); this.mutations = 0; this.unknownMutations = 0; this.dropped = 0; this.sequence = 0;
  }
}
