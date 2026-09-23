import { resolve } from 'node:path';
import { parseWorkerPolicy, taskContractFromAnswers, type WorkerPolicy } from './worker-task-contract.js';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { WorkerClient, workerFailure, parseWorkerReceipt, type WorkerReceipt } from './worker-client.js';
import { discoverWorkerRoutes, routeKey, rubricCandidates, selectRubricRoute, selectWorker, workerRouteChoiceRequest, workerJudgementRequest, WORKER_ROLES, type Qualification, type RoutingRegistry, type WorkerRole, type WorkerAffinity, type RouteRubric, type Route } from './worker-routing.js';
import type { AssistService } from './service.js';
import { clean, digest } from './decisions.js';
import { importQualification, loadQualifications, saveQualifications, qualificationKey, qualificationInventory } from './worker-qualifications.js';

export const WORKER_BYTE_BUDGET = 64_000;
interface WorkerRecord { receipt: WorkerReceipt; role: WorkerRole; workspace: string; taskKey: string; promptBytes?: number; resultBytes?: number; resultHash?: string; executionPolicy?: { thinkingLevel: string; maxTurns: number } }
export function checkWorkerBudget(promptBytes: number | undefined, resultBytes: number | undefined, nextPrompt: string): void {
  if (!Number.isSafeInteger(promptBytes) || !Number.isSafeInteger(resultBytes) || Number(promptBytes) < 0 || Number(resultBytes) < 0
    || Number(promptBytes) + Number(resultBytes) + Buffer.byteLength(nextPrompt, 'utf8') >= WORKER_BYTE_BUDGET) {
    throw new Error('Worker context byte budget reached or unknown; explicitly dispatch a fresh taskKey with curated constraints. No replay, truncation or route switch performed.');
  }
}
export interface WorkerConfiguration {
  enabled(): boolean;
  setEnabled(enabled: boolean): void;
  exclusions(): readonly string[];
  setExclusions?(routes: string[]): void;
  qualifications(): readonly Qualification[];
  qualificationStorePath?: string;
  policy?(): WorkerPolicy;
  routingMode?(): 'rubric' | 'qualified';
  routeRubrics?(): readonly RouteRubric[];
  setPolicy?(policy: WorkerPolicy): void;
}
interface WorkerArguments {
  action: 'start' | 'resume' | 'status' | 'stop';
  task?: string; role?: WorkerRole; cwd?: string; taskKey?: string; handle?: string;
  minimumContext?: number;
}

