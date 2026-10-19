import {examples} from './examples.js';
const range=(text,label,relation,kind='clause',parts=[])=>({text,label,relation,kind,parts});
const part=(text,role,label)=>({text,role,label});
export const clauseAnnotations=[
 [],
 [
  range('to get stuck in reactive loops','不定式','真正的主语','phrase'),
  range('catching issues only in production, where fixing one failure creates others','分词补充','解释 reactive loops','phrase'),
  range('where fixing one failure creates others','关系从句','修饰 production','clause',[
   part('fixing one failure','subject','从句主语 · 动名词短语'),part('creates','predicate','从句谓语'),part('others','object','从句宾语')
  ])
 ],
 [range('before they affect users','时间状语从句','修饰 make … visible','clause',[
  part('they','subject','从句主语'),part('affect','predicate','从句谓语'),part('users','object','从句宾语')
 ])],
 [range('As we described in Building effective agents','as 补充从句','说明前文出处','clause',[
  part('we','subject','从句主语'),part('described','predicate','从句谓语')
 ]),range('calling tools, modifying state, and adapting based on intermediate results','并列分词补充','展开 operate','phrase')],
 [range('that make AI agents useful','定语从句','修饰 capabilities','clause',[
  part('that','subject','从句主语'),part('make','predicate','从句谓语'),part('AI agents','object','从句宾语'),part('useful','complement','从句宾语补足语')
 ]),range('autonomy, intelligence, and flexibility','同位补充','列举 capabilities','phrase')],
 [range('how to design more rigorous and useful evals for agents','疑问词 + 不定式','作 learned 的宾语','phrase')],
 [range("what's worked across a range of agent architectures and use cases in real-world deployment",'名词性从句','作 Here is 后的主语','clause',[
  part('what','subject','从句主语'),part("'s worked",'predicate','从句谓语 · has worked')
 ])]
];
export const normalize=s=>s.replace(/[’‘]/g,"'").replace(/[“”]/g,'"').replace(/\s+/g,' ').trim();
export function findClauses(sentence,analysis){
 if(Array.isArray(analysis?.clauses))return analysis.clauses;
 const i=examples.findIndex(e=>normalize(e.sentence)===normalize(sentence));
 return i>=0?clauseAnnotations[i]:[];
}
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const roleNames={subject:'主语',predicate:'谓语',object:'宾语',complement:'补语'};
export function renderAnnotatedSentence(sentence,analysis){
 if(!analysis||analysis.basic)return esc(sentence);
 if(analysis.fragments.map(f=>f.text).join('').length!==sentence.length)return esc(sentence);
 const ranges=[];let cursor=0;
 for(const f of analysis.fragments){const original=sentence.slice(cursor,cursor+f.text.length);const leading=original.match(/^\s*/)[0].length;const trailing=original.match(/[\s.,!?;:]+$/)?.[0].length||0;let start=cursor+leading,end=cursor+f.text.length-trailing;
  if(f.main!==false&&roleNames[f.role]&&end>start){if(f.id==='here'&&normalize(sentence).startsWith("Here's what's worked"))start+=4;ranges.push({start,end,type:'main',role:f.role,label:analysis.details[f.id]?.title||roleNames[f.role]})}cursor+=f.text.length;
 }
 const clauses=[];
 for(const c of findClauses(sentence,analysis)){
  const start=normalize(sentence).indexOf(normalize(c.text));
  // Whitespace changes cannot safely reuse character positions.
  if(start<0||normalize(sentence.slice(start,start+c.text.length))!==normalize(c.text))continue;
  const parent={start,end:start+c.text.length,type:c.kind==='phrase'?'phrase':'clause',label:c.label,relation:c.relation};clauses.push(parent);
  for(const p of c.parts||[]){const relative=normalize(c.text).indexOf(normalize(p.text));if(relative<0||!roleNames[p.role])continue;ranges.push({start:start+relative,end:start+relative+p.text.length,type:'sub',role:p.role,label:p.label})}
 }
 const filtered=ranges.map(r=>({...r,insideClause:r.type==='main'&&clauses.some(c=>c.type==='clause'&&r.start>=c.start&&r.end<=c.end)}));
 filtered.push(...clauses);filtered.sort((a,b)=>a.start-b.start||b.end-a.end||(['clause','phrase'].includes(a.type)?-1:1));
 const root={start:0,end:sentence.length,children:[]},stack=[root];
 for(const r of filtered){while(stack.length>1&&r.start>=stack[stack.length-1].end)stack.pop();while(stack.length>1&&r.end>stack[stack.length-1].end)stack.pop();const parent=stack[stack.length-1];if(parent.children.some(c=>r.start<c.end&&r.end>c.end))continue;r.children=[];parent.children.push(r);stack.push(r)}
 function render(node){let position=node.start,result='';for(const c of node.children){result+=esc(sentence.slice(position,c.start))+render(c);position=c.end}result+=esc(sentence.slice(position,node.end));if(node===root)return result;if(node.type==='clause'||node.type==='phrase')return `<span class="clause-range ${node.type}" title="${esc(node.label+' · '+node.relation)}"><span class="clause-tag">${esc(node.label)}<span class="clause-relation"> · ${esc(node.relation)}</span></span>${result}</span>`;return `<mark class="annotation ${esc(node.role)} ${node.type==='sub'?'sub-annotation':''} ${node.insideClause?'main-inside-clause':''}" title="${esc(node.label)}">${result}</mark>`}
 return render(root);
}
