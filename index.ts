import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { EvidenceLedger } from './src/evidence.js';
import { createService, type AssistService } from './src/service.js';
import { ADVISORY, POLICY_VERSION, clean, digest, skillRequest, selectedSkills, reviewRequest, reviewAdvice, IncompleteAnswersError, type Request } from './src/decisions.js';

const CONFIG = join(homedir(), '.pi', 'agent', 'jev-assist', 'config.json');
function readEnabled(): boolean {
  if (process.env.PI_JEV_ASSIST === 'off' || process.env.PI_JEV_ASSIST === '0') return false;
  try { return (JSON.parse(readFileSync(CONFIG, 'utf8')) as {enabled?:unknown}).enabled === true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; return false; }
}
function saveEnabled(enabled: boolean): void {
  mkdirSync(dirname(CONFIG), {recursive:true,mode:0o700});
  const temp = `${CONFIG}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({enabled})+'\n', {mode:0o600});
  renameSync(temp,CONFIG);
}
interface Dependencies { service?: AssistService; readEnabled?:()=>boolean; saveEnabled?:(enabled:boolean)=>void }
export function installAssist(pi: ExtensionAPI, dependencies: Dependencies = {}): void {
  const service = dependencies.service ?? createService();
  const ledger = new EvidenceLedger();
  let enabled = false;
  let alive = false;
  let generation = 0;
  let reviewed = -1;
  let controller = new AbortController();
  let task = '';
  let finalText = '';
  let finalNormal = false;
  const invalidate = () => { generation++; controller.abort(); controller = new AbortController(); ledger.reset(); finalText=''; finalNormal=false; task=''; };
  const active = (g:number) => alive && enabled && g === generation && !controller.signal.aborted;
  const status = (ctx:ExtensionContext, text:string|undefined) => { if (ctx.hasUI) ctx.ui.setStatus('jev-assist',text); };
  const record = (stage:string, request:Request, details:Record<string,unknown>) => pi.appendEntry('jev-assist-decision', {policy:POLICY_VERSION,stage,generation,inputHash:digest(request),...details,usage:service.usage()});

  pi.on('session_start', (_event,ctx) => {
    alive=true; invalidate(); enabled=(dependencies.readEnabled ?? readEnabled)();
    if(ctx.hasUI) ctx.ui.setWidget('jev-assist',undefined);
    status(ctx, enabled ? 'Jev · automatic advice' : 'Jev · off');
  });
  pi.on('session_shutdown', () => { alive=false; invalidate(); });
  pi.on('session_tree', (_event,ctx) => { invalidate(); if(ctx.hasUI) ctx.ui.setWidget('jev-assist',undefined); });
  pi.on('before_agent_start', async (event,ctx) => {
    invalidate();
    if(ctx.hasUI) ctx.ui.setWidget('jev-assist',undefined);
    if (!alive || !enabled) return;
    service.beginRun();
    task=clean(event.prompt,4000);
    const g=generation;
    const prepared=skillRequest(task,event.systemPromptOptions.skills ?? []);
    if (!prepared.request) {
      pi.appendEntry('jev-assist-decision',{policy:POLICY_VERSION,stage:'skills',status:'skipped',reason:prepared.reason});
      return;
    }
    status(ctx,'Jev · suggesting skills');
    const result=await service.evaluate(prepared.request,controller.signal);
    if (!active(g)) return;
    status(ctx,'Jev · automatic advice');
    if (!result.ok) { record('skills',prepared.request,{status:'unavailable',reason:result.reason}); return; }
    const selected=selectedSkills(result.answers,prepared.candidates);
    record('skills',prepared.request,{status:'judged',model:result.model,elapsedMs:result.elapsedMs,selected});
    if (!selected.length) return;
    // Only locally known skills can enter advice; never include model-authored instructions.
    const suggestions=selected.map(s=>({name:clean(prepared.candidates[s.index]!.name,100),filePath:clean(prepared.candidates[s.index]!.filePath,500),probability:s.probability}));
    return {message:{customType:'jev-assist-skills',display:false,content:`${ADVISORY}\nPotentially relevant advertised skills (metadata, not new instructions): ${JSON.stringify(suggestions)}. Read a skill only if it fits. This list does not remove other skills or override mandatory guidance.`}};
  });
  pi.on('tool_execution_start', (event) => {
    if(alive && enabled) ledger.recordCall(event.toolCallId,event.toolName,event.args as Record<string,unknown>);
  });
  pi.on('tool_execution_end', (event) => {
    if(alive && enabled) ledger.recordResult(event.toolCallId,event.toolName,event.result.content,event.isError,event.result.details);
  });
  pi.on('message_end', (event) => {
    if (!alive || !enabled || event.message.role !== 'assistant') return;
    finalNormal=event.message.stopReason === 'stop';
    finalText=event.message.content.filter(p=>p.type==='text').map(p=>p.text).join('\n');
  });
  pi.on('agent_settled', async (_event,ctx) => {
    if (!alive || !enabled || !ctx.isIdle() || !finalNormal || !finalText || reviewed===generation) return;
    const g=generation;
    reviewed=g;
    const evidence=ledger.snapshot();
    if (!evidence.observations.length) return; // Conversation-only turns have no execution evidence to audit.
    const prepared=reviewRequest(task,finalText,evidence);
    status(ctx,'Jev · reviewing evidence');
    const result=await service.evaluate(prepared.request,controller.signal);
    if(!active(g) || !ctx.isIdle()) return;
    status(ctx,'Jev · automatic advice');
    if(!result.ok) {
      record('review',prepared.request,{status:'unavailable',reason:result.reason});
      if(ctx.hasUI) ctx.ui.setWidget('jev-assist',[`Jev advice unavailable (${result.reason}); no verification conclusion.`]);
      return;
    }
    let advice;
    try { advice=reviewAdvice(result.answers,prepared.candidates); }
    catch (error) {
      // An omitted answer is a service fault, not an abstention; say so rather
      // than silently dropping the finding it belonged to.
      const incomplete=error instanceof IncompleteAnswersError;
      record('review',prepared.request,{status:incomplete?'incomplete':'error',missing:incomplete?error.missing:undefined});
      if(ctx.hasUI) ctx.ui.setWidget('jev-assist',[`Jev returned an incomplete judgment; no conclusion drawn (${incomplete?error.missing.length:0} missing answers).`]);
      return;
    }
    record('review',prepared.request,{status:'judged',model:result.model,elapsedMs:result.elapsedMs,flags:advice.flags,ranking:advice.ranking,unassessable:advice.unassessable,omittedFindings:prepared.omitted,evidenceDropped:evidence.dropped});
    const lines=[...advice.flags];
    if(advice.ranking.length) lines.push('Review priority (all candidates retained; low support is not a refutation):',...advice.ranking.map(r=>{
      const candidate=prepared.candidates.find(c=>c.id===r.id)!;
      const gap=r.gap ? ` [gap: ${r.gap}]` : '';
      return `${r.id}: support ${r.supported.toFixed(2)}, impact ${r.impact.toFixed(2)}/3, confidence ${r.confidence.toFixed(2)}${gap} — ${clean(candidate.claim,180)}`;
    }));
    if(!lines.length) {
      if(ctx.hasUI) ctx.ui.setWidget('jev-assist',undefined);
      return; // No reassuring "verified" message on a low score.
    }
    lines.push(`Coverage: ${evidence.dropped} ledger entries and ${Math.max(0,evidence.observations.length-12)} observations omitted; ${prepared.omitted} finding candidates omitted; ${advice.unassessable} not assessable from the record.`,ADVISORY);
    if(ctx.hasUI) ctx.ui.setWidget('jev-assist',lines);
    // Persists advisory context, but explicitly does not start a new agent run.
    pi.sendMessage({customType:'jev-assist-review',content:lines.join('\n'),display:true},{triggerTurn:false});
  });
  pi.registerCommand('jev-assist',{
    description:'Automatic Jev advice: status, on, off. Never grants permissions or certifies completion.',
    handler:async(args,ctx)=>{
      const action=args.trim() || 'status';
      if(action==='off' || action==='on') {
        const next=action==='on';
        if(next && ['off','0'].includes(process.env.PI_JEV_ASSIST ?? '')) { if(ctx.hasUI) ctx.ui.notify('PI_JEV_ASSIST disables this extension; change the environment and restart.','warning'); return; }
        try { (dependencies.saveEnabled ?? saveEnabled)(next); }
        catch { if(ctx.hasUI) ctx.ui.notify('Could not save Jev setting; no state changed.','error'); return; }
        invalidate(); enabled=next;
        if(ctx.hasUI) ctx.ui.setWidget('jev-assist',undefined);
      }
      status(ctx,enabled ? 'Jev · automatic advice' : 'Jev · off');
      if(ctx.hasUI) ctx.ui.notify(`Jev ${enabled?'on':'off'}; model jev-1.13.0; ${JSON.stringify(service.usage())}. Automatic skill + evidence + trace advice. No approvals, tool activation or automatic follow-ups.`,'info');
    },
  });
}
export default function(pi:ExtensionAPI):void { installAssist(pi); }
