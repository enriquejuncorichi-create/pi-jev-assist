import test from 'node:test';
import assert from 'node:assert/strict';
import { createTypeSafe } from 'pi-typesafe';
import { createService } from '../src/service.js';
import { EvidenceLedger } from '../src/evidence.js';
import { reviewRequest } from '../src/decisions.js';

for (const [name, tool, args, output] of [
 ['JSON credential', 'read', {path:'settings.json'}, '{"apiKey":"Abc123ExampleOnly"}'],
 ['sensitive search glob', 'grep', {path:'/tmp/project',glob:'**/credentials.txt'}, 'Abc123ExampleOnly'],
 ['sensitive search result', 'grep', {path:'/tmp/project'}, 'credentials.txt:1: Abc123ExampleOnly'],
 ['sensitive search context', 'grep', {path:'/tmp/project'}, '.env.local-2-Abc123ExampleOnly'],
 ['JSON escaped value', 'read', {path:'settings.json'}, '{"password":"Abc123ExampleOnly\\\\nrest"}'],
] as const) {
 test(`${name} never reaches hosted request`,async()=>{
  const ledger=new EvidenceLedger();
  ledger.recordCall('a',tool,args);ledger.recordResult('a',tool,[{type:'text',text:output}],false,{});
  const request=reviewRequest('Inspect settings','Inspection finished.',ledger.snapshot()).request;
  let sent='';
  const service=createService({keyLoader:()=> 'synthetic',factory:options=>createTypeSafe({...options,fetch:async(_url,init)=>{
   sent=String(init?.body);return new Response('{}',{status:200});
  }})});
  await service.evaluate(request);
  assert.ok(sent.length>0,'exercise actual outbound serialisation');
  assert.ok(!sent.includes('Abc123ExampleOnly'),'synthetic secret leaked');
 });
}
