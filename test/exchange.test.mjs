import test from 'node:test';
import assert from 'node:assert/strict';
import {readImport,mergeImport,makeExchangePrompt,exchangeExample} from '../dist/exchange.js';
import {validateImport,documentBlocks} from '../dist/engine.js';
import {renderAnnotatedSentence} from '../dist/annotations.js';

const second='Birds eat seeds.';
const secondAnalysis={sentence:second,main:[{text:'Birds',role:'subject'},{text:'eat',role:'predicate'},{text:'seeds',role:'object'}],clauses:[]};
const empty={text:'Previous article.',analyses:[],fontSize:22};
test('documented compact output and fenced GPT reply import without redundant fields',()=>{
 const result=readImport('```json\n'+JSON.stringify(exchangeExample)+'\n```');
 const state=mergeImport(empty,result);
 assert.equal(state.text,exchangeExample.documentText);assert.equal(state.analyses.length,1);
 assert.match(renderAnnotatedSentence(state.analyses[0].sentence,state.analyses[0]),/clause-range clause/);
 assert.match(renderAnnotatedSentence(state.analyses[0].sentence,state.analyses[0]),/sub-annotation/);
 validateImport({version:1,analyses:state.analyses});
});
test('later batches merge without erasing the first, and repeated imports replace in place',()=>{
 const batch=structuredClone(exchangeExample);batch.documentText+='\n\n'+second;
 const first=mergeImport(empty,readImport(batch));
 const next=readImport({version:2,analyses:[secondAnalysis]});
 const merged=mergeImport(first,next);assert.equal(merged.text,batch.documentText);assert.equal(merged.analyses.length,2);
 assert.equal(mergeImport(merged,next).analyses.length,2);
 assert.equal(mergeImport(merged,readImport({...batch,analyses:[secondAnalysis]})).analyses.length,2);
});
test('mismatched continuation fails without modifying an existing article',()=>{
 const state=mergeImport(empty,readImport(exchangeExample));const snapshot=structuredClone(state);
 assert.throws(()=>mergeImport(state,readImport({version:2,analyses:[secondAnalysis]})),/documentText/);
 assert.deepEqual(state,snapshot);
});
test('new document replaces old annotations, while v1 exports remain compatible',()=>{
 const first=mergeImport(empty,readImport(exchangeExample));
 const next=mergeImport(first,readImport({version:2,documentText:second,analyses:[secondAnalysis]}));
 assert.equal(next.analyses.length,1);assert.equal(next.text,second);
 const legacy=readImport({version:1,documentText:next.text,analyses:next.analyses});assert.deepEqual(mergeImport(empty,legacy).analyses,next.analyses);
});
test('malformed output, rewritten fragments, role names and crossings are rejected',()=>{
 assert.throws(()=>readImport('{"version":2'),/完整/);
 const rewritten=structuredClone(exchangeExample);rewritten.analyses[0].main[0].text='A report';assert.throws(()=>readImport(rewritten),/不一致/);
 const role=structuredClone(exchangeExample);role.analyses[0].main[0].role='verb';assert.throws(()=>readImport(role),/role/);
 const overlap=structuredClone(exchangeExample);overlap.analyses[0].main.push({text:'report',role:'subject'});assert.throws(()=>readImport(overlap),/重复/);
});
test('prompt is reusable without the sample article and can optionally include the current text',()=>{
 assert.match(makeExchangePrompt(),/第一批包含整篇 documentText/);assert.match(makeExchangePrompt(),/省略 documentText/);
 assert.ok(!makeExchangePrompt().includes('reactive loops'));
 const input='An arbitrary article with "quotes".';
 assert.ok(makeExchangePrompt(input).includes(JSON.stringify({readingText:input},null,2)));
});
test('long documents keep unannotated paragraphs while accepting small batches',()=>{
 const doc='Long reading\n\n'+Array.from({length:400},(_,i)=>`Sentence number ${i} contains enough original text for this long article.`).join('\n\n')+'\n\n'+second;
 assert.ok(doc.length>20000);
 const state=mergeImport(empty,readImport({version:2,documentText:doc,analyses:[secondAnalysis]}));
 assert.equal(state.text,doc);assert.equal(documentBlocks(doc).flatMap(b=>b.sentences).length,401);
});
