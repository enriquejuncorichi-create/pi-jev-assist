import { createHash } from "node:crypto";
import { redact } from "./privacy.js";

export interface Observation {
  id: string;
  tool: string;
  call: string;
  output: string;
  // Pi's bash tool reports no exit code, so `ok` means only "the tool did not
  // report an error" — never "the command's checks passed".
  status: "error" | "ok" | "unknown";
  mutation: boolean;
  sequence: number;
}
export interface EvidenceSnapshot {
  observations: Observation[];
  mutations: number;
  unknownMutations: number;
  dropped: number;
}

type Entry = {
  observation: Observation;
  excluded: boolean;
  finished: boolean;
};
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const SENSITIVE = /(?:^|[\s/\\"'])\.?env(?:[.\s/\\"']|$)|auth|credential|private[-_ ]?key|(?:^|[/\\])\.ssh(?:[/\\]|$)|id_(?:rsa|ed25519|ecdsa)|\.(?:pem|key|p12|pfx)(?:$|[\s"'])/i;
const excerpt = (text: string, limit: number): string => redact(text).slice(0, limit);
/** Head+tail so `HOOKS_EXIT:0` after a verbose node:test listing is not clipped away. Observed: the review then claimed "no exit status" and woke the agent in a loop. */
function excerptEnds(text: string, limit: number): string {
  const safe = redact(text);
  if (safe.length <= limit) return safe;
  const head = Math.max(200, Math.floor(limit * 0.5));
  const tail = Math.max(200, limit - head - 40);
  const omitted = safe.length - head - tail;
  return `${safe.slice(0, head)}\n… [${omitted} chars omitted] …\n${safe.slice(-tail)}`;
}
const entryKey = (id: string): string => createHash("sha256").update(id).digest("hex");

/**
 * Bounded observations, not proof. There is deliberately no check/pass layer:
 * Pi's bash tool emits no exit status (dist/core/tools/bash.js only sets
 * `details` for truncation), and real agent commands are compound
 * (`cd x && node --test | tail`), so any "this check passed" conclusion drawn
 * here would be inferred from output prose. Classification is left to the judge,
 * which sees the command and its output as untrusted observations.
 */
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
      excluded,
      finished: false,
    });
  }

  recordResult(id: string, tool: string, content: readonly { type: string; text?: string }[], isError: boolean, details: unknown): void {
    const key = entryKey(id);
    const entry = this.entries.get(key);
    if (entry?.finished || this.retired.has(key)) return;
    if (!entry) {
      // A missing call has no trustworthy classification; discard its content.
      this.unknownMutations++;
      if (id.length > 300) { this.dropped++; return; }
      this.reserve();
      this.entries.set(key, {
        observation: { id: excerpt(id, 300), tool: excerpt(tool, 100), call: "[orphan result]", output: "", status: "unknown", mutation: true, sequence: ++this.sequence },
        excluded: true, finished: true,
      });
      return;
    }
    entry.finished = true;
    const matchesTool = entry.observation.tool === tool;
    // `isError` is the only status signal Pi actually provides.
    entry.observation.status = !matchesTool ? "unknown" : isError ? "error" : "ok";
    if (!entry.excluded && matchesTool) {
      const text = content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
      // Search results can expose excluded files even when the searched directory is ordinary.
      const sensitiveSource = tool === 'grep' && text.split('\n').some(line => {
        if (line === '' || line === 'No matches found') return false;
        const source = /^(.*?)(?::|-)\d+(?::|-) /.exec(line)?.[1];
        // Unknown format, including truncated rows/notices, is not safe evidence.
        return source === undefined || SENSITIVE.test(source);
      });
      entry.observation.output = sensitiveSource ? '[sensitive search results omitted]' : excerptEnds(text, 1200);
    }
  }

  snapshot(): EvidenceSnapshot {
    return {
      observations: [...this.entries.values()].map(entry => ({ ...entry.observation })),
      mutations: this.mutations, unknownMutations: this.unknownMutations, dropped: this.dropped,
    };
  }

  reset(): void {
    this.entries.clear(); this.retired.clear(); this.mutations = 0; this.unknownMutations = 0; this.dropped = 0; this.sequence = 0;
  }
}
