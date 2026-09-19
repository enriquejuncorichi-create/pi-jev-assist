import test from 'node:test';
import assert from 'node:assert/strict';
import { skillRequest, selectedSkills, reviewRequest, reviewAdvice, reviewable, isCheckCommand, isGitPorcelain, runnerPassed, claimSupportRequest, clean, probability, certainty, IncompleteAnswersError, GAPS } from '../src/decisions.js';
import { doneQuestions, stuckQuestions } from 'pi-warden';
const skill={name:'testing',description:'Run and interpret tests',filePath:'/skills/testing/SKILL.md'};
test('skills use advertised catalogue only, preserving real filePath',()=>{
 const prepared=skillRequest('run tests',[skill,{...skill,name:'manual',disableModelInvocation:true}]);
 assert.equal(prepared.candidates.length,1); assert.equal(prepared.candidates[0].filePath,skill.filePath);
 assert.deepEqual(selectedSkills({s0:{type:'noul',noul:0.91}},prepared.candidates),[{index:0,probability:0.91}]);
 assert.deepEqual(selectedSkills({s0:{noul:0.89},invented:{noul:1}},prepared.candidates),[]);
});
test('overlarge catalogue abstains explicitly instead of claiming full coverage',()=>{
 const result=skillRequest('test',Array.from({length:129},()=>skill)); assert.equal(result.request,undefined); assert.match(result.reason!,/no candidates scored/);
});
test('bad probabilities cannot become advice',()=>{ for(const v of [NaN,Infinity,-1,2,'1',null]) assert.equal(probability({noul:v}),undefined); });
test('uses upstream warden questions with matching state keys',()=>{
 const observations=Array.from({length:3},(_,i)=>({id:String(i),tool:'bash',call:'false',output:'failure',status:'error' as const,mutation:false,sequence:i}));
 const p=reviewRequest('fix tests','Risk: failed tests',{observations,mutations:1,unknownMutations:0,dropped:0});
 assert.deepEqual(p.request.questions.claims_done,doneQuestions.claims_done);
 assert.deepEqual(p.request.questions.same_strategy,stuckQuestions.same_strategy);
 const state=p.request.state as Record<string,unknown>; assert.equal(state.final_message,'Risk: failed tests'); assert.ok(state.attempts);
});
test('a wrap-up with no check, mutation or work-tool error is not reviewable',()=>{
 const obs=(tool:string,call:string,status:'ok'|'error'='ok')=>({id:tool,tool,call,output:'x',status,mutation:false,sequence:1});
 assert.equal(reviewable('Repo is live. 96 tests green.',{observations:[obs('bash','git log --oneline'),obs('read','README.md')],mutations:0}),false);
 assert.equal(reviewable('All 66 tests pass.',{observations:[obs('bash','bun test src/join.test.ts')],mutations:0}),true);
 assert.equal(reviewable('Done.',{observations:[obs('bash','false','error')],mutations:0}),true);
 assert.equal(reviewable('Pushed.',{observations:[],mutations:1}),true);
 assert.equal(reviewable('Done.',{observations:[obs('bg_run','timeout','error')],mutations:0}),false);
 // Observed: prettier/git on `*.test.ts` was treated as a check because `\btest\b` matches the path.
 assert.equal(reviewable('Formatted.',{observations:[obs('bash','bun prettier --write scripts/guard-worktree-install.test.ts')],mutations:0}),false);
 assert.equal(isCheckCommand('bun prettier --write scripts/guard-worktree-install.test.ts'),false);
 assert.equal(isCheckCommand('bun test scripts/guard-worktree-install.test.ts'),true);
 // Observed: `prettier --check` was named as the command to re-run because `\bcheck\b` matches `--check`.
 assert.equal(isCheckCommand('/home/enrique/Projects/ccd-platform/node_modules/.bin/prettier --check'),false);
 assert.equal(isCheckCommand('npm run check'),true);
 // Observed: `git diff … test/decisions.test.ts` was named as a check because `test/` is a path.
 assert.equal(isCheckCommand('git diff --stat src/decisions.ts test/decisions.test.ts'),false);
});

test('a green node:test summary or TSC:0 is a recorded pass',()=>{
 assert.equal(runnerPassed('TSC:0\n'),true);
 assert.equal(runnerPassed('TEST_EXIT:0\n108 pass'),true);
 assert.equal(runnerPassed('ℹ tests 108\nℹ pass 108\nℹ fail 0\n'),true);
 assert.equal(runnerPassed('TEST_EXIT:1\n'),false);
 const obs={id:'1',tool:'bash',call:'bun run test',output:'ℹ pass 108\nℹ fail 0',status:'ok' as const,mutation:false,sequence:1};
 assert.equal(reviewRequest('t','108 tests pass',{observations:[obs],mutations:0,unknownMutations:0,dropped:0}).runnerOk,true);
 const answers={claims_verified:{noul:0.99},unsupported_verification:{noul:0.99},verification_applies:{noul:0.99}};
 assert.equal(reviewAdvice(answers,[],true,false,true).flags.length,0);
});

test('claim-support refuses empty evidence',()=>{
 assert.deepEqual(claimSupportRequest('tests passed',''),{reason:'evidence empty — refuse rather than score vibes'});
 assert.ok('request' in claimSupportRequest('tests passed on this revision','TEST_EXIT:0\n105 pass 0 fail bun run test'));
});

