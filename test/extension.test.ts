import test from 'node:test';
import assert from 'node:assert/strict';
import type {ExtensionAPI,ExtensionContext} from '@earendil-works/pi-coding-agent';
import type {AssistService} from '../src/service.js';
import {installAssist} from '../index.js';
function harness(evaluate:AssistService['evaluate'], hasUI=false) {
 const handlers=new Map<string,(event:never,ctx:ExtensionContext)=>unknown>();
 const entries:unknown[]=[]; const messages:Array<{message:unknown;options:unknown}>=[];
 let command:((args:string,ctx:ExtensionContext)=>Promise<void>)|undefined;
 const pi={on:(name:string,fn:(event:never,ctx:ExtensionContext)=>unknown)=>handlers.set(name,fn),appendEntry:(_t:string,data:unknown)=>entries.push(data),sendMessage:(message:unknown,options:unknown)=>messages.push({message,options}),registerCommand:(_n:string,def:{handler:typeof command})=>{command=def.handler;}} as unknown as ExtensionAPI;
 const widgets:unknown[]=[];
 const ctx={hasUI,isIdle:()=>true,ui:{setWidget:(_key:string,value:unknown)=>widgets.push(value),setStatus:()=>{},notify:()=>{}}} as unknown as ExtensionContext;
 const service={evaluate,usage:()=>({requests:0,inputTokens:0,outputTokens:0,failures:0}),beginRun:()=>{}} as AssistService;
 installAssist(pi,{service,readEnabled:()=>true,saveEnabled:()=>{}});
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
test('automatic advice uses live catalogue and settled evidence, never triggers a new turn',async()=>{
 const requests:unknown[]=[];
 const h=harness(async req=>{requests.push(req);return requests.length===1?ok({s0:{noul:0.98}}):ok({claims_verified:{noul:0.98},unsupported_verification:{noul:0.99}});});
 await h.emit('session_start');
 const skills=await h.emit('before_agent_start',before) as {message:{content:string}};
 assert.match(skills.message.content,/\/skills\/testing\/SKILL.md/);
 await evidence(h); await h.emit('agent_settled'); await h.emit('agent_settled');
 assert.equal(requests.length,2); assert.equal(h.messages.length,1);
 assert.deepEqual(h.messages[0].options,{triggerTurn:false});
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
test('off switch prevents calls, not just visible advice',async()=>{
 let calls=0; const h=harness(async()=>{calls++;return ok({});}); await h.emit('session_start'); await h.command('off');
 await h.emit('before_agent_start',before); await evidence(h); await h.emit('agent_settled'); assert.equal(calls,0);
});
test('late skill response after shutdown cannot inject or persist',async()=>{
 let resolve!:(value:ReturnType<typeof ok>)=>void;
 const h=harness(()=>new Promise(r=>{resolve=r;})); await h.emit('session_start');
 const pending=h.emit('before_agent_start',before); await h.emit('session_shutdown'); resolve(ok({s0:{noul:1}}));
 assert.equal(await pending,undefined); assert.equal(h.entries.length,0);
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
test('service failure is recorded as unavailable, not a clear result',async()=>{
 const h=harness(async()=>({ok:false,reason:'timeout'}));await h.emit('session_start');await h.emit('before_agent_start',before);await evidence(h);await h.emit('agent_settled');
 assert.equal(h.messages.length,0);assert.match(JSON.stringify(h.entries),/unavailable/);
});