export function installWorkerRouting(pi: ExtensionAPI, service: AssistService, configuration: WorkerConfiguration): {
  command(args: string[], ctx: ExtensionCommandContext): Promise<void>;
  disable(): Promise<void>;
} {
  let client = new WorkerClient(pi.events);
  const records = new Map<string, WorkerRecord>();
  let owner = '';
  let running = false;
  let generation = 0;
  let dispatching = false;
  let stopping = 0;
  const recent: string[] = [];
  const note = (text: string) => { recent.push(clean(text, 600)); if (recent.length > 20) recent.shift(); };
  const registry = (ctx: ExtensionContext) => ctx.modelRegistry as unknown as RoutingRegistry;
  const routes = (ctx: ExtensionContext) => discoverWorkerRoutes(registry(ctx), configuration.exclusions());
  const remember = (record: WorkerRecord) => {
    const resultHash = record.receipt.result === undefined ? record.resultHash : digest(record.receipt.result);
    if (resultHash !== record.resultHash) record.resultBytes = (record.resultBytes ?? 0) + Buffer.byteLength(record.receipt.result ?? '', 'utf8');
    record.resultHash = resultHash;
    records.set(record.receipt.handle, record);
    // Persist identity, not unbounded worker output or arbitrary usage payloads.
    const { handle, agentId, route, status, sessionId } = record.receipt;
    pi.appendEntry('jev-worker-record', { owner, role: record.role, workspace: record.workspace, taskKey: record.taskKey, executionPolicy: record.executionPolicy, promptBytes: record.promptBytes, resultBytes: record.resultBytes, resultHash: record.resultHash, receipt: { handle, agentId, route, status, sessionId } });
  };
  const activeOwner = (ctx: ExtensionContext) => running && owner === ctx.sessionManager.getSessionId();
  const stopOwned = async () => {
    generation++;
    stopping++;
    const stoppingClient = client;
    const handles = [...records.keys()];
    records.clear();
    stoppingClient.dispose();
    const outcomes = await Promise.allSettled(handles.map(handle => stoppingClient.stop(handle)));
    outcomes.forEach((outcome, i) => { if (outcome.status === 'rejected') note(`Stop unconfirmed for ${handles[i]}: ${String(outcome.reason)}`); });
    stopping--;
  };
  pi.on('session_start', (_event, ctx) => {
    generation++;
    client.dispose();
    client = new WorkerClient(pi.events);
    owner = ctx.sessionManager.getSessionId(); running = true; records.clear(); recent.length = 0;
    // Restore only the active branch. The runner remains authoritative about
    // handle ownership and whether the actual session can safely be reopened.
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== 'custom' || entry.customType !== 'jev-worker-record') continue;
      const data = entry.data as Partial<WorkerRecord> & { owner?: string };
      if (data?.owner !== owner || !data.receipt?.handle || !WORKER_ROLES.includes(data.role as WorkerRole)
        || typeof data.workspace !== 'string' || typeof data.taskKey !== 'string') continue;
      try {
        const receipt = parseWorkerReceipt(data.receipt);
        if (records.size < 32 || records.has(receipt.handle)) records.set(receipt.handle, { ...data, receipt } as WorkerRecord);
      } catch { /* Malformed branch entries never grant ownership. */ }
    }
  });
  pi.on('session_tree', async () => { running = false; await stopOwned(); });
  pi.on('session_shutdown', async () => {
    running = false;
    const shutdownOwner = owner;
    await stopOwned();
    if (!running && owner === shutdownOwner) owner = '';
  });

  pi.registerTool({
    name: 'jev_worker', label: 'Jev worker',
    description: 'Delegate a bounded task through subscription-only, quality-gated model routing. Start or resume an owned worker, inspect status, or request stop. Results require main-model review. Write workers require a separate existing git worktree. No paid fallback.',
    promptSnippet: 'Route bounded worker tasks without changing the main orchestrator model',
    promptGuidelines: [
      'Use jev_worker for routed implementation, scouting, research and context curation. The main model defines the task and independently reviews returned evidence.',
      'Use a stable taskKey for related follow-ups. Do not send the entire parent transcript or credentials. Curators propose source-linked packets; they never delete parent context.',
      'A jev_worker start/resume receipt means work was dispatched, not completed. Await the existing agent completion notification rather than polling.',
      'If jev_worker refuses a route or resume, do not bypass its subscription or quality gates using another tool. Reconcile the reported problem or ask the user.',
    ],
    parameters: {
      type: 'object', properties: {
        action: { type: 'string', enum: ['start', 'resume', 'status', 'stop'] },
        task: { type: 'string', maxLength: 12000 },
        role: { type: 'string', enum: [...WORKER_ROLES] },
        cwd: { type: 'string', description: 'Worker directory; implementation requires an external existing worktree.' },
        taskKey: { type: 'string', maxLength: 120, description: 'Stable, task-specific affinity key, not a generic role.' },
        handle: { type: 'string', description: 'Opaque handle returned by this tool.' },
        minimumContext: { type: 'integer', minimum: 1, maximum: 10000000, description: 'Required model context capacity in tokens, including anticipated system/tool context; not lifetime token usage. Minimum enforced capacity is 32000.' },
      }, required: ['action'], additionalProperties: false,
    },
    async execute(_id: string, args: WorkerArguments, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      if (!activeOwner(ctx)) throw new Error('Worker routing unavailable after session navigation; restart or reload before dispatch');
      if (stopping) throw new Error('Worker routing is stopping; no dispatch permitted');
      const isDispatch = args.action === 'start' || args.action === 'resume';
      if (isDispatch && dispatching) throw new Error('Another worker dispatch is pending; no concurrent resume permitted');
      if (isDispatch) dispatching = true;
      try {
      if (!['start', 'resume', 'status', 'stop'].includes(args.action)) throw new Error('Unknown worker action');
      const requestClient = client;
      const requestGeneration = generation;
      if (!configuration.enabled() && args.action !== 'stop' && args.action !== 'status') throw new Error('Worker routing is off; enable /jev-assist routing on');
      const prior = args.handle ? records.get(args.handle) : undefined;
      if (args.action !== 'start' && !prior) throw new Error('Unknown or foreign worker handle');
      if (args.action === 'stop') {
        await requestClient.stop(prior!.receipt.handle, signal);
        return { content: [{ type: 'text' as const, text: 'Stop requested. Do not assume termination until the runner reports a terminal state.' }] };
      }
      if (args.action === 'status') {
        const receipt = await requestClient.status(prior!.receipt.handle, signal);
        if (!activeOwner(ctx) || generation !== requestGeneration) throw new Error('Worker status belongs to an invalidated session');
        remember({ ...prior!, receipt });
        const text = clean(JSON.stringify({ ...receipt, failure: workerFailure(receipt), cache: 'unknown', quota: 'unknown', context: 'Unknown occupancy; usage input is lifetime consumption, not context size', observedBytes: { prompt: prior!.promptBytes, result: records.get(receipt.handle)?.resultBytes, limit: WORKER_BYTE_BUDGET }, review: 'Main-model review required; worker completion is not verification' }), 24_000);
        return { content: [{ type: 'text' as const, text: `${text}\nFull evidence: use the existing agent result view for ${receipt.agentId}.` }] };
      }
      if (!args.task?.trim()) throw new Error('A non-empty worker task is required');
      if (prior && args.role && args.role !== prior.role) throw new Error('Worker role mismatch; explicit fresh dispatch required');
      const role = prior?.role ?? args.role;
      if (!role || !WORKER_ROLES.includes(role)) throw new Error('A valid worker role is required');
      const workspace = prior?.workspace ?? resolve(ctx.cwd, args.cwd ?? '.');
      const taskKey = prior?.taskKey ?? args.taskKey?.trim();
      if (!taskKey || taskKey.length > 120) throw new Error('A stable taskKey of 1–120 characters is required');
      if (!ctx.model) throw new Error('The main-model baseline is unavailable');
      const requestOwner = owner;
      const result = await service.evaluate(workerJudgementRequest(args.task, role), signal);
      if (!result.ok) throw new Error(`Jev routing unavailable: ${result.reason}; no fallback`);
      if (!activeOwner(ctx) || owner !== requestOwner || generation !== requestGeneration || !configuration.enabled() || signal?.aborted) throw new Error('Worker routing cancelled by session or routing-policy change');
      const related = prior ?? [...records.values()].find(record => record.role === role && record.workspace === workspace && record.taskKey === taskKey);
      const affinity: WorkerAffinity | undefined = related && related.executionPolicy?.thinkingLevel === pi.getThinkingLevel() && related.executionPolicy.maxTurns === 12
        ? { handle: related.receipt.handle, route: related.receipt.route, role, workspace } : undefined;
      const baseline = { provider: ctx.model.provider, model: ctx.model.id };
      const thinkingLevel = pi.getThinkingLevel();
      const taskContract = taskContractFromAnswers(result.answers, role);
      const policy = parseWorkerPolicy(configuration.policy ? configuration.policy() : { mode: 'automatic' });
      if (args.minimumContext !== undefined && (!Number.isSafeInteger(args.minimumContext) || args.minimumContext < 1 || args.minimumContext > 10000000)) throw new Error('Invalid minimum context requirement');
      // The current accepted-result suite measures low thinking with 12 turns.
      // Evidence cannot transfer silently to a different execution policy.
      const measuredPolicy = thinkingLevel === 'low';
      const minimumContext = Math.max(32_000, args.minimumContext ?? 32_000);
      const mode = configuration.routingMode?.() ?? 'qualified';
      const rubrics = configuration.routeRubrics?.() ?? [];
      const policyStamp = JSON.stringify({ policy, exclusions: configuration.exclusions(), mode, rubrics });
      const checkDispatch = (route: Route) => {
        if (!activeOwner(ctx) || owner !== requestOwner || generation !== requestGeneration || !configuration.enabled() || signal?.aborted
          || !ctx.model || routeKey({ provider: ctx.model.provider, model: ctx.model.id }) !== routeKey(baseline)
          || JSON.stringify({ policy: configuration.policy ? parseWorkerPolicy(configuration.policy()) : { mode: 'automatic' }, exclusions: configuration.exclusions(), mode: configuration.routingMode?.() ?? 'qualified', rubrics: configuration.routeRubrics?.() ?? [] }) !== policyStamp
          || !rubricCandidates({ role, answers: result.answers, baseline, available: routes(ctx), minimumContext, task: taskContract, policy, rubrics }).candidates.some(item => routeKey(item.route) === routeKey(route)))
          throw new Error('Worker routing cancelled or route eligibility/policy changed before dispatch');
      };
      let decision;
      if (mode === 'rubric') {
        const { candidates } = rubricCandidates({ role, answers: result.answers, baseline, available: routes(ctx), minimumContext, task: taskContract, policy, rubrics });
        if (!candidates.length) throw new Error('No eligible worker route; no fallback');
        const { request, routes: enumerated } = workerRouteChoiceRequest(args.task, role, baseline, candidates, rubrics);
        const choice = await service.evaluate(request, signal);
        if (!activeOwner(ctx) || owner !== requestOwner || generation !== requestGeneration || !configuration.enabled() || signal?.aborted) throw new Error('Worker routing cancelled during route choice');
        const selected = selectRubricRoute(choice.ok ? choice.answers.routeChoice : undefined, enumerated, baseline);
        checkDispatch(selected);
        const fresh = result.answers.freshContext as { noul?: number };
        const reusable = affinity && fresh.noul !== undefined && fresh.noul < 0.5 && routeKey(affinity.route) === routeKey(selected) && related?.executionPolicy?.thinkingLevel === thinkingLevel && related.executionPolicy.maxTurns === 12;
        decision = { route: selected, role, reason: choice.ok ? 'Jev rubric choice (invalid or abstained choices retain eligible baseline)' : 'Jev unavailable; eligible baseline retained', qualification: 'Optional informational evidence only', ...(reusable ? { resumeHandle: affinity!.handle } : {}) };
      } else if (mode === 'qualified') {
        decision = selectWorker({ role, answers: result.answers, baseline, available: routes(ctx), qualifications: measuredPolicy ? configuration.qualifications() : [], affinity, workspace, minimumContext, now: Date.now(), task: taskContract, policy });
      } else throw new Error('Invalid worker routing mode');
      if (args.action === 'resume' && decision.resumeHandle !== prior?.receipt.handle) throw new Error('Existing worker is no longer suitable: route or execution policy changed; explicit new dispatch required');
      if (records.size >= 32 && !decision.resumeHandle) throw new Error('32-handle worker limit reached; a fresh Pi session is required for more workers');
      let continuation = decision.resumeHandle ? records.get(decision.resumeHandle) : undefined;
      if (decision.resumeHandle && continuation) {
        if (continuation.executionPolicy?.thinkingLevel !== thinkingLevel || continuation.executionPolicy.maxTurns !== 12) {
          throw new Error('Worker execution policy differs or is unknown; explicitly dispatch a fresh taskKey. Existing qualification cannot transfer to another thinking level or turn limit.');
        }
        const observed = await requestClient.status(decision.resumeHandle, signal);
        if (!activeOwner(ctx) || generation !== requestGeneration || !configuration.enabled() || signal?.aborted) throw new Error('Worker routing cancelled before resume');
        if (routeKey(observed.route) !== routeKey(decision.route)) throw new Error('Worker route mismatch; no resume');
        remember({ ...continuation, receipt: observed });
        continuation = records.get(decision.resumeHandle)!;
        const failure = workerFailure(observed);
        if (failure) throw new Error(`${failure}: ${observed.error ?? observed.status}; explicit fresh dispatch required, no retry or fallback`);
        if (!['completed', 'done'].includes(observed.status)) throw new Error('Worker is not completed; await its terminal notification');
        checkWorkerBudget(continuation.promptBytes, continuation.resultBytes, args.task);
      } else checkWorkerBudget(0, 0, args.task);
      checkDispatch(decision.route);
      const receipt = decision.resumeHandle
        ? await requestClient.resume(decision.resumeHandle, args.task, decision.route, signal)
        : await requestClient.spawn({ type: 'general-purpose', prompt: args.task, route: decision.route, cwd: workspace, access: role === 'implement' ? 'write' : 'read-only', thinkingLevel, maxTurns: 12 }, signal);
      try { checkDispatch(decision.route); }
      catch { await requestClient.stop(receipt.handle).catch(() => undefined); throw new Error('Parent session/model or worker eligibility/policy changed during dispatch; worker stop requested'); }
      remember({ receipt, role, workspace, taskKey, executionPolicy: { thinkingLevel, maxTurns: 12 }, promptBytes: (continuation?.promptBytes ?? 0) + Buffer.byteLength(args.task, 'utf8'), resultBytes: continuation?.resultBytes ?? 0, resultHash: undefined });
      note(`${role}/${taskContract.family} → ${routeKey(receipt.route)} · policy ${policy.mode} · ${workerFailure(receipt) ?? receipt.status} · ${decision.reason}`);
      pi.appendEntry('jev-worker-route', { role, taskFamily: taskContract.family, requiredCapabilities: taskContract.requiredCapabilities, policy, mode, route: decision.route, reason: decision.reason, qualification: decision.qualification, resumed: Boolean(decision.resumeHandle), cache: 'unknown', handle: receipt.handle });
      return { content: [{ type: 'text' as const, text: `Jev · ${role} → ${routeKey(receipt.route)}\nTask family: ${taskContract.family} · policy: ${policy.mode}\n${decision.reason}\nHandle: ${receipt.handle}\nAgent: ${receipt.agentId}\nState: ${workerFailure(receipt) ?? receipt.status} · cache residency and quota unknown\nMain model retained. Await completion, then independently review evidence.` }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Worker request failed';
        note(`${workerFailure({ status: 'failed', error: message })}: ${message}`);
        throw error;
      } finally { if (isDispatch) dispatching = false; }
    },
  } as never);

  return {
    async disable() {
      const disabledClient = client;
      await stopOwned();
      if (client === disabledClient) client = new WorkerClient(pi.events);
    },
    async command(args, ctx) {
      const action = args[0] ?? 'status';
      if (!ctx.hasUI) throw new Error('Routing controls require an interactive user command context');
      const commandGeneration = generation;
      const commandOwner = owner;
      const unchanged = () => { if (generation !== commandGeneration || owner !== commandOwner) throw new Error('Session or policy changed during routing control; retry explicitly'); };
      if (action === 'policy') {
        if (args.length > 1) {
          if (!configuration.setPolicy) throw new Error('Persistent routing policy is unavailable');
          const mode = args[1];
          const next = parseWorkerPolicy(mode === 'allowlist' ? { mode, routes: args.slice(2) } : args.length === 2 ? { mode } : {});
          configuration.setPolicy(next);
          generation++;
        }
        ctx.ui.notify(`Worker policy: ${JSON.stringify(configuration.policy?.() ?? { mode: 'automatic' })}\nPreferences never override subscription, capability or quality gates. Strict allowlists never silently fall back.`, 'info');
        return;
      }
      if (action === 'exclude' || action === 'include') {
        const key = args.slice(1).join(' ');
        if (!routes(ctx).some(item => routeKey(item.route) === key) && !configuration.exclusions().includes(key)) throw new Error('Use an exact provider/model route from routing routes');
        if (!configuration.setExclusions) throw new Error('Persistent exclusions unavailable');
        const next = action === 'exclude' ? [...new Set([...configuration.exclusions(), key])] : configuration.exclusions().filter(item => item !== key);
        if (next.length > 128) throw new Error('Exclusion limit reached; no policy changed');
        configuration.setExclusions(next);
        generation++;
      } else if (action === 'qualification') {
        const sub = args[1] ?? 'list';
        if (sub === 'import') {
          const path = args.slice(2).join(' ').replace(/^"(.*)"$/, '$1');
          const profile = importQualification(path);
          const accepted = await ctx.ui.confirm('Trust worker qualification?', `USER approval required: ${qualificationKey(profile)}\nBenchmark: ${profile.benchmarkVersion}\nSuite: ${profile.suiteHash}\nEvidence: ${profile.evidenceRef}\nSHA-256: ${profile.evidenceHash}\nExpires: ${new Date(profile.expiresAt).toISOString()}\n${profile.acceptedSamples} accepted samples; ${profile.medianAcceptedMs}ms versus baseline ${profile.baselineMedianAcceptedMs}ms, including review and repair.\nConfirm only after reviewing the evidence. JSON assertions are not independent verification.`);
          unchanged();
          if (!accepted) { ctx.ui.notify('Qualification not trusted.', 'info'); return; }
          const checked = importQualification(path);
          if (digest(checked) !== digest(profile)) throw new Error('Qualification changed during confirmation; import again');
          saveQualifications([...qualificationInventory(configuration.qualificationStorePath).filter(p => qualificationKey(p) !== qualificationKey(profile)), profile], configuration.qualificationStorePath);
          generation++;
        } else if (sub === 'revoke') {
          const key = args.slice(2).join(' ');
          const profiles = qualificationInventory(configuration.qualificationStorePath);
          if (!profiles.some(p => qualificationKey(p) === key)) throw new Error('Use an exact key from qualification list');
          saveQualifications(profiles.filter(p => qualificationKey(p) !== key), configuration.qualificationStorePath);
          generation++;
        } else if (sub !== 'list') throw new Error('Qualification commands: import <absolute local path>, list, revoke <exact key>');
        const eligibleKeys = new Set(loadQualifications(configuration.qualificationStorePath).map(qualificationKey));
        ctx.ui.notify(qualificationInventory(configuration.qualificationStorePath).map(p => `${qualificationKey(p)} · ${eligibleKeys.has(qualificationKey(p)) ? 'current' : 'ineligible: expired, missing or changed evidence'} · expires ${new Date(p.expiresAt).toISOString()} · ${p.evidenceRef}`).join('\n') || 'No trusted qualifications.', 'info');
        return;
      } else if (!['on', 'off', 'status', 'routes', 'recent'].includes(action)) throw new Error('Unknown routing command');
      if (action === 'on' || action === 'off') {
        if (action === 'on') { await client.available(); unchanged(); }
        configuration.setEnabled(action === 'on');
        if (action === 'off') {
          const disabledClient = client;
          await stopOwned();
          if (client === disabledClient) client = new WorkerClient(pi.events);
        }
      }
      const text = action === 'recent' ? recent.join('\n') || 'No recent worker decisions.' : action === 'routes'
        ? routes(ctx).map(item => `${item.eligible ? 'eligible' : 'excluded'} · ${routeKey(item.route)} · ${item.reason}`).join('\n') || 'No authenticated routes discovered.'
        : `Worker routing ${configuration.enabled() ? 'on' : 'off'} · ${records.size} owned handles\nPolicy: ${JSON.stringify(configuration.policy?.() ?? { mode: 'automatic' })}\nBaseline: ${ctx.model ? routeKey({ provider: ctx.model.provider, model: ctx.model.id }) : 'unavailable'} (current main model; never changed).\nCache residency: unknown · quota: unknown · context occupancy: unknown. Lifetime input usage is not context size.\nResume byte policy: ${WORKER_BYTE_BUDGET} observed prompt/result bytes; unobserved tool/system content has no known upper bound.\nMode: ${configuration.routingMode?.() ?? 'qualified'} · rubric mode uses eligible exact model descriptions; qualified mode requires matching end-to-end evidence. Main-model review always required.\nCommands: /jev-assist routing on|off|routes|status|recent|policy automatic|prefer-other-provider|allowlist <exact routes>|exclude <route>|include <route>|qualification import|list|revoke`;
      if (ctx.hasUI) ctx.ui.notify(text, 'info');
    },
  };
}
