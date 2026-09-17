import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DefaultResourceLoader,SettingsManager} from '@earendil-works/pi-coding-agent';
test('Pi 0.85.1 real resource loader loads the integration without ambient extensions or network',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'jev-loader-'));
 try {
  const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager:SettingsManager.inMemory({packages:[]}),additionalExtensionPaths:[resolve('index.ts')],noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});
  await loader.reload();
  const result=loader.getExtensions();
  assert.deepEqual(result.errors,[]);assert.equal(result.extensions.length,1);
  assert.ok(result.extensions[0].commands.has('jev-assist'));
  assert.ok(result.extensions[0].handlers.has('agent_settled'));
 } finally {rmSync(dir,{recursive:true,force:true});}
});
