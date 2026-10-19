import {examples} from './examples.js';
import {renderAnnotatedSentence,clauseAnnotations,createAnnotationLayout} from './annotations.js';
import {documentBlocks,validateImport,MAX_DOCUMENT_CHARS} from './engine.js';
import {readImport,mergeImport,makeExchangePrompt} from './exchange.js';
const $=id=>document.getElementById(id);
const annotationLayout=createAnnotationLayout($('document-content'));
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const defaultText='Introduction\n\n'+examples.slice(0,3).map(a=>a.sentence).join(' ')+'\n\n'+examples.slice(3,5).map(a=>a.sentence).join(' ')+'\n\n'+examples.slice(5).map(a=>a.sentence).join(' ');
const key='sentence-document:v2';
let state={text:defaultText,analyses:structuredClone(examples),fontSize:22,showAnnotations:true,showClauses:true},toastTimer;
let historyDatabase=null,historySaveQueue=Promise.resolve(),saveRevision=0,historyListRevision=0,switchingDocument=false;
let historyMutation=false,lastDeletedHistory=null;
const normalize=s=>s.replace(/[’‘]/g,"'").replace(/[“”]/g,'"').replace(/\s+/g,' ').trim();
const labels={subject:'主语',predicate:'谓语',object:'宾语',complement:'表语 / 补语'};
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,3200)}
function openHistoryDatabase(){
 if(historyDatabase)return historyDatabase;
 const opening=new Promise((resolve,reject)=>{
  if(!window.indexedDB){reject(Error('当前浏览器不支持历史记录存储。'));return;}
  const request=indexedDB.open('judu-reading-history',1);
  request.onupgradeneeded=()=>{
   const db=request.result;
   if(!db.objectStoreNames.contains('documents'))db.createObjectStore('documents',{keyPath:'id'});
   if(!db.objectStoreNames.contains('entries'))db.createObjectStore('entries',{keyPath:'id'});
  };
  request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();historyDatabase=null;};resolve(db);};
  request.onerror=()=>reject(request.error||Error('无法打开历史记录。'));
  request.onblocked=()=>reject(Error('历史记录正在更新，请关闭其他句读页面后重试。'));
 });
 historyDatabase=opening.catch(error=>{historyDatabase=null;throw error;});return historyDatabase;
}
async function readHistory(store,id){
 const db=await openHistoryDatabase();
 return new Promise((resolve,reject)=>{
  const transaction=db.transaction(store,'readonly'),objectStore=transaction.objectStore(store);
  const request=id===undefined?objectStore.getAll():objectStore.get(id);
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(request.error||Error('无法读取历史记录。'));
 });
}
async function writeHistory(snapshot){
 const blocks=documentBlocks(snapshot.text),sentences=blocks.flatMap(b=>b.sentences);
 const matching=new Set(sentences.map(normalize));
 snapshot.analyses=snapshot.analyses.filter(a=>matching.has(normalize(a.sentence)));
 const annotated=new Set(snapshot.analyses.filter(a=>!a.basic).map(a=>normalize(a.sentence)));
 const title=(blocks[0]?.text||'未命名文章').replace(/\s+/g,' ').slice(0,90);
 const entry={id:snapshot.documentId,title,preview:(blocks.find(b=>!b.heading)?.text||'').slice(0,160),characters:snapshot.text.length,total:sentences.length,completed:sentences.filter(s=>annotated.has(normalize(s))).length,updatedAt:Date.now(),createdAt:snapshot.documentCreatedAt};
 const db=await openHistoryDatabase();
 return new Promise((resolve,reject)=>{
  // Store metadata and the full article atomically; lists need not load all annotations.
  const transaction=db.transaction(['documents','entries'],'readwrite');
  let stored=false;
  transaction.oncomplete=()=>resolve(stored);
  transaction.onabort=()=>reject(transaction.error||Error('历史记录未能保存。'));
  transaction.onerror=()=>reject(transaction.error||Error('历史记录未能保存。'));
  const entries=transaction.objectStore('entries'),existing=entries.get(snapshot.documentId);
  existing.onsuccess=()=>{
   // A stale autosave (including another tab) must not recreate a deleted record.
   if(existing.result?.deletedAt)return;
   transaction.objectStore('documents').put({id:snapshot.documentId,state:snapshot});
   entries.put(entry);stored=true;
  };
 });
}
function queueHistoryMutation(action){
 const operation=historySaveQueue.then(action);
 historySaveQueue=operation.then(()=>true,()=>false);
 return operation;
}
async function removeHistoryRecord(id){
 const db=await openHistoryDatabase();
 return new Promise((resolve,reject)=>{
  const transaction=db.transaction(['documents','entries'],'readwrite');
  const documents=transaction.objectStore('documents'),entries=transaction.objectStore('entries');
  const documentRequest=documents.get(id),entryRequest=entries.get(id);let backup=null;
  entryRequest.onsuccess=()=>{
   const entry=entryRequest.result;if(!entry||entry.deletedAt)return;
   backup={document:documentRequest.result,entry};
   documents.delete(id);
   // Keep only a small tombstone, not the article or its annotations.
   entries.put({id,deletedAt:Date.now()});
  };
  transaction.oncomplete=()=>resolve(backup);
  transaction.onabort=()=>reject(transaction.error||Error('历史记录未能删除。'));
  transaction.onerror=()=>reject(transaction.error||Error('历史记录未能删除。'));
 });
}
async function restoreHistoryRecord(backup){
 const db=await openHistoryDatabase();
 return new Promise((resolve,reject)=>{
  const transaction=db.transaction(['documents','entries'],'readwrite');
  if(backup.document)transaction.objectStore('documents').put(backup.document);
  transaction.objectStore('entries').put(backup.entry);
  transaction.oncomplete=()=>resolve();
  transaction.onabort=()=>reject(transaction.error||Error('暂时无法撤销删除。'));
  transaction.onerror=()=>reject(transaction.error||Error('暂时无法撤销删除。'));
 });
}
function save(){
 if(typeof state.documentId!=='string'||!state.documentId)state.documentId=crypto.randomUUID();
 if(!Number.isFinite(state.documentCreatedAt))state.documentCreatedAt=Date.now();
 const revision=++saveRevision;let currentSaved=false;
 try{localStorage.setItem(key,JSON.stringify(state));currentSaved=true;}catch{}
 if(!state.text.trim()){
  $('save-status').textContent=currentSaved?'等待粘贴文章':'当前浏览器无法保存';
  return Promise.resolve(currentSaved);
 }
 $('save-status').textContent='正在保存…';
 const snapshot=structuredClone(state);
 historySaveQueue=historySaveQueue.then(()=>writeHistory(snapshot)).then(stored=>{
  if(revision===saveRevision)$('save-status').textContent=stored?'已保存到历史记录':'这篇文章已从历史记录删除';
  if($('history-dialog').open)renderHistory();
  return true;
 },()=>{
  if(revision===saveRevision)$('save-status').textContent=currentSaved?'当前文章已保存 · 历史保存失败':'保存失败，请先导出文章';
  return false;
 });
 return historySaveQueue;
}
function newArticle(text,analyses){
 const sentences=new Set(documentBlocks(text).flatMap(b=>b.sentences).map(normalize));
 return {...state,text,analyses:analyses.filter(a=>sentences.has(normalize(a.sentence))),analysisJob:null,documentId:crypto.randomUUID(),documentCreatedAt:Date.now()};
}
async function replaceDocument(next){
 if(switchingDocument||historyMutation)return false;
 if(analysisController||state.analysisJob)throw Error('请先等待当前分析完成，或点击「取消」，再切换文章。');
 switchingDocument=true;
 try{
  if(!await save())throw Error('当前文章还未存入历史记录。请先导出保存，或恢复浏览器存储后重试。');
  state=next;render();await save();return true;
 }finally{switchingDocument=false;}
}
async function renderHistory(){
 const revision=++historyListRevision;
 $('history-error').hidden=true;
 try{
  const entries=(await readHistory('entries')).filter(entry=>!entry.deletedAt);if(revision!==historyListRevision)return;
  const query=$('history-search').value.trim().toLocaleLowerCase();
  const filtered=entries.filter(e=>(e.title+' '+e.preview).toLocaleLowerCase().includes(query)).sort((a,b)=>b.updatedAt-a.updatedAt);
  const analyzing=!!analysisController||!!state.analysisJob,busy=analyzing||historyMutation;
  $('history-count').textContent=query?`${filtered.length} / ${entries.length} 篇文章`:`${entries.length} 篇文章 · 最近保存的在前`;
  $('history-busy').hidden=!analyzing;
  $('history-undo').hidden=!lastDeletedHistory;
  $('history-undo-button').disabled=historyMutation;
  const date=new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
  $('history-list').innerHTML=filtered.map(entry=>`<div class="history-item" role="listitem"><button class="history-open" data-history-id="${esc(entry.id)}" ${entry.id===state.documentId?'aria-current="true"':''} ${busy?'disabled':''}><span class="history-title">${esc(entry.title)}${entry.id===state.documentId?'<span class="history-current">当前文章</span>':''}</span><span class="history-preview">${esc(entry.preview)}</span><span class="history-meta">${esc(date.format(entry.updatedAt))} · ${entry.completed} / ${entry.total} 句已标注 · ${entry.characters.toLocaleString()} 字符</span></button><button class="history-delete" data-history-delete="${esc(entry.id)}" aria-label="删除文章：${esc(entry.title)}" ${busy?'disabled':''}>删除</button></div>`).join('')||`<p class="history-empty">${query?'没有找到匹配的文章。':'还没有历史记录。粘贴文章后会自动保存。'}</p>`;
 }catch(error){$('history-error').textContent=error.message||'无法读取历史记录。';$('history-error').hidden=false;}
}
function annotation(text,role,label){const spaces=text.match(/^(\s*)([\s\S]*?)(\s*)$/);return esc(spaces[1])+`<mark class="annotation ${role}" title="${esc(label)}" aria-label="${esc(label+'：'+spaces[2])}">${esc(spaces[2])}</mark>`+esc(spaces[3])}
function renderSentence(sentence,analyses){const a=analyses.get(normalize(sentence));return {html:renderAnnotatedSentence(sentence,a),annotated:!!a}}
function render(){
 let total=0,annotated=0;
 const analyses=new Map(state.analyses.filter(a=>!a.basic).map(a=>[normalize(a.sentence),a]));
 const html=documentBlocks(state.text).map(({text:source,heading,sentences})=>{
  if(heading)return `<${heading}>${esc(source)}</${heading}>`;
  let cursor=0,body='';
  for(const sentence of sentences){const at=source.indexOf(sentence,cursor);if(at<0){body+=esc(source.slice(cursor));cursor=source.length;break;}body+=esc(source.slice(cursor,at));const result=renderSentence(sentence,analyses);body+=result.html;cursor=at+sentence.length;total++;if(result.annotated)annotated++;}
  body+=esc(source.slice(cursor));return `<p>${body}</p>`;
 }).join('');
 $('document-content').innerHTML=html||'<p class="empty-document">粘贴一段英文，开始阅读。</p>';
 $('annotation-status').textContent=total?`${annotated} / ${total} 句已分析`:'等待原文';
 $('reading-hint').textContent=total&&annotated<total?'点击「AI 标注」自动分析，主句和从句会直接标在原文上。':'实线标主句主干，虚线标从句内部成分。上方小字说明结构；悬停或点击可查看完整解释。';
 document.documentElement.style.setProperty('--font-size',state.fontSize+'px');$('font-size').textContent=state.fontSize;$('smaller-button').disabled=state.fontSize<=16;$('larger-button').disabled=state.fontSize>=30;
 $('annotations-toggle').checked=state.showAnnotations;document.body.classList.toggle('no-annotations',!state.showAnnotations);$('clauses-toggle').checked=state.showClauses!==false;document.body.classList.toggle('no-clauses',state.showClauses===false);
 annotationLayout.update();
}
function showDialog(id){$(id).showModal()}
$('history-button').addEventListener('click',async()=>{
 $('history-search').value='';$('history-list').innerHTML='<p class="history-empty">正在读取历史记录…</p>';
 showDialog('history-dialog');await save();await renderHistory();
});
$('history-search').addEventListener('input',renderHistory);
$('history-list').addEventListener('click',async event=>{
 const button=event.target.closest('button[data-history-delete]');
 if(!button||button.disabled||historyMutation||switchingDocument||analysisController||state.analysisJob)return;
 historyMutation=true;let failure;
 try{
  button.disabled=true;
  const backup=await queueHistoryMutation(()=>removeHistoryRecord(button.dataset.historyDelete));
  if(!backup)throw Error('这条历史记录已经被删除。');
  lastDeletedHistory=backup;
  if(backup.entry.id===state.documentId){
   state=newArticle('',[]);backup.emptyDocumentId=state.documentId;
   render();await save();$('ai-error').hidden=true;
   $('ai-status').textContent='当前文章已删除，可以粘贴新的文章。';
  }
  $('history-undo-message').textContent='已删除「'+backup.entry.title+'」';
 }catch(error){failure=error;}
 finally{
  historyMutation=false;await renderHistory();
  if(failure){$('history-error').textContent=failure.message;$('history-error').hidden=false;}
 }
});
$('history-undo-button').addEventListener('click',async()=>{
 if(!lastDeletedHistory||historyMutation)return;
 const backup=lastDeletedHistory;historyMutation=true;let failure;
 try{
  $('history-undo-button').disabled=true;
  await queueHistoryMutation(()=>restoreHistoryRecord(backup));
  if(backup.emptyDocumentId===state.documentId&&!state.text.trim()&&backup.document){
   state=structuredClone(backup.document.state);render();await save();
   $('ai-status').textContent=aiConnection?.message||'已恢复文章和标注。';
  }
  lastDeletedHistory=null;toast('已撤销删除');
 }catch(error){failure=error;}
 finally{
  historyMutation=false;await renderHistory();
  if(failure){$('history-error').textContent=failure.message;$('history-error').hidden=false;}
 }
});
$('history-list').addEventListener('click',async event=>{
 const button=event.target.closest('button[data-history-id]');if(!button||button.disabled||historyMutation)return;
 if(button.dataset.historyId===state.documentId){$('history-dialog').close();return;}
 try{
  const record=await readHistory('documents',button.dataset.historyId),saved=record?.state;
  if(!saved||typeof saved.text!=='string'||saved.text.length>MAX_DOCUMENT_CHARS||!Array.isArray(saved.analyses))throw Error('这篇文章的保存记录不完整，可从导出文件恢复。');
  if(saved.analyses.length)validateImport({version:1,analyses:saved.analyses});
  const restored={...saved,documentId:record.id,fontSize:Math.max(16,Math.min(30,Number(saved.fontSize)||22)),showAnnotations:saved.showAnnotations!==false,showClauses:saved.showClauses!==false};
  if(!await replaceDocument(restored))return;
  $('history-dialog').close();$('ai-error').hidden=true;toast('已恢复文章和标注');
  await connectAI();if(aiConnection&&state.analysisJob)analyzeDocument();
 }catch(error){$('history-error').textContent=error.message;$('history-error').hidden=false;}
});
function counter(){$('character-count').textContent=$('source-input').value.length.toLocaleString()+' / 100,000 字符'}
$('edit-button').addEventListener('click',()=>{$('source-input').value=state.text;$('edit-error').hidden=true;counter();showDialog('edit-dialog')});
$('source-input').addEventListener('input',counter);
async function applySource(){
 const text=$('source-input').value.trim();
 if($('source-input').value.length>MAX_DOCUMENT_CHARS){$('edit-error').textContent='文章最多支持 100,000 字符。';$('edit-error').hidden=false;return false;}
 if(!text){$('edit-error').textContent='请先粘贴英文原文。';$('edit-error').hidden=false;return false;}
 try{
  if(text!==state.text){if(!await replaceDocument(newArticle(text,state.analyses)))return false;}
  else{render();await save();}
  $('edit-dialog').close();return true;
 }catch(error){$('edit-error').textContent=error.message;$('edit-error').hidden=false;return false;}
}
$('apply-button').addEventListener('click',async()=>{if(await applySource())toast('已按原文段落排版');});
$('apply-analyze-button').addEventListener('click',async()=>{if(await applySource())analyzeDocument();});
$('source-input').addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();$('apply-analyze-button').click();}});
$('clauses-toggle').addEventListener('change',e=>{state.showClauses=e.target.checked;render();save()});
$('annotations-toggle').addEventListener('change',e=>{state.showAnnotations=e.target.checked;render();save()});
$('smaller-button').addEventListener('click',()=>{state.fontSize=Math.max(16,state.fontSize-2);render();save()});
$('larger-button').addEventListener('click',()=>{state.fontSize=Math.min(30,state.fontSize+2);render();save()});
$('example-button').addEventListener('click',async()=>{
 try{
  if(state.text===defaultText){state.analyses=structuredClone(examples);render();await save();}
  else if(!await replaceDocument(newArticle(defaultText,structuredClone(examples))))return;
  toast('已载入你的示例文章');
 }catch(error){toast(error.message);}
});
$('import-button').addEventListener('click',()=>showDialog('import-dialog'));
$('print-button').addEventListener('click',()=>window.print());
$('export-button').addEventListener('click',()=>{const data={version:1,documentText:state.text,analyses:state.analyses.map(a=>{const i=examples.findIndex(e=>normalize(e.sentence)===normalize(a.sentence));return {...a,clauses:a.clauses||(i>=0?clauseAnnotations[i]:[])}})};const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json;charset=utf-8'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='句读-文章与主干标注.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('已导出文章与标注，可在「导入标注」恢复')});
$('confirm-import').addEventListener('click',async()=>{
 try{
  const imported=readImport($('import-input').value);
  const merged=mergeImport(state,imported);
  if(merged.text!==state.text){if(!await replaceDocument(newArticle(merged.text,merged.analyses)))return;}
  else{state=merged;state.analysisJob=null;render();await save();}
  $('import-dialog').close();$('import-input').value='';$('import-error').hidden=true;
  toast('已导入 '+imported.analyses.length+' 句标注，可继续粘贴后续批次');
 }catch(error){$('import-error').textContent=error.message;$('import-error').hidden=false;}
});
$('import-file').addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;try{if(file.size>1500000)throw Error('文件超过 1.5 MB，请分批导入。');$('import-input').value=await file.text();$('import-error').hidden=true}catch(error){$('import-error').textContent=error.message;$('import-error').hidden=false}e.target.value=''});
function updatePrompt(){
 $('gpt-prompt').value=makeExchangePrompt($('include-article').checked?state.text:'');
 $('prompt-copy-status').textContent='复制后与英文长文一起发给 GPT。';
}
async function copyPrompt(){
 try{await navigator.clipboard.writeText($('gpt-prompt').value);$('prompt-copy-status').textContent='已复制，可以粘贴到 GPT 里。';toast('GPT 指令已复制');}
 catch{$('gpt-prompt').focus();$('gpt-prompt').select();$('prompt-copy-status').textContent='已选中全部指令，请按 ⌘C（或 Ctrl+C）复制。';}
}
$('prompt-button').addEventListener('click',()=>{$('include-article').checked=false;updatePrompt();showDialog('prompt-dialog');copyPrompt();});
$('include-article').addEventListener('change',updatePrompt);
$('copy-prompt').addEventListener('click',copyPrompt);
for(const button of document.querySelectorAll('[data-close]'))button.addEventListener('click',()=>button.closest('dialog').close());
for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close()}});
try{const previous=JSON.parse(localStorage.getItem(key));if(previous&&typeof previous.text==='string'&&previous.text.length<=MAX_DOCUMENT_CHARS&&Array.isArray(previous.analyses)){if(previous.analyses.length)validateImport({version:1,analyses:previous.analyses});state={...previous,fontSize:Math.max(16,Math.min(30,Number(previous.fontSize)||22)),showAnnotations:previous.showAnnotations!==false,showClauses:previous.showClauses!==false}}}catch{}
// Save the ID and original request before sending it. Even a refresh before the
// first result can then reattach without starting another Codex invocation.
if(state.analysisJob){
 const job=state.analysisJob;
 if(!/^[a-zA-Z0-9_-]{16,80}$/.test(job.id)||job.documentText!==state.text||!Array.isArray(job.sentences)||!job.sentences.length||job.sentences.some(s=>typeof s!=='string'||!s.trim())||job.sentences.reduce((n,s)=>n+s.length,0)>MAX_DOCUMENT_CHARS)state.analysisJob=null;
}
render();

