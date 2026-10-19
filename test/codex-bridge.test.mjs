import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {analyzeBatch,loginStatus} from '../codex-bridge.mjs';
import {validateImport} from '../dist/engine.js';

test('CLI receives explicit effort and exported annotations preserve the requested configuration',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'judu-cli-test-'));
  const binary=join(directory,'codex'),capture=join(directory,'invocation.json');
  const keys=['CODEX_CLI_PATH','JUDU_CODEX_MODEL','JUDU_CODEX_REASONING_EFFORT','JUDU_TEST_CAPTURE'];
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  t.after(async()=>{
    for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
    await rm(directory,{recursive:true,force:true});
  });
  // A local fixture captures real child-process arguments without contacting OpenAI.
  await writeFile(binary,`#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit(0);}
const input=JSON.parse(fs.readFileSync(0,'utf8'));
fs.writeFileSync(process.env.JUDU_TEST_CAPTURE,JSON.stringify({args,input}));
const analyses=input.sentences.map(({id})=>({id,main:[{text:'Birds',role:'subject'},{text:'fly',role:'predicate'}],clauses:[]}));
fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({analyses}));
`,{mode:0o755});
  process.env.CODEX_CLI_PATH=binary;process.env.JUDU_TEST_CAPTURE=capture;
  delete process.env.JUDU_CODEX_MODEL;
  for(const effort of ['high','xhigh']){
    if(effort==='high')delete process.env.JUDU_CODEX_REASONING_EFFORT;
    else process.env.JUDU_CODEX_REASONING_EFFORT=effort;
    const status=await loginStatus();
    assert.equal(status.requestConfig.reasoningEffort,effort);
    assert.equal(status.requestConfig.serviceTier,'fast');
    const result=await analyzeBatch(['Birds fly.']);
    const invocation=JSON.parse(await readFile(capture,'utf8'));
    const configValues=invocation.args.filter((_,i,args)=>args[i-1]==='-c');
    assert.ok(configValues.includes(`model_reasoning_effort="${effort}"`));
    assert.ok(configValues.includes('service_tier="fast"'));
    assert.ok(invocation.args.some((arg,i,args)=>arg==='--enable'&&args[i+1]==='fast_mode'));
    assert.equal(invocation.args[invocation.args.indexOf('--model')+1],'gpt-6.1-sol');
    assert.deepEqual(invocation.input,{sentences:[{id:0,text:'Birds fly.'}]});
    const exported=validateImport(JSON.stringify({version:1,analyses:result}));
    assert.equal(exported.analyses[0].generation.requestedReasoningEffort,effort);
    assert.equal(exported.analyses[0].generation.requestedModel,'gpt-6.1-sol');
    assert.equal(exported.analyses[0].generation.requestedServiceTier,'fast');
    assert.ok(Number.isFinite(Date.parse(exported.analyses[0].generation.requestedAt)));
  }
  process.env.JUDU_CODEX_REASONING_EFFORT='typo';
  await assert.rejects(analyzeBatch(['Birds fly.']),/JUDU_CODEX_REASONING_EFFORT/);
});