test('empty git commit is not a work-tool error',()=>{
 const git={id:'1',tool:'bash',call:'cd /tmp/ccd-996 && git commit -m fix',output:'nothing to commit, working tree clean\nCOMMIT_EXIT:1',status:'error' as const,mutation:false,sequence:1};
 const fail={id:'2',tool:'bash',call:'bun test scripts/x.test.ts',output:'fail',status:'error' as const,mutation:false,sequence:2};
 assert.equal(isGitPorcelain(git.call),true);
 assert.equal(isGitPorcelain('git add a.test.ts && git commit -m x'),true);
 assert.equal(isGitPorcelain('bun prettier --write a.test.ts && git commit -m x'),false);
 assert.equal(reviewRequest('t','done',{observations:[git],mutations:0,unknownMutations:0,dropped:0}).hadWorkError,false);
 assert.equal(reviewRequest('t','done',{observations:[fail],mutations:0,unknownMutations:0,dropped:0}).hadWorkError,true);
});

test('unresolved-failure flag needs a work-tool error, not just completion language',()=>{
 const answers={claims_done:{noul:0.95},unresolved_failure:{noul:0.9},claims_verified:{noul:0.95},unsupported_verification:{noul:0.9},verification_applies:{noul:0.1}};
 assert.equal(reviewAdvice(answers,[],false,false).flags.length,0);
});

test('no positive verification verdict and missing answers do not become warnings',()=>{
 assert.deepEqual(reviewAdvice({},[]),{flags:[],ranking:[],unassessable:0});
 const advice=reviewAdvice({claims_done:{noul:0.95},unresolved_failure:{noul:0.9}},[]);
 assert.equal(advice.flags.length,1); assert.match(advice.flags[0],/Possible unresolved/);
});
test('review triage ranks supported findings before unsupported severe ones',()=>{
 const advice=reviewAdvice({assessable_0:{noul:1},support_0:{noul:0.1},impact_0:{score:3},assessable_1:{noul:1},support_1:{noul:0.9},impact_1:{score:1}},[{id:'f0',claim:'a'},{id:'f1',claim:'b'}]);
 assert.deepEqual(advice.ranking.map(r=>r.id),['f1','f0']);
});
test('an unassessable finding abstains and is never reported as weak support',()=>{
 const candidates=[{id:'f0',claim:'a'}];
 const advice=reviewAdvice({assessable_0:{noul:0.2},support_0:{noul:0.1},impact_0:{score:3}},candidates);
 assert.deepEqual(advice.ranking,[]);
 assert.equal(advice.unassessable,1);
 // A clean run therefore posts nothing at all, rather than a 0.1-support line.
 assert.equal(advice.flags.length,0);
});
test('an omitted answer is a loud fault, not a silently dropped finding',()=>{
 const candidates=[{id:'f0',claim:'a'}];
 assert.throws(()=>reviewAdvice({assessable_0:{noul:1},support_0:{noul:0.9}},candidates),(error:unknown)=>
  error instanceof IncompleteAnswersError && error.missing.includes('impact_0'));
 assert.throws(()=>reviewAdvice({support_0:{noul:0.9},impact_0:{score:1}},candidates),/assessable_0/);
});
test('confidence is bounded by the weakest link and gaps come from the fixed list',()=>{
 const candidates=[{id:'f0',claim:'a'}];
 const advice=reviewAdvice({assessable_0:{noul:0.6},support_0:{noul:0.95},impact_0:{score:2,confidence:0.9},gap_0:{choice:'no_source'}},candidates);
 assert.equal(advice.ranking[0].confidence,Math.min(certainty(0.6),certainty(0.95),0.9));
 assert.equal(advice.ranking[0].confidence,0.6);
 assert.equal(advice.ranking[0].gap,GAPS.no_source);
 // A model-invented key cannot introduce prose into the advice.
 const invented=reviewAdvice({assessable_0:{noul:1},support_0:{noul:0.9},impact_0:{score:1},gap_0:{choice:'arbitrary prose from the model'}},candidates);
 assert.equal(invented.ranking[0].gap,undefined);
 const none=reviewAdvice({assessable_0:{noul:1},support_0:{noul:0.9},impact_0:{score:1},gap_0:{choice:'no_material_gap'}},candidates);
 assert.equal(none.ranking[0].gap,undefined);
});
test('every finding gets an applicability and bounded gap question',()=>{
 const p=reviewRequest('task','Finding 0: bug',{observations:[],mutations:0,unknownMutations:0,dropped:0});
 const q=p.request.questions as Record<string,any>;
 assert.equal(q.assessable_0.type,'noul');
 assert.equal(q.gap_0.type,'choice');
 assert.deepEqual(q.gap_0.criteria,GAPS);
 assert.ok('no_material_gap' in q.gap_0.criteria);
});
test('redaction runs before truncation and findings omissions are explicit',()=>{
 const secret='ghp_'+'a'.repeat(36); assert.ok(!clean(secret,15).includes('ghp_'));
 const p=reviewRequest('task',Array.from({length:8},(_,i)=>`Finding ${i}: bug`).join('\n\n'),{observations:[],mutations:0,unknownMutations:0,dropped:0});
 assert.equal(p.candidates.length,6); assert.equal(p.omitted,2);
});