let aiConnection=null,analysisController=null;
async function connectAI(){
 if(location.protocol==='file:'){
  $('ai-status').textContent='自动标注请双击「启动句读.command」，打开本地网页版。';
  $('analyze-button').disabled=true;$('apply-analyze-button').disabled=true;return;
 }
 $('analyze-button').disabled=true;$('apply-analyze-button').disabled=true;
 try{
  const response=await fetch('/api/status',{signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error();
  const connection=await response.json();if(connection.service!=='judu-local-codex')throw Error();
  aiConnection=connection.ready?connection:null;
  $('ai-status').textContent=connection.message;
 }catch{
  aiConnection=null;$('ai-status').textContent='本地 AI 服务未连接。请双击「启动句读.command」。';
 }
 $('analyze-button').textContent=aiConnection?'AI 标注':'重新连接';$('analyze-button').disabled=false;$('apply-analyze-button').disabled=!aiConnection;
}
function analysisBusy(busy){
 for(const id of ['edit-button','apply-button','apply-analyze-button','example-button','import-button','confirm-import'])$(id).disabled=busy||!!state.analysisJob;
 $('analyze-button').disabled=busy;
 $('analyze-button').textContent=state.analysisJob&&!busy?'重新连接':'AI 标注';
 $('cancel-analysis').hidden=!busy&&!state.analysisJob;$('document-content').setAttribute('aria-busy',String(busy));
 if($('history-dialog').open)renderHistory();
}
async function analyzeDocument(){
 if(analysisController||switchingDocument||historyMutation)return;
 if(!aiConnection){await connectAI();if(!aiConnection)return;}
 const sentences=[...new Set(documentBlocks(state.text).flatMap(p=>p.sentences))];
 const analyzed=new Set(state.analyses.filter(a=>!a.basic).map(a=>a.sentence));
 const pending=state.analysisJob?.sentences||sentences.filter(sentence=>!analyzed.has(sentence));
 if(!pending.length){toast('这篇文章已经标注完成。粘贴新文章后可继续标注。');return;}
 if(state.text.length>MAX_DOCUMENT_CHARS){$('ai-error').textContent='文章最多支持 100,000 字符。';$('ai-error').hidden=false;return;}
 const sentenceSet=new Set(sentences),pendingSet=new Set(pending);
 if(pending.some(sentence=>!sentenceSet.has(sentence))){state.analysisJob=null;save();$('ai-error').textContent='上次任务与当前文章不同，请点击「AI 标注」重新开始。';$('ai-error').hidden=false;return;}
 let resume=!!state.analysisJob;
 const job=state.analysisJob||{id:crypto.randomUUID(),documentText:state.text,sentences:pending,completed:0};
 state.analysisJob=job;save();
 const controller=new AbortController();analysisController=controller;analysisBusy(true);$('ai-error').hidden=true;
 let completed=Number(job.completed)||0,terminal=false;
 $('ai-status').textContent=resume?`正在接回上次分析 ${completed} / ${pending.length} 句…`:`正在分析 0 / ${pending.length} 句… 刷新页面后会自动接回进度。`;
 try{
  const receive=line=>{
   if(!line.trim())return;
   const event=JSON.parse(line);
   if(event.type==='error'){terminal=true;state.analysisJob=null;save();throw Error(event.message);}
   if(event.type==='start'){
    $('ai-status').textContent=`正在分析 ${completed} / ${pending.length} 句… 刷新页面后会自动接回进度。`;return;
   }
   if(event.type==='done'||event.type==='cancelled'){
    terminal=true;state.analysisJob=null;save();
    $('ai-status').textContent=event.type==='done'?`已完成 ${event.completed} 句 · 使用 Codex 订阅`:`已取消 · 本次完成 ${event.completed} 句，再次点击可继续。`;
    if(event.type==='done')toast('标注完成，已保存在当前浏览器');
    return;
   }
   if(event.type!=='batch')return;
   const {analyses}=validateImport({version:1,analyses:event.analyses});
   if(analyses.some(a=>!pendingSet.has(a.sentence)))throw Error('收到的标注与当前原文不符，已停止。');
   const merged=new Map(state.analyses.filter(a=>sentenceSet.has(a.sentence)).map(a=>[a.sentence,a]));
   for(const a of analyses)merged.set(a.sentence,a);
   state.analyses=[...merged.values()];completed=Math.max(completed,event.completed);job.completed=completed;render();save();
   $('ai-status').textContent=`正在分析 ${completed} / ${pending.length} 句… 已完成的标注已保存。`;
  };
  for(let attempt=0;!terminal;attempt++){
   try{
    const response=await fetch('/api/analyze',{method:'POST',headers:{'Content-Type':'application/json','X-Judu-Token':aiConnection.token},body:JSON.stringify({jobId:job.id,sentences:pending,resume}),signal:controller.signal});
    if(!response.ok){
     const error=await response.json().catch(()=>({}));
     if(response.status===403&&attempt<3){await connectAI();analysisBusy(true);if(aiConnection)continue;}
     if(response.status>=400&&response.status<500){terminal=true;state.analysisJob=null;save();}
     throw Error(error.error||'暂时无法连接分析任务。');
    }
    resume=true;
    if(!response.body)throw Error('当前浏览器不支持读取分析进度，请更新浏览器。');
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
    try{
     while(true){const chunk=await reader.read();buffer+=decoder.decode(chunk.value||new Uint8Array(),{stream:!chunk.done});let at;while((at=buffer.indexOf('\n'))>=0){receive(buffer.slice(0,at));buffer=buffer.slice(at+1);}if(chunk.done)break;}
     if(buffer.trim())receive(buffer);
    }finally{await reader.cancel().catch(()=>{});}
    if(!terminal)throw Error('分析连接中断。');
   }catch(error){
    if(terminal||controller.signal.aborted||attempt>=3)throw error;
    // Unknown outcome after a lost POST: resume-only prevents duplicate work.
    resume=true;
    $('ai-status').textContent=`连接暂时中断，正在接回同一任务… 已完成 ${completed} / ${pending.length} 句。`;
    await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));
   }
  }
 }catch(error){
  if(!controller.signal.aborted){$('ai-status').textContent=state.analysisJob?'连接暂时中断 · 可以重新连接原任务':'本次分析未完成';$('ai-error').textContent=error.message||'连接中断，请重试。';$('ai-error').hidden=false;}
 }finally{controller.abort();analysisController=null;analysisBusy(false);}
}
$('analyze-button').addEventListener('click',analyzeDocument);
$('cancel-analysis').addEventListener('click',async()=>{
 const job=state.analysisJob;if(!job)return;
 $('cancel-analysis').disabled=true;
 try{
  const response=await fetch('/api/analyze/cancel',{method:'POST',headers:{'Content-Type':'application/json','X-Judu-Token':aiConnection?.token},body:JSON.stringify({jobId:job.id}),signal:AbortSignal.timeout(15000)});
  const result=await response.json();
  if(!response.ok&&response.status!==404)throw Error(result.error||'未能确认取消，请重试。');
  analysisController?.abort();state.analysisJob=null;save();
  $('ai-status').textContent=result.cancelled===false?`任务已结束 · 已完成 ${result.completed} 句。`:`已取消 · 已完成的 ${result.completed??job.completed??0} 句标注会保留。`;
  analysisBusy(false);
 }catch(error){$('ai-error').textContent=error.message;$('ai-error').hidden=false;}
 finally{$('cancel-analysis').disabled=false;}
});
// Reload/close only disconnects this viewer; only the cancel endpoint stops AI.
// Migrate the already-saved current article into history on first load.
save();
connectAI().then(()=>{if(aiConnection&&state.analysisJob)analyzeDocument();});
