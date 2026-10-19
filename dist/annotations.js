import {examples} from './examples.js';
import {findTextIndex} from './engine.js';
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
function spanIndex(parent,text,occurrence=0){
 // Quote normalization preserves positions; whitespace normalization does not.
 const quotes=s=>s.replace(/[’‘]/g,"'").replace(/[“”]/g,'"');
 return findTextIndex(quotes(parent),quotes(text),occurrence);
}
export function renderAnnotatedSentence(sentence,analysis){
 if(!analysis||analysis.basic)return esc(sentence);
 if(analysis.fragments.map(f=>f.text).join('').length!==sentence.length)return esc(sentence);
 const ranges=[];let cursor=0;
 for(const f of analysis.fragments){const original=sentence.slice(cursor,cursor+f.text.length);const leading=original.match(/^\s*/)[0].length;const trailing=original.match(/[\s.,!?;:]+$/)?.[0].length||0;let start=cursor+leading,end=cursor+f.text.length-trailing;
  if(f.main!==false&&roleNames[f.role]&&end>start){if(f.id==='here'&&normalize(sentence).startsWith("Here's what's worked"))start+=4;ranges.push({start,end,type:'main',role:f.role,label:analysis.details[f.id]?.title||roleNames[f.role]})}cursor+=f.text.length;
 }
 const clauses=[];
 for(const c of findClauses(sentence,analysis)){
  const start=spanIndex(sentence,c.text,c.occurrence);
  if(start<0)continue;
  const parent={start,end:start+c.text.length,type:c.kind==='phrase'?'phrase':'clause',label:c.label,relation:c.relation,hasParts:!!c.parts?.length};clauses.push(parent);
  for(const p of c.parts||[]){const relative=spanIndex(c.text,p.text,p.occurrence);if(relative<0||!roleNames[p.role])continue;ranges.push({start:start+relative,end:start+relative+p.text.length,type:'sub',role:p.role,label:p.label,owner:parent})}
 }
 // CSS underlines propagate through descendants. Split spans at clause boundaries
 // so a matrix complement cannot paint a solid line through a nested clause.
 const filtered=ranges.flatMap(r=>{
  const boundaries=clauses.filter(c=>(c.type==='clause'||c.hasParts)&&c!==r.owner&&c.start<r.end&&c.end>r.start&&(!r.owner||(c.start>=r.owner.start&&c.end<=r.owner.end)));
  const points=[...new Set([r.start,r.end,...boundaries.flatMap(c=>[Math.max(r.start,c.start),Math.min(r.end,c.end)])])].sort((a,b)=>a-b);
  return points.slice(0,-1).flatMap((start,i)=>{const end=points[i+1];const covered=boundaries.some(c=>start>=c.start&&end<=c.end);if(r.type==='sub'&&covered)return [];return [{...r,start,end,insideClause:r.type==='main'&&covered}];});
 });
 filtered.push(...clauses);filtered.sort((a,b)=>a.start-b.start||b.end-a.end||(['clause','phrase'].includes(a.type)?-1:1));
 const root={start:0,end:sentence.length,children:[]},stack=[root];
 for(const r of filtered){while(stack.length>1&&r.start>=stack[stack.length-1].end)stack.pop();while(stack.length>1&&r.end>stack[stack.length-1].end)stack.pop();const parent=stack[stack.length-1];if(parent.children.some(c=>r.start<c.end&&r.end>c.end))continue;r.children=[];parent.children.push(r);stack.push(r)}
 function render(node){let position=node.start,result='';for(const c of node.children){result+=esc(sentence.slice(position,c.start))+render(c);position=c.end}result+=esc(sentence.slice(position,node.end));if(node===root)return result;if(node.type==='clause'||node.type==='phrase'){const description=esc(node.label+' · '+node.relation);return `<span class="clause-range ${node.type}" title="${description}"><span class="clause-tag" role="button" tabindex="0" aria-label="${description}" title="">${esc(node.label)}<span class="clause-relation"> · ${esc(node.relation)}</span></span>${result}</span>`;}return `<mark class="annotation ${esc(node.role)} ${node.type==='sub'?'sub-annotation':''} ${node.insideClause?'main-inside-clause':''}" title="${esc(node.label)}">${result}</mark>`}
 return render(root);
}

