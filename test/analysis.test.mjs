import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {convertResult,locate,batches,MAX_BATCH_SENTENCES,MAX_BATCH_CHARS} from '../ai-format.mjs';
import {renderAnnotatedSentence} from '../dist/annotations.js';
import {examples} from '../dist/examples.js';
import {validateImport,MAX_DOCUMENT_CHARS} from '../dist/engine.js';
import {createServer} from '../server.mjs';
import {randomUUID} from 'node:crypto';

const span=(text,role,label,occurrence=0)=>({text,role,label,occurrence});
const fixture={analyses:[{id:0,translation:'我明白你为何离开。',summary:'主句宾语由 why 从句承担。',main:[span('I','subject','主语'),span('understand','predicate','谓语'),span('why you left','object','宾语从句')],clauses:[{text:'why you left',occurrence:0,label:'宾语从句',relation:'作 understand 的宾语',kind:'clause',parts:[span('you','subject','从句主语'),span('left','predicate','从句谓语')]}]}]};
const sentence='I understand why you left.';
test('AI results preserve the source and nest a clause inside a matrix argument',()=>{
 const [a]=convertResult(fixture,[sentence]);assert.equal(a.fragments.map(f=>f.text).join(''),sentence);
 const html=renderAnnotatedSentence(sentence,a);assert.match(html,/clause-range clause/);assert.match(html,/sub-annotation/);assert.match(html,/作 understand 的宾语/);
});
test('AI spans locate repeated text and reject invented or overlapping spans',()=>{
 assert.equal(locate('we know that we know',{text:'we',occurrence:1}).start,13);
 assert.equal(locate('You recommended it to me.',{text:'me',occurrence:0}).start,22);
 assert.throws(()=>locate('curly ’',{text:"'",occurrence:0}),/不一致/);
 const bad=structuredClone(fixture);bad.analyses[0].main[0].text='understand why';assert.throws(()=>convertResult(bad,[sentence]),/重复/);
 const invented=structuredClone(fixture);invented.analyses[0].clauses[0].parts[0].text='they';assert.throws(()=>convertResult(invented,[sentence]),/不一致/);
});
test('matrix underlines split around nested clauses',()=>{
 const [a]=convertResult(fixture,[sentence]);
 const html=renderAnnotatedSentence(sentence,a);
 assert.match(html,/annotation object\s+main-inside-clause/);
 assert.ok(!/<mark class="annotation object  ">[^]*clause-range/.test(html));
});
test('compact output keeps gerunds, purpose adjuncts and nested clause relations while supplying ordinary labels',()=>{
 const sentences=['Reading books helps me understand how clauses work.','She reads articles to improve her English.'];
 const part=(text,role,label=null)=>({text,role,label,occurrence:0});
 const raw={analyses:[{
  id:0,
  main:[part('Reading books','subject','主语·动名词短语'),part('helps','predicate'),part('me','object'),part('understand how clauses work','complement','宾语补足语')],
  clauses:[
   {text:'Reading books',kind:'phrase',label:'动名词短语',relation:'作 helps 的主语',parts:[part('Reading','predicate'),part('books','object')]},
   {text:'understand how clauses work',kind:'phrase',label:'省略 to 的不定式',relation:'作 helps 的宾语补足语',parts:[part('understand','predicate'),part('how clauses work','object')]},
   {text:'how clauses work',kind:'clause',label:'宾语从句',relation:'作 understand 的宾语',parts:[part('clauses','subject'),part('work','predicate')]}
  ]
 },{
  id:1,
  main:[part('She','subject'),part('reads','predicate'),part('articles','object')],
  clauses:[{text:'to improve her English',kind:'phrase',label:'不定式·目的状语',relation:'修饰 reads，说明阅读目的',parts:[part('improve','predicate'),part('her English','object')]}]
 }]};
 const results=convertResult(raw,sentences);
 const restored=validateImport(JSON.stringify({version:1,analyses:results})).analyses;
 for(const [i,result] of restored.entries()){
  assert.equal(result.fragments.map(f=>f.text).join(''),sentences[i]);
  assert.deepEqual(result.clauses.map(c=>[c.text,c.label,c.relation]),raw.analyses[i].clauses.map(c=>[c.text,c.label,c.relation]));
 }
 const gerund=renderAnnotatedSentence(sentences[0],restored[0]);
 for(const label of ['动名词短语','作 helps 的主语','宾语补足语','宾语从句','作 understand 的宾语','从句主语'])assert.ok(gerund.includes(label),label);
 const purpose=renderAnnotatedSentence(sentences[1],restored[1]);
 for(const label of ['不定式·目的状语','修饰 reads，说明阅读目的','title="主语"','title="谓语"','title="宾语"','title="短语谓语"'])assert.ok(purpose.includes(label),label);
 assert.ok(!purpose.includes('title="null"'));
});
test('rendered annotations preserve examples and escape HTML',()=>{
 const clean=html=>html.replace(/<span class="clause-tag"[^>]*>.*?<\/span><\/span>/g,'').replace(/<[^>]*>/g,'').replaceAll('&#39;',"'").replaceAll('&quot;','"').replaceAll('&gt;','>').replaceAll('&lt;','<').replaceAll('&amp;','&');
 for(const a of examples)assert.equal(clean(renderAnnotatedSentence(a.sentence,a)),a.sentence);
 assert.equal(renderAnnotatedSentence('<img src=x onerror=alert(1)>',null),'&lt;img src=x onerror=alert(1)&gt;');
 const a=convertResult(fixture,[sentence])[0];a.clauses[0].label='<script>alert(1)</script>';assert.ok(!renderAnnotatedSentence(sentence,a).includes('<script>'));
});
test('short articles stay together and 69 ordinary sentences form three balanced batches',()=>{
 const items=Array.from({length:69},(_,i)=>`Sentence ${i}: researchers examine how agents respond when the environment changes.`);
 assert.deepEqual(batches([]),[]);
 for(const count of [1,20,30])assert.deepEqual(batches(items.slice(0,count)),[items.slice(0,count)]);
 const result=batches(items);
 assert.deepEqual(result.map(batch=>batch.length),[23,23,23]);
 assert.deepEqual(result.flat(),items);
 // Just over the count boundary should not leave a single-sentence request.
 assert.deepEqual(batches(items.slice(0,31)).map(batch=>batch.length).sort((a,b)=>a-b),[15,16]);
});
test('long sentences reduce batch sizes while exact boundaries and oversized sentences preserve all text',()=>{
 const half=MAX_BATCH_CHARS/2;
 assert.equal(batches(['a'.repeat(half),'b'.repeat(half)]).length,1);
 assert.equal(batches(['a'.repeat(half+1),'b'.repeat(half)]).length,2);
 const long=Array.from({length:30},(_,i)=>`${i}: `+'word '.repeat(100));
 const divided=batches(long);
 assert.equal(divided.length,2);
 assert.ok(divided.every(batch=>batch.length<20&&batch.join('').length<=MAX_BATCH_CHARS));
 const oversized='x'.repeat(MAX_BATCH_CHARS+1);
 const items=['Before.',...long.slice(0,10),oversized,...long.slice(10),'After.'];
 const result=batches(items);
 assert.deepEqual(result.flat(),items);
 assert.deepEqual(result.find(batch=>batch.includes(oversized)),[oversized]);
 assert.ok(result.every(batch=>batch.length<=MAX_BATCH_SENTENCES&&(batch.length===1||batch.join('').length<=MAX_BATCH_CHARS)));
});
async function serving(t,options={}){
 const server=createServer({status:async()=>({ready:true,message:'ready'}),...options});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{server.cancel();server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 const url='http://127.0.0.1:'+server.address().port;const status=await (await fetch(url+'/api/status')).json();
 return {url,headers:{'Content-Type':'application/json','X-Judu-Token':status.token,Origin:url}};
}
test('service rejects foreign sites, forged hosts, missing token and oversized input',async t=>{
 let calls=0;const {url,headers}=await serving(t,{analyze:async()=>{calls++;return [];}});const payload=JSON.stringify({sentences:[sentence]});
 assert.equal((await fetch(url+'/api/status',{headers:{Origin:'https://example.com'}})).status,403);
 const navigationHeaders={'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'};
 const navigate=path=>new Promise((resolve,reject)=>http.get(url+path,{headers:navigationHeaders},res=>{res.resume();resolve(res.statusCode);}).on('error',reject));
 assert.equal(await navigate('/'),200);
 assert.equal(await navigate('/api/status'),403);
 const forgedStatus=await new Promise((resolve,reject)=>http.get(url+'/api/status',{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject));assert.equal(forgedStatus,403);
 assert.equal((await fetch(url+'/api/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:payload})).status,403);
 assert.equal((await fetch(url+'/api/analyze',{method:'POST',headers,body:JSON.stringify({sentences:['a'.repeat(MAX_DOCUMENT_CHARS+1)]})})).status,400);
 assert.equal((await fetch(url+'/api/analyze',{method:'POST',headers,body:JSON.stringify({sentences:['a'.repeat(50000),'b'.repeat(50001)]})})).status,400);
 assert.equal((await fetch(url+'/.git/config')).status,404);assert.equal(calls,0);
});
test('a 100,000-character article with over 1,000 sentences streams in order and can be restored',async t=>{
 const sentences=Array.from({length:1001},(_,i)=>`Example ${i} — ${'é'.repeat(75)}.`);
 sentences[sentences.length-1]+=' '.repeat(MAX_DOCUMENT_CHARS-sentences.reduce((n,s)=>n+s.length,0)-1)+'!';
 assert.equal(sentences.reduce((n,s)=>n+s.length,0),MAX_DOCUMENT_CHARS);
 const calls=[];
 const {url,headers}=await serving(t,{analyze:async batch=>{
  calls.push(batch);
  return convertResult({analyses:batch.map((_,id)=>({id,main:[],clauses:[]}))},batch);
 }});
 const body=JSON.stringify({sentences});
 assert.ok(Buffer.byteLength(body)>100000);
 const response=await fetch(url+'/api/analyze',{method:'POST',headers,body});
 assert.equal(response.status,200);
 const events=(await response.text()).trim().split('\n').map(JSON.parse);
 assert.deepEqual(calls.flat(),sentences);
 assert.ok(calls.every(batch=>batch.length<=MAX_BATCH_SENTENCES&&(batch.length===1||batch.join('').length<=MAX_BATCH_CHARS)));
 assert.equal(events[0].total,sentences.length);
 assert.deepEqual(events.at(-1),{type:'done',completed:sentences.length});
 const analyses=events.filter(e=>e.type==='batch').flatMap(e=>e.analyses);
 assert.deepEqual(analyses.map(a=>a.sentence),sentences);
 assert.equal(validateImport({version:1,analyses}).analyses.length,sentences.length);
});
test('a single long sentence no longer hits an unrelated 20,000-character limit',()=>{
 const sentence='A '+ 'long '.repeat(5000)+'sentence.';
 const [analysis]=convertResult({analyses:[{id:0,main:[],clauses:[]}]},[sentence]);
 assert.equal(analysis.sentence,sentence);
});
test('service streams successful batches before a later failure',async t=>{
 let calls=0;const {url,headers}=await serving(t,{analyze:async sentences=>{calls++;if(calls===2)throw Error('second batch failed');return sentences.map(sentence=>({sentence}));}});
 const sentences=Array.from({length:69},(_,i)=>`Sentence ${String(i).padStart(2,'0')}.`);
 const response=await fetch(url+'/api/analyze',{method:'POST',headers,body:JSON.stringify({sentences})});
 const events=(await response.text()).trim().split('\n').map(line=>JSON.parse(line));assert.equal(events[1].type,'batch');assert.equal(events[1].completed,23);assert.equal(events.at(-1).type,'error');
 assert.deepEqual(events[1].analyses.map(a=>a.sentence),sentences.slice(0,23));
});
test('cancelling aborts analysis and releases the busy lock',async t=>{
 let started,aborted;const start=new Promise(resolve=>started=resolve),abort=new Promise(resolve=>aborted=resolve);
 const {url,headers}=await serving(t,{analyze:async(_,{signal})=>{started();await new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted();reject(Error('cancelled'));},{once:true}));}});
 const controller=new AbortController();const response=await fetch(url+'/api/analyze',{method:'POST',headers,body:JSON.stringify({sentences:[sentence]}),signal:controller.signal});await start;
 assert.equal((await fetch(url+'/api/analyze',{method:'POST',headers,body:JSON.stringify({sentences:[sentence]})})).status,409);
 controller.abort();await abort;await response.body.cancel().catch(()=>{});assert.equal((await (await fetch(url+'/api/status')).json()).busy,false);
});
test('refresh reconnects to the same job and replays batches produced while no page was connected',async t=>{
 const sentences=Array.from({length:45},(_,i)=>`Sentence ${String(i).padStart(2,'0')}.`),jobId=randomUUID();
 let releaseFirst,releaseSecond,startedFirst,startedSecond,calls=0;
 const firstGate=new Promise(resolve=>releaseFirst=resolve),secondGate=new Promise(resolve=>releaseSecond=resolve);
 const firstStarted=new Promise(resolve=>startedFirst=resolve),secondStarted=new Promise(resolve=>startedSecond=resolve);
 const {url,headers}=await serving(t,{analyze:async(batch,{signal})=>{
  calls++;
  if(calls===1){startedFirst();await firstGate;}else{startedSecond();await secondGate;}
  assert.equal(signal.aborted,false,'disconnect must not cancel the Codex job');
  return batch.map(sentence=>({sentence}));
 }});
 const post=(body,signal)=>fetch(url+'/api/analyze',{method:'POST',headers,body:JSON.stringify(body),signal});
 const firstController=new AbortController();
 const first=await post({jobId,sentences},firstController.signal);await firstStarted;
 firstController.abort();await first.body.cancel().catch(()=>{});
 assert.equal((await (await fetch(url+'/api/status')).json()).busy,true);
 const secondController=new AbortController();
 const second=await post({jobId,sentences,resume:true},secondController.signal);
 assert.equal(second.status,200);assert.equal(calls,1);
 assert.equal((await post({jobId:randomUUID(),sentences})).status,409);
 assert.equal((await post({jobId,sentences:['Different article.'],resume:true})).status,409);
 secondController.abort();await second.body.cancel().catch(()=>{});
 releaseFirst();await secondStarted;releaseSecond();
 const recovered=await post({jobId,sentences,resume:true});
 const events=(await recovered.text()).trim().split('\n').map(JSON.parse);
 assert.deepEqual(events.filter(e=>e.type==='batch').flatMap(e=>e.analyses.map(a=>a.sentence)),sentences);
 assert.deepEqual(events.at(-1),{type:'done',completed:45});assert.equal(calls,2);
 // Retrying a completed creation also replays; no additional quota is used.
 assert.equal((await (await post({jobId,sentences})).text()),events.map(e=>JSON.stringify(e)).join('\n')+'\n');
 assert.equal(calls,2);
 assert.equal((await post({jobId:randomUUID(),sentences,resume:true})).status,410);
 assert.equal(calls,2,'unknown resume IDs must never start new AI work');
});
test('an explicit authenticated cancel stops a disconnected resumable job',async t=>{
 let started,aborted;const start=new Promise(resolve=>started=resolve),abort=new Promise(resolve=>aborted=resolve);
 let calls=0;
 const {url,headers}=await serving(t,{analyze:async(_,{signal})=>{
  calls++;started();await new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted();reject(Error('cancelled'));},{once:true}));
 }});
 const jobId=randomUUID(),body=JSON.stringify({jobId,sentences:[sentence]});
 const controller=new AbortController();
 const first=await fetch(url+'/api/analyze',{method:'POST',headers,body,signal:controller.signal});await start;
 controller.abort();await first.body.cancel().catch(()=>{});
 assert.equal((await fetch(url+'/api/analyze/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobId})})).status,403);
 const cancelled=await fetch(url+'/api/analyze/cancel',{method:'POST',headers,body:JSON.stringify({jobId})});
 assert.equal(cancelled.status,200);await abort;
 assert.equal((await (await fetch(url+'/api/status')).json()).busy,false);
 const replay=await fetch(url+'/api/analyze',{method:'POST',headers,body});
 const events=(await replay.text()).trim().split('\n').map(JSON.parse);
 assert.deepEqual(events.at(-1),{type:'cancelled',completed:0});assert.equal(calls,1);
});
