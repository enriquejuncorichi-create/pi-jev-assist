import {writeFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import type {ExtensionAPI,ExtensionContext} from '@earendil-works/pi-coding-agent';
import type {AssistService} from '../src/service.js';
import {installAssist} from '../index.js';
function harness(evaluate:AssistService['evaluate'], hasUI=false, graph?:unknown) {
 const handlers=new Map<string,(event:never,ctx:ExtensionContext)=>unknown>();
 const entries:unknown[]=[]; const messages:Array<{message:unknown;options:unknown}>=[];
 let command:((args:string,ctx:ExtensionContext)=>Promise<void>)|undefined;
 const tools:unknown[]=[];
 const pi={on:(name:string,fn:(event:never,ctx:ExtensionContext)=>unknown)=>handlers.set(name,fn),appendEntry:(_t:string,data:unknown)=>entries.push(data),sendMessage:(message:unknown,options:unknown)=>messages.push({message,options}),registerCommand:(_n:string,def:{handler:typeof command})=>{command=def.handler;},registerTool:(def:unknown)=>tools.push(def)} as unknown as ExtensionAPI;
 const widgets:unknown[]=[];
 const ctx={hasUI,isIdle:()=>true,ui:{setWidget:(_key:string,value:unknown)=>widgets.push(value),setStatus:()=>{},notify:()=>{}}} as unknown as ExtensionContext;
 const service={evaluate,usage:()=>({requests:0,inputTokens:0,outputTokens:0,failures:0}),beginRun:()=>{}} as AssistService;
 // Always inject a graph. Without one the extension spawns a REAL `vortexd --mcp`
 // child at session_start, which is both slow and (before it was unref'd) kept
 // the test process alive forever.
 const inert={ensureIndexed:async()=>'unavailable',watch:async()=>false,findSymbol:async()=>undefined,blastRadius:async()=>{throw new Error('no graph in tests');},dispose:()=>{}};
 installAssist(pi,{service,readEnabled:()=>true,saveEnabled:()=>{},graph:(graph??inert) as never});
 const emit=(name:string,event:unknown={})=>Promise.resolve(handlers.get(name)?.(event as never,ctx));
 return {emit,entries,messages,widgets,command:(args:string)=>command!(args,ctx)};
}
const ok=(answers:Record<string,unknown>)=>({ok:true as const,answers,model:'jev-1.13.0',elapsedMs:1,usage:{input_tokens:10,output_tokens:0}});
const before={prompt:'Fix bug',systemPromptOptions:{skills:[{name:'testing',description:'test software',filePath:'/skills/testing/SKILL.md',disableModelInvocation:false}]}};
async function evidence(h:ReturnType<typeof harness>) {
 await h.emit('tool_execution_start',{toolCallId:'c1',toolName:'bash',args:{command:'bun run test'}});
 await h.emit('tool_execution_end',{toolCallId:'c1',toolName:'bash',result:{content:[{type:'text',text:'failure'}],details:{exitCode:1}},isError:true});
 await h.emit('message_end',{message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Fixed and all tests passed.'}]}});
}
test('automatic advice uses live catalogue and settled evidence, and wakes the agent when it speaks',async()=>{
 const requests:unknown[]=[];
 const h=harness(async req=>{requests.push(req);return requests.length===1?ok({s0:{noul:0.98}}):ok({claims_verified:{noul:0.98},unsupported_verification:{noul:0.99}});});
 await h.emit('session_start');
 const skills=await h.emit('before_agent_start',before) as {message:{content:string}};
 assert.match(skills.message.content,/\/skills\/testing\/SKILL.md/);
 await evidence(h); await h.emit('agent_settled'); await h.emit('agent_settled');
 assert.equal(requests.length,2); assert.equal(h.messages.length,1);
 // Changed deliberately: triggerTurn:false lands after the turn ends, so nothing
 // acts on it. Measured being ignored twice in one real session.
 assert.deepEqual(h.messages[0].options,{triggerTurn:true});
 assert.ok(!JSON.stringify(h.entries).includes('Fixed and all tests passed.'));
});
test('a conversation-only new run clears the prior warning widget',async()=>{
 const h=harness(async()=>ok({claims_verified:{noul:1},unsupported_verification:{noul:1}}),true);
 await h.emit('session_start');await h.emit('before_agent_start',before);await evidence(h);await h.emit('agent_settled');
 assert.ok(Array.isArray(h.widgets.at(-1)));
 await h.emit('before_agent_start',before);
 await h.emit('message_end',{message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Hello.'}]}});await h.emit('agent_settled');
 assert.equal(h.widgets.at(-1),undefined);
});
const compactSpan=(n=8)=>({preparation:{firstKeptEntryId:'e9',tokensBefore:1234,isSplitTurn:false,
 messagesToSummarize:[{role:'user',content:[{type:'text',text:'Fix the failing test. Never edit src/generated.'}]},
  ...Array.from({length:n},(_,i)=>[
   {role:'assistant',content:[{type:'toolCall',id:`t${i}`,name:'read',arguments:{path:`src/f${i}.ts`}}]},
   {role:'toolResult',toolCallId:`t${i}`,toolName:'read',isError:false,content:[{type:'text',text:'x'.repeat(4000)}]},
  ]).flat()]}});
test('compaction prunes verbatim and never sends raw tool output',async()=>{
 const requests:any[]=[];
 const h=harness(async req=>{requests.push(req);
  const answers:Record<string,unknown>={};
  for(const key of Object.keys((req as any).questions)) answers[key]={noul:0.05};
  return ok(answers);});
 await h.emit('session_start');
 const out=await h.emit('session_before_compact',compactSpan()) as {compaction:{summary:string;firstKeptEntryId:string}};
 assert.equal(out.compaction.firstKeptEntryId,'e9');
 // Verbatim: the user's constraint survives exactly.
 assert.match(out.compaction.summary,/Never edit src\/generated\./);
 // Dropped output is gone, and its absence is stated rather than silent. The
 // NEWEST results stay verbatim however they were scored: pinned means pinned.
 assert.match(out.compaction.summary,/output dropped as finished/);
 assert.ok(!out.compaction.summary.includes('src/f0.ts"}) \n[tool result]'),'an early result is not kept');
 const pinnedResults=(out.compaction.summary.match(/\[tool result\]/g)??[]).length;
 assert.ok(pinnedResults<=3,`only pinned results stay verbatim, saw ${pinnedResults}`);
 assert.ok(out.compaction.summary.length < 8*4000,'the span really shrank');
 // The request never carried the 4000-char tool outputs.
 assert.ok(!JSON.stringify(requests[0]).includes('x'.repeat(100)));
});
test('compaction falls back to Pi whenever it cannot do better',async()=>{
 // Each of these must return undefined so Pi writes its own summary.
 const unavailable=harness(async()=>({ok:false,reason:'timeout'}));
 await unavailable.emit('session_start');
 assert.equal(await unavailable.emit('session_before_compact',compactSpan()),undefined);

 const keepAll=harness(async req=>{const answers:Record<string,unknown>={};
  for(const key of Object.keys((req as any).questions)) answers[key]={noul:0.99};
  return ok(answers);});
 await keepAll.emit('session_start');
 // Everything kept means nothing saved, so a summary is the better tool.
 assert.equal(await keepAll.emit('session_before_compact',compactSpan()),undefined);

 const split=harness(async()=>ok({}));
 await split.emit('session_start');
 const ev=compactSpan(); (ev.preparation as any).isSplitTurn=true;
 assert.equal(await split.emit('session_before_compact',ev),undefined);

 const noTools=harness(async()=>ok({}));
 await noTools.emit('session_start');
 assert.equal(await noTools.emit('session_before_compact',{preparation:{firstKeptEntryId:'e1',tokensBefore:1,isSplitTurn:false,
  messagesToSummarize:[{role:'user',content:[{type:'text',text:'just talking'}]}]}}),undefined);
});
const fakeGraph=(callers:unknown[],opts:{fail?:boolean}={})=>({
 ensureIndexed:async()=>opts.fail?'unavailable':'indexed',
 watch:async()=>!opts.fail,
 findSymbol:async()=>opts.fail?undefined:'f::sym',
 blastRadius:async()=>{ if(opts.fail) throw new Error('workspace_not_indexed'); return {callers}; },
 dispose:()=>{},
} as any);

test('a write is speed-bumped once with the callers that depend on it',async()=>{
 const h=harness(async()=>ok({}),false,fakeGraph([{symbol:'attachBlob',path:'packages/files/src/attach.ts',depth:1}]));
 await h.emit('session_start',{reason:'startup'});
 const file='src/x.ts';
 writeFileSync('/tmp/jev-prewrite.ts','export function doThing() {}\n');
 const first=await h.emit('tool_call',{toolName:'write',toolCallId:'c1',input:{path:'/tmp/jev-prewrite.ts'}}) as {block?:boolean;reason?:string}|undefined;
 assert.equal(first?.block,true);
 assert.match(first!.reason!,/1 caller\(s\) depend/);
 assert.match(first!.reason!,/attachBlob/);
 assert.match(first!.reason!,/fires once per file/);
 // Re-issuing the same edit proceeds: a speed bump, not a gate.
 const second=await h.emit('tool_call',{toolName:'write',toolCallId:'c2',input:{path:'/tmp/jev-prewrite.ts'}});
 assert.equal(second,undefined);
 assert.equal(String(file),'src/x.ts');
});

test('the pre-write check fails OPEN and ignores non-code files',async()=>{
 // A down graph, a missing index or a slow daemon must never stop an edit.
 const broken=harness(async()=>ok({}),false,fakeGraph([],{fail:true}));
 await broken.emit('session_start',{reason:'resume'});
 writeFileSync('/tmp/jev-prewrite2.ts','export function other() {}\n');
 assert.equal(await broken.emit('tool_call',{toolName:'write',toolCallId:'c1',input:{path:'/tmp/jev-prewrite2.ts'}}),undefined);

 const ok2=harness(async()=>ok({}),false,fakeGraph([{symbol:'a',path:'b.ts',depth:1}]));
 await ok2.emit('session_start',{reason:'startup'});
 // Not code: never bumped, never queried.
 assert.equal(await ok2.emit('tool_call',{toolName:'write',toolCallId:'c2',input:{path:'notes.md'}}),undefined);
 // Not a write: a read is not a change.
 assert.equal(await ok2.emit('tool_call',{toolName:'read',toolCallId:'c3',input:{path:'/tmp/jev-prewrite.ts'}}),undefined);
});

test('a resumed session re-bootstraps and clears prior speed bumps',async()=>{
 const h=harness(async()=>ok({}),false,fakeGraph([{symbol:'a',path:'b.ts',depth:1}]));
 await h.emit('session_start',{reason:'startup'});
 writeFileSync('/tmp/jev-prewrite3.ts','export function third() {}\n');
 assert.equal(((await h.emit('tool_call',{toolName:'edit',toolCallId:'c1',input:{path:'/tmp/jev-prewrite3.ts'}})) as {block?:boolean})?.block,true);
 // Resume: the same file must be bumped again, because bumps are per session.
 await h.emit('session_start',{reason:'resume'});
 assert.equal(((await h.emit('tool_call',{toolName:'edit',toolCallId:'c2',input:{path:'/tmp/jev-prewrite3.ts'}})) as {block?:boolean})?.block,true);
});

test('a flagged review WAKES the agent, and cannot loop',async()=>{
 // triggerTurn:false lands after the turn ends, so nothing acts on it: observed
 // being ignored twice in one real session while the flagged claim was in fact
 // unevidenced. A flag must interrupt; the run it starts must not flag again.
 const flag=()=>ok({claims_verified:{noul:0.95},unsupported_verification:{noul:0.95}});
 const h=harness(async()=>flag());
 await h.emit('session_start',{reason:'startup'});
 await h.emit('before_agent_start',before); await evidence(h); await h.emit('agent_settled');
 assert.equal(h.messages.length,1);
 assert.deepEqual(h.messages[0].options,{triggerTurn:true},'a flagged review must wake the agent');
 assert.match(String((h.messages[0].message as {content:string}).content),/Acknowledge each point above/,'it must demand engagement, not offer a banner');

 // The run our wake started: same flags stay silent (not a muted duplicate banner).
 await h.emit('before_agent_start',before); await evidence(h); await h.emit('agent_settled');
 assert.equal(h.messages.length,1,'repeating the same flags must not post again');
});

test('a wake follow-up with different flags still posts without waking',async()=>{
 let reviews=0;
 const h=harness(async req=>{
  if (!('unsupported_verification' in (req as {questions:object}).questions)) return ok({s0:{noul:0.1}});
  reviews++;
  return reviews===1
   ? ok({claims_verified:{noul:0.95},unsupported_verification:{noul:0.95}})
   : ok({claims_done:{noul:0.95},unresolved_failure:{noul:0.9},verification_applies:{noul:0.1}});
 });
 await h.emit('session_start',{reason:'startup'});
 await h.emit('before_agent_start',before); await evidence(h); await h.emit('agent_settled');
 await h.emit('before_agent_start',before); await evidence(h); await h.emit('agent_settled');
 assert.equal(h.messages.length,2);
 assert.deepEqual(h.messages[1].options,{triggerTurn:false});
});

test('a wrap-up with git/gh and no check does not review at all',async()=>{
 // Observed: every turn that said "done" / "96 tests green" posted both flags
 // after only git/gh/bg_logs ran. The classifiers score prose, not the ledger.
 let reviews=0;
 const h=harness(async req=>{ if('unsupported_verification' in (req as {questions:object}).questions) reviews++; return ok({claims_verified:{noul:0.99},unsupported_verification:{noul:0.99},claims_done:{noul:0.99},unresolved_failure:{noul:0.99}}); });
 await h.emit('session_start',{reason:'startup'});
 await h.emit('before_agent_start',before);
 await h.emit('tool_execution_start',{toolCallId:'g',toolName:'bash',args:{command:'git log --oneline'}});
 await h.emit('tool_execution_end',{toolCallId:'g',toolName:'bash',result:{content:[{type:'text',text:'abc'}],details:undefined},isError:false});
 await h.emit('message_end',{message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Everything is pushed. 96 tests green. Repo is live.'}]}});
 await h.emit('agent_settled');
 assert.equal(reviews,0,'must not even call Jev');
 assert.equal(h.messages.length,0);
});

test('an unflagged review says nothing at all',async()=>{
 // The ranking of the assistant's own sentences used to print every turn. Chrome
 // is why the banner got ignored.
 const h=harness(async()=>ok({support_0:{noul:0.9},impact_0:{score:1}}));
 await h.emit('session_start',{reason:'startup'});
 await h.emit('before_agent_start',before); await evidence(h); await h.emit('agent_settled');
 assert.equal(h.messages.length,0,'no flag means no message');
});

test('a flagged review names the command to re-run',async()=>{
 const h=harness(async()=>ok({claims_verified:{noul:0.95},unsupported_verification:{noul:0.95}}));
 await h.emit('session_start',{reason:'startup'});
 await h.emit('before_agent_start',before);
 await h.emit('tool_execution_start',{toolCallId:'c9',toolName:'bash',args:{command:'bun test src/capture/__tests__/join.test.ts'}});
 await h.emit('tool_execution_end',{toolCallId:'c9',toolName:'bash',result:{content:[{type:'text',text:'66 pass'}],details:undefined},isError:false});
 await h.emit('message_end',{message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'All 66 tests pass and typecheck is clean.'}]}});
 await h.emit('agent_settled');
 const content=String((h.messages[0].message as {content:string}).content);
 assert.match(content,/Re-run and report the exit code/);
 assert.match(content,/join\.test\.ts/);
});

test('off switch prevents calls, not just visible advice',async()=>{
 let calls=0; const h=harness(async()=>{calls++;return ok({});}); await h.emit('session_start'); await h.command('off');
 await h.emit('before_agent_start',before); await evidence(h); await h.emit('agent_settled'); assert.equal(calls,0);
});
test('late skill response after shutdown cannot inject or persist',async()=>{
 let resolve!:(value:ReturnType<typeof ok>)=>void;
 const h=harness(()=>new Promise(r=>{resolve=r;})); await h.emit('session_start');
 const pending=h.emit('before_agent_start',before); await h.emit('session_shutdown'); resolve(ok({s0:{noul:1}}));
 assert.equal(await pending,undefined);
 // session_start now records an index-bootstrap entry, so assert on the SKILL
 // stage rather than on total silence.
 assert.equal(h.entries.filter((e:any)=>e.stage==='skills').length,0);
});
test('tree navigation invalidates pending review and output',async()=>{
 let call=0; let resolve!:(value:ReturnType<typeof ok>)=>void;
 const h=harness(async()=>{call++;if(call===1)return ok({});return new Promise(r=>{resolve=r;});});
 await h.emit('session_start'); await h.emit('before_agent_start',before); await evidence(h);
 const pending=h.emit('agent_settled'); await h.emit('session_tree');
 resolve(ok({claims_verified:{noul:1},unsupported_verification:{noul:1}})); await pending; assert.equal(h.messages.length,0);
});
test('a new prompt invalidates previous review and aborted messages are not reviewed',async()=>{
 let call=0; let resolve!:(value:ReturnType<typeof ok>)=>void;
 const h=harness(async()=>{call++;if(call===2)return new Promise(r=>{resolve=r;});return ok({});});
 await h.emit('session_start');await h.emit('before_agent_start',before);await evidence(h);
 const pending=h.emit('agent_settled'); await h.emit('before_agent_start',before);
 resolve(ok({claims_verified:{noul:1},unsupported_verification:{noul:1}}));await pending;assert.equal(h.messages.length,0);
 await evidence(h);await h.emit('message_end',{message:{role:'assistant',stopReason:'aborted',content:[]}});await h.emit('agent_settled');assert.equal(call,3);
});
test('a repeated bash or read this turn is blocked rather than re-executed',async()=>{
 const h=harness(async()=>ok({}));
 await h.emit('session_start');
 await h.emit('before_agent_start',before);
 const first=await h.emit('tool_call',{toolName:'bash',input:{command:'rg reviewAdvice'}});
 assert.equal(first,undefined);
 const second=await h.emit('tool_call',{toolName:'bash',input:{command:'rg reviewAdvice'}}) as {block:boolean;reason:string};
 assert.equal(second.block,true);
 assert.match(second.reason,/Already ran/);
 const other=await h.emit('tool_call',{toolName:'bash',input:{command:'rg other'}});
 assert.equal(other,undefined);
});
test('mode and constraint join the hidden skills message when Jev is sure',async()=>{
 const h=harness(async()=>ok({
  s0:{noul:0.2},
  mode:{choice:'investigate',confidence:0.91},
  hard_constraint:{noul:0.9},
 }));
 await h.emit('session_start');
 const out=await h.emit('before_agent_start',{prompt:'Who calls reviewAdvice? Never edit src/generated.ts',systemPromptOptions:{skills:[{name:'testing',description:'test software',filePath:'/skills/testing/SKILL.md',disableModelInvocation:false}]}}) as {message:{content:string}};
 assert.match(out.message.content,/Task mode investigate/);
 assert.match(out.message.content,/Never edit src\/generated/);
 assert.equal(out.message.content.includes('/skills/testing'),false);
});
test('huge tool results are clipped before they enter the transcript',async()=>{
 const h=harness(async()=>ok({}));
 await h.emit('session_start');
 const text='Z'.repeat(25_000);
 const out=await h.emit('tool_result',{toolName:'bash',toolCallId:'h1',content:[{type:'text',text}]}) as {content:Array<{text:string}>};
 assert.ok(out.content[0]!.text.length < text.length);
 assert.match(out.content[0]!.text,/omitted/);
 assert.ok(JSON.stringify(h.entries).includes('clip-huge'));
});
test('live context prune drops finished tool output in place',async()=>{
 const h=harness(async req=>{
  const answers:Record<string,unknown>={};
  for(const key of Object.keys((req as {questions:Record<string,unknown>}).questions)) answers[key]={noul:0.05};
  return ok(answers);
 });
 await h.emit('session_start');
 await h.emit('before_agent_start',before);
 const messages=[
  {role:'user',content:[{type:'text',text:'Investigate reviewAdvice'}]},
  ...Array.from({length:8},(_,i)=>[
   {role:'assistant',content:[{type:'toolCall',id:`t${i}`,name:'read',arguments:{path:`f${i}.ts`}}]},
   {role:'toolResult',toolCallId:`t${i}`,toolName:'read',isError:false,content:[{type:'text',text:'y'.repeat(2000)}]},
  ]).flat(),
 ];
 const out=await h.emit('context',{messages}) as {messages:typeof messages};
 assert.ok(out.messages);
 const bodies=out.messages.filter(m=>m.role==='toolResult').map(m=>(m.content as Array<{text:string}>)[0]!.text);
 assert.ok(bodies.some(t=>/dropped as finished/.test(t)));
});
test('service failure is recorded as unavailable, not a clear result',async()=>{
 const h=harness(async()=>({ok:false,reason:'timeout'}));await h.emit('session_start');await h.emit('before_agent_start',before);await evidence(h);await h.emit('agent_settled');
 assert.equal(h.messages.length,0);assert.match(JSON.stringify(h.entries),/unavailable/);
});
