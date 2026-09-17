import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyToolResult,needsDoneCheck,redact,doneQuestions,stuckQuestions} from 'pi-warden';
import {createTypeSafe} from 'pi-typesafe';

test('document why upstream done outcome policy is not used as our verifier',()=>{
 assert.equal(classifyToolResult('bash',{command:'echo "bun test"'},false),'check-pass');
 assert.equal(needsDoneCheck({mutations:1,checks:[{call:'bun run test',passed:false},{call:'bun run lint',passed:true}]}),false);
});
test('secret-name redaction refuses no legitimate internal caller field',async()=>{
 const {createService}=await import('../src/service.js');
 let sent='';
 const service=createService({keyLoader:()=>'synthetic',factory:options=>createTypeSafe({...options,fetch:async(_u,init)=>{sent=String(init?.body);return new Response('{}',{status:200});}})});
 const questions={...doneQuestions,...stuckQuestions};
 await service.evaluate({state:{task:'t',final_message:'m',attempts:[]},questions});
 assert.equal(JSON.parse(sent).questions.claims_done.instructions,doneQuestions.claims_done.instructions);
 assert.deepEqual(Object.keys(JSON.parse(sent).questions),Object.keys(questions));
 assert.ok(!sent.includes('[redacted]'));
});
test('selected upstream helpers remain compatible with the one pinned client',async()=>{
 const questions={claims_done:doneQuestions.claims_done,same_strategy:stuckQuestions.same_strategy};
 const client=createTypeSafe({apiKey:'synthetic-test-key',model:'jev-1.13.0',fetch:async()=>new Response(JSON.stringify({model:'jev-1.13.0',answers:{claims_done:{type:'noul',noul:0.9},same_strategy:{type:'noul',noul:0.1}},usage:{input_tokens:30,output_tokens:0}}),{status:200,headers:{'content-type':'application/json'}})});
 const result=await client.evaluate({state:{task:'synthetic',final_message:'done',attempts:[]},questions});
 assert.equal(result.answers.claims_done.noul,0.9);
 assert.ok(!redact('ghp_'+'a'.repeat(36)).includes('ghp_'));
});
