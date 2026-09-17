// Synthetic inputs only: no repository, session or skill files are sent.
import { createService } from '../src/service.js';
import { skillRequest, reviewRequest, selectedSkills, reviewAdvice } from '../src/decisions.js';
const service=createService({timeoutMs:2500});
const skills=skillRequest('Diagnose a process core dump',[{name:'crash-analysis',description:'Diagnose SIGSEGV and core dumps using debugger evidence',filePath:'/synthetic/crash/SKILL.md'},{name:'style-guide',description:'Choose colour palettes and fonts',filePath:'/synthetic/style/SKILL.md'}]);
const s=await service.evaluate(skills.request!);
if(!s.ok) throw new Error(`synthetic skill smoke unavailable: ${s.reason}`);
console.log(JSON.stringify({stage:'skills',model:s.model,elapsedMs:s.elapsedMs,selected:selectedSkills(s.answers,skills.candidates),usage:s.usage}));
const prepared=reviewRequest('Fix the failing tests','All tests passed. The bug is fixed.',{mutations:1,unknownMutations:0,dropped:0,observations:[{id:'t',tool:'bash',call:'cd /repo && bun run test | tail -20',output:'Test suite failed: expected 2, received 3. Exit code 1.',status:'error',mutation:false,sequence:1}]});
const r=await service.evaluate(prepared.request);
if(!r.ok) throw new Error(`synthetic review smoke unavailable: ${r.reason}`);
console.log(JSON.stringify({stage:'review',model:r.model,elapsedMs:r.elapsedMs,advice:reviewAdvice(r.answers,prepared.candidates),usage:r.usage}));
console.log(JSON.stringify({sessionUsage:service.usage()}));
