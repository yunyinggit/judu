export const MAX_DOCUMENT_CHARS=100000;
export function findTextIndex(parent,text,occurrence=0){
 if(typeof text!=='string'||!text||!Number.isInteger(occurrence)||occurrence<0||occurrence>200)return -1;
 const word=c=>!!c&&/[\p{L}\p{N}_]/u.test(c);let cursor=0,count=0;
 while(cursor<=parent.length){const start=parent.indexOf(text,cursor);if(start<0)return -1;cursor=start+text.length;
  if((word(text[0])&&word(parent[start-1]))||(word(text.at(-1))&&word(parent[cursor])))continue;
  if(count++===occurrence)return start;
 }return -1;
}
export function splitSentences(input){
 const text=input.replace(/^#{1,6}\s+.*$/gm,'').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').trim();
 const paragraphs=text.split(/\n\s*\n/).map(p=>p.replace(/\s*\n\s*/g,' ').trim()).filter(Boolean);
 const segmenter=typeof Intl.Segmenter==='function'?new Intl.Segmenter('en',{granularity:'sentence'}):null;
 return paragraphs.flatMap(p=>{
  const parts=segmenter?[...segmenter.segment(p)].map(s=>s.segment.trim()):(p.match(/[^.!?]+[.!?]+(?:["”’']|$)|[^.!?]+$/g)||[p]).map(s=>s.trim());
  const merged=[];let pending='';
  for(const part of parts){const joined=pending?pending+' '+part:part;if(/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|e\.g|i\.e)\.$/i.test(joined)||/\b[A-Z]\.$/.test(joined)){pending=joined;continue}merged.push(joined);pending=''}
  if(pending)merged.push(pending);return merged;
 }).filter(Boolean);
}
export function documentBlocks(text){
 const paragraphs=text.split(/\n\s*\n/).map(p=>p.trim()).filter(Boolean);
 return paragraphs.map((paragraph,index)=>{
  const clean=paragraph.replace(/^#{1,6}\s+/,'').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1');
  const heading=/^#{1,6}\s/.test(paragraph)||(paragraphs.length>1&&index===0&&clean.length<80&&clean.split(/\s+/).length<=10&&!/[.!?。！？]/.test(clean)&&!clean.includes('\n'));
  const source=clean.replace(/\s*\n\s*/g,' ');
  return {text:source,heading:heading?(index===0?'h1':'h2'):null,sentences:heading?[]:splitSentences(source)};
 });
}
export function basicAnalysis(sentence){
 // Conservative boundary hints only. No part-of-speech or dependency claim is inferred.
 const pieces=[];const re=/—|\s--\s|;|:\s|,\s+(?=(?:where|which|who|whose|when|while|although|because|and|but|so|yet)\b)/gi;let start=0,match;
 while((match=re.exec(sentence))){if(match.index>start)pieces.push(sentence.slice(start,match.index));start=match.index;if(pieces.length>=12)break}
 if(start<sentence.length)pieces.push(sentence.slice(start));if(!pieces.length)pieces.push(sentence);
 const details={};const fragments=pieces.map((text,i)=>{const id=`segment${i}`;details[id]={title:i===0?'候选主句区域 · 待精读':'补充区域 · 待精读',text:text.trim(),explanation:i===0?'这里只按标点与连接词找到可能的主句区域，尚未判断主语、谓语与宾语。长主语、倒装、插入语和多层从句需要进一步精读。':'这里可能是从句、并列成分或补充说明。仅凭标点不能确定它修饰谁；请用 AI 精读确认关系。'};return {text,id,role:'unknown',main:i===0}});
 const nodes=fragments.map((f,i)=>({id:f.id,title:i===0?'候选主句区域':'待判断的后续成分',tokens:[{text:f.text.trim(),role:'unknown',label:'尚未标注语法成分',id:f.id}],children:[]}));
 const tree=nodes[0];tree.children=nodes.slice(1);tree.note='虚拟分层仅表示文本顺序，不表示已确认的语法依赖。';
 return {sentence,basic:true,fragments,translation:'',summary:'基础分层未确定语法成分；可导入精读结果。',defaultDetail:'segment0',details,tree,steps:fragments.map((f,i)=>({title:i===0?'先看候选主句区域':'再读后续部分',text:f.text.trim(),explanation:details[f.id].explanation,main:i===0}))};
}
const roles=new Set(['subject','predicate','object','complement','modifier','unknown']);
function str(value,field,max=8000){if(typeof value!=='string'||!value.trim()||value.length>max)throw Error(`${field}需要是有效文字（不超过 ${max} 字符）。`)}
function safeId(id){return typeof id==='string'&&/^[a-zA-Z0-9_-]{1,60}$/.test(id)&&!['__proto__','constructor','prototype'].includes(id)}
export function validateImport(raw){
 if(typeof raw==='string'){if(raw.length>1500000)throw Error('内容过大，请分批导入。');try{raw=JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''))}catch{throw Error('没有读到有效 JSON。请粘贴 AI 返回的完整结果，保留最外层的大括号。')}}
 if(!raw||raw.version!==1||!Array.isArray(raw.analyses)||raw.analyses.length<1||raw.analyses.length>MAX_DOCUMENT_CHARS)throw Error('没有读到有效的标注数组。请通过「复制 GPT 指令」获取格式。');
 let totalLength=0;
 raw.analyses.forEach((a,index)=>{
 const prefix=`第 ${index+1} 句：`;if(!a||typeof a!=='object')throw Error(prefix+'缺少分析内容。');str(a.sentence,prefix+'sentence',MAX_DOCUMENT_CHARS);totalLength+=a.sentence.length;
 if(a.basic!==undefined&&typeof a.basic!=='boolean')throw Error(prefix+'basic 需要是布尔值。');
 if(typeof a.translation!=='string'||a.translation.length>10000)throw Error(prefix+'缺少 translation 中文理解。');
 if(!a.details||typeof a.details!=='object'||Array.isArray(a.details)||Object.keys(a.details).length>200)throw Error(prefix+'缺少 details 解释。');
 for(const [id,detail] of Object.entries(a.details)){if(!safeId(id)||!detail)throw Error(prefix+'解释编号无效。');str(detail.title,prefix+'解释标题',300);str(detail.text,prefix+'解释片段',MAX_DOCUMENT_CHARS);str(detail.explanation,prefix+'解释正文');}
 function ref(id){if(!safeId(id)||!Object.hasOwn(a.details,id))throw Error(prefix+`找不到片段 ${String(id).slice(0,60)} 的解释。`)}
 if(!Array.isArray(a.fragments)||!a.fragments.length||a.fragments.length>200)throw Error(prefix+'缺少 fragments 原文片段。');
 a.fragments.forEach(f=>{if(!f)throw Error(prefix+'原文片段无效。');str(f.text,prefix+'原文片段',MAX_DOCUMENT_CHARS);if(!roles.has(f.role))throw Error(prefix+'片段 role 不在支持的类型中。');ref(f.id);if(f.main!==undefined&&typeof f.main!=='boolean')throw Error(prefix+'main 需要是布尔值。')});
 if(a.fragments.map(f=>f.text).join('')!==a.sentence)throw Error(prefix+'fragments 拼接后必须与 sentence 完全一致，包括空格和标点。');
 let nodes=0;
 function node(n,depth=0){if(depth>8||++nodes>100||!n)throw Error(prefix+'结构树层数或节点数量无效。');if(!safeId(n.id))throw Error(prefix+'结构树编号无效。');str(n.title,prefix+'结构标题',300);if(!Array.isArray(n.tokens)||!n.tokens.length||n.tokens.length>100)throw Error(prefix+'结构节点需要 tokens。');if(n.relation!==undefined)str(n.relation,prefix+'连接说明',500);if(n.note!==undefined)str(n.note,prefix+'节点说明',3000);n.tokens.forEach(t=>{if(!t)throw Error(prefix+'结构成分无效。');str(t.text,prefix+'结构成分',MAX_DOCUMENT_CHARS);str(t.label,prefix+'成分标签',300);if(!roles.has(t.role))throw Error(prefix+'结构成分 role 无效。');ref(t.id)});if(!Array.isArray(n.children)||n.children.length>30)throw Error(prefix+'结构节点需要 children 数组。');n.children.forEach(c=>node(c,depth+1))}
 node(a.tree);if(!Array.isArray(a.steps)||!a.steps.length||a.steps.length>100)throw Error(prefix+'缺少 steps 逐层解释。');a.steps.forEach(s=>{if(!s)throw Error(prefix+'阅读步骤无效。');str(s.title,prefix+'步骤标题',300);str(s.text,prefix+'步骤原文',MAX_DOCUMENT_CHARS);str(s.explanation,prefix+'步骤解释')});
 if(a.defaultDetail!==undefined)ref(a.defaultDetail);if(a.summary!==undefined&&typeof a.summary!=='string')throw Error(prefix+'summary 需要是文字。');
 if(a.clauses!==undefined){if(!Array.isArray(a.clauses)||a.clauses.length>50)throw Error(prefix+'clauses 需要是最多 50 项的数组。');a.clauses.forEach(c=>{if(!c)throw Error(prefix+'从句标注无效。');str(c.text,prefix+'从句原文',MAX_DOCUMENT_CHARS);str(c.label,prefix+'从句标签',100);str(c.relation,prefix+'从句归属',200);if(!['clause','phrase'].includes(c.kind))throw Error(prefix+'从句 kind 需要是 clause 或 phrase。');if(!a.sentence.includes(c.text))throw Error(prefix+'从句片段与原文不一致。');if(c.parts!==undefined){if(!Array.isArray(c.parts)||c.parts.length>100)throw Error(prefix+'从句 parts 无效。');c.parts.forEach(p=>{if(!p)throw Error(prefix+'从句成分无效。');str(p.text,prefix+'从句内部成分',MAX_DOCUMENT_CHARS);str(p.label,prefix+'从句成分名称',100);if(!roles.has(p.role)||!c.text.includes(p.text))throw Error(prefix+'从句内部成分与原文不一致。')})}})}
 });
 if(totalLength>MAX_DOCUMENT_CHARS)throw Error('原文总长超过 100,000 字符，请拆成不同文章。');
 return JSON.parse(JSON.stringify(raw));
}
