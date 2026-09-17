import test from 'node:test';
import assert from 'node:assert/strict';
import { skillRequest, selectedSkills, reviewRequest, reviewAdvice, clean, probability, certainty, IncompleteAnswersError, GAPS } from '../src/decisions.js';
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