// Labels are absolutely positioned above the first rendered line of their
// clause. They never contribute width to the English paragraph's line breaking.
export function createAnnotationLayout(container){
 const tooltip=document.createElement('div');
 tooltip.id='clause-explanation';tooltip.className='clause-tooltip';tooltip.role='tooltip';tooltip.hidden=true;
 document.body.append(tooltip);
 let frame=0,active=null,hideTimer;
 function hide(){
  clearTimeout(hideTimer);tooltip.hidden=true;
  active?.removeAttribute('aria-describedby');active?.parentElement.classList.remove('clause-highlight');active=null;
 }
 function show(tag){
  if(!tag||tag.getClientRects().length===0)return;
  hide();active=tag;tag.parentElement.classList.add('clause-highlight');tag.setAttribute('aria-describedby',tooltip.id);
  tooltip.textContent=tag.getAttribute('aria-label');tooltip.hidden=false;
  const rect=tag.getBoundingClientRect(),box=tooltip.getBoundingClientRect(),margin=12;
  const left=Math.max(margin,Math.min(rect.left,document.documentElement.clientWidth-box.width-margin));
  const above=rect.top-box.height-8;
  tooltip.style.left=left+'px';tooltip.style.top=(above>=margin?above:rect.bottom+8)+'px';
 }
 function layout(){
  frame=0;hide();
  const root=container.getBoundingClientRect(),rows=[];
  if(!root.width)return;
  // Read all geometry before writing label positions to avoid repeated reflow.
  for(const tag of container.querySelectorAll('.clause-tag')){
   if(getComputedStyle(tag).display==='none')continue;
   const rect=[...tag.parentElement.getClientRects()].find(r=>r.width>0&&r.height>0);
   if(!rect)continue;
   let row=rows.at(-1);
   if(!row||Math.abs(row.top-rect.top)>3){row=rows.find(r=>Math.abs(r.top-rect.top)<=3);if(!row){row={top:rect.top,items:[]};rows.push(row);}}
   row.items.push({tag,x:Math.max(0,rect.left-root.left),end:Math.min(root.width,rect.right-root.left),height:tag.offsetHeight});
  }
  for(const row of rows){
   const items=row.items.sort((a,b)=>a.x-b.x||b.end-a.end),gap=5;
   // A small ellipsis remains available even when nested clauses start at the
   // same word. Move these neighboring anchors only enough to avoid overlap.
   const minimum=Math.min(16,root.width/items.length/2),spacing=minimum+Math.min(gap,minimum/2);
   let previous=-spacing;
   for(let i=0;i<items.length;i++){
    const item=items[i],latest=root.width-minimum-(items.length-i-1)*spacing;
    item.left=Math.min(Math.max(item.x,previous+spacing),latest);previous=item.left;
   }
   for(let i=0;i<items.length;i++){
    const item=items[i],next=items[i+1]?.left??root.width+gap;
    const width=Math.max(minimum,Math.min(next-gap,Math.max(item.end,item.left+minimum))-item.left);
    item.tag.style.left=item.left+'px';item.tag.style.top=(row.top-root.top-item.height-4)+'px';
    item.tag.style.maxWidth=width+'px';item.tag.classList.add('is-positioned');
   }
  }
 }
 function update(){cancelAnimationFrame(frame);frame=requestAnimationFrame(layout);}
 container.addEventListener('pointerover',event=>{const tag=event.target.closest('.clause-tag');if(tag&&tag!==active)show(tag);else if(tag)clearTimeout(hideTimer);});
 container.addEventListener('pointerout',event=>{if(active&&event.target.closest('.clause-tag')===active&&!active.contains(event.relatedTarget))hideTimer=setTimeout(hide,160);});
 container.addEventListener('focusin',event=>{if(event.target.matches('.clause-tag'))show(event.target);});
 container.addEventListener('focusout',event=>{if(event.target===active)hide();});
 container.addEventListener('click',event=>{const tag=event.target.closest('.clause-tag');if(tag)show(tag);});
 container.addEventListener('keydown',event=>{if(event.key==='Escape')hide();else if((event.key==='Enter'||event.key===' ')&&event.target.matches('.clause-tag')){event.preventDefault();show(event.target);}});
 tooltip.addEventListener('pointerenter',()=>clearTimeout(hideTimer));tooltip.addEventListener('pointerleave',hide);
 document.addEventListener('pointerdown',event=>{if(!tooltip.contains(event.target)&&!event.target.closest('.clause-tag'))hide();});
 window.addEventListener('scroll',hide,{passive:true});window.addEventListener('resize',update);
 window.addEventListener('beforeprint',layout);window.addEventListener('afterprint',update);
 const observer=new ResizeObserver(update);observer.observe(container);
 document.fonts?.ready.then(update);
 return {update};
}
