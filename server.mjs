import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {analyzeBatch,loginStatus} from './codex-bridge.mjs';
import {batches} from './ai-format.mjs';
import {MAX_DOCUMENT_CHARS} from './dist/engine.js';

const service='judu-local-codex';
const files=new Map([['/','index.html'],...['index.html','style.css','app.js','engine.js','annotations.js','examples.js','exchange.js'].map(f=>['/'+f,f])]);
const types={html:'text/html',css:'text/css',js:'text/javascript'};
export function createServer({analyze=analyzeBatch,status=loginStatus}={}){
  const token=randomBytes(32).toString('hex'),jobs=new Map();let active=null;
  const validJobId=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{16,80}$/.test(id);
  const emit=(job,event)=>{
    job.events.push(event);
    for(const res of job.subscribers)if(!res.destroyed)res.write(JSON.stringify(event)+'\n');
  };
  const runJob=async job=>{
    try{
      const connection=await status();if(!connection.ready)throw Error(connection.message);
      for(const batch of batches(job.sentences)){
        if(job.controller.signal.aborted)break;
        const analyses=await analyze(batch,{signal:job.controller.signal});
        job.completed+=analyses.length;
        emit(job,{type:'batch',analyses,completed:job.completed,total:job.sentences.length});
      }
      if(job.controller.signal.aborted)emit(job,{type:'cancelled',completed:job.completed});
      else emit(job,{type:'done',completed:job.completed});
    }catch(error){
      if(job.controller.signal.aborted)emit(job,{type:'cancelled',completed:job.completed});
      else emit(job,{type:'error',message:error.message});
    }finally{
      job.finished=true;if(active===job)active=null;
      for(const res of job.subscribers)res.end();
      job.subscribers.clear();
    }
  };
  const subscribe=(job,res,{legacy=false}={})=>{
    res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8'});
    // Replay every completed batch: the page may have disappeared before saving it.
    for(const event of job.events)res.write(JSON.stringify(event)+'\n');
    if(job.finished){res.end();return;}
    job.subscribers.add(res);
    const heartbeat=setInterval(()=>{if(!res.destroyed)res.write('{"type":"heartbeat"}\n');},15000);
    heartbeat.unref();
    res.on('close',()=>{
      clearInterval(heartbeat);job.subscribers.delete(res);
      // Old clients without a task ID keep their original cancellation behavior.
      // A resumable task belongs to the service, never to a browser connection.
      if(legacy&&!job.finished)job.controller.abort();
    });
  };
  const readPayload=async req=>{
    const chunks=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>MAX_DOCUMENT_CHARS*10)throw Error('文章最多支持 100,000 字符。');chunks.push(chunk);}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('没有读到有效的文章内容。');}
  };
  const server=http.createServer(async(req,res)=>{
    const port=req.socket.localPort;
    const origins=new Set([`http://127.0.0.1:${port}`,`http://localhost:${port}`]);
    const allowedHosts=new Set([`127.0.0.1:${port}`,`localhost:${port}`]);
    const send=(code,value)=>{if(res.destroyed)return;res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    const url=new URL(req.url,'http://127.0.0.1');
    const pageNavigation=req.method==='GET'&&files.has(url.pathname)&&req.headers['sec-fetch-mode']==='navigate'&&req.headers['sec-fetch-dest']==='document';
    if(!allowedHosts.has(req.headers.host)||(req.headers.origin&&!origins.has(req.headers.origin))||(!pageNavigation&&req.headers['sec-fetch-site']==='cross-site')){send(403,{error:'请从本机句读网页访问。'});return;}
    if(req.method==='GET'&&url.pathname==='/api/status'){send(200,{service,...await status(),busy:!!active,token});return;}
    if(req.method==='POST'&&['/api/analyze','/api/analyze/cancel'].includes(url.pathname)){
      const provided=Buffer.from(String(req.headers['x-judu-token']||''));
      if(provided.length!==token.length||!timingSafeEqual(provided,Buffer.from(token))){send(403,{error:'连接已更新，请刷新页面后重试。'});return;}
      if(!req.headers['content-type']?.startsWith('application/json')){send(415,{error:'请发送 JSON 格式的原文。'});return;}
      try{
        const payload=await readPayload(req);
        if(url.pathname==='/api/analyze/cancel'){
          if(!validJobId(payload?.jobId))throw Error('任务编号无效。');
          const job=jobs.get(payload.jobId);
          if(!job){send(404,{error:'上次任务已不在当前服务中，已保存的标注仍会保留。'});return;}
          if(!job.finished){job.controller.abort();await job.promise;}
          send(200,{completed:job.completed,cancelled:job.events.at(-1)?.type==='cancelled'});return;
        }
        const sentences=payload?.sentences;
        if(!Array.isArray(sentences)||!sentences.length||sentences.some(s=>typeof s!=='string'||!s.trim()))throw Error('请先粘贴有效的英文原文。');
        // Count original sentence characters, not separators added for transport.
        if(sentences.reduce((total,s)=>total+s.length,0)>MAX_DOCUMENT_CHARS)throw Error('文章最多支持 100,000 字符。');
        const legacy=payload.jobId===undefined;
        if(!legacy&&!validJobId(payload.jobId))throw Error('任务编号无效。');
        const jobId=legacy?randomUUID():payload.jobId;
        const existing=jobs.get(jobId);
        if(existing){
          if(existing.sentences.length!==sentences.length||existing.sentences.some((s,i)=>s!==sentences[i])){send(409,{error:'任务编号与原文不一致，请重新开始。'});return;}
          subscribe(existing,res);return;
        }
        // A reconnect must never silently create another paid request.
        if(payload.resume===true){send(410,{error:'上次任务已不在当前服务中。已保存的标注会保留，点击「AI 标注」继续剩余句子。'});return;}
        if(active){send(409,{error:'另一个页面正在标注，请等它完成。'});return;}
        // Bound retained result memory; active jobs are never evicted.
        for(const [id,job] of jobs){if(jobs.size<5)break;if(job.finished)jobs.delete(id);}
        const job={id:jobId,sentences,controller:new AbortController(),completed:0,finished:false,events:[],subscribers:new Set()};
        jobs.set(jobId,job);active=job;
        emit(job,{type:'start',jobId,total:sentences.length});
        subscribe(job,res,{legacy});
        job.promise=runJob(job);
      }catch(e){
        if(!res.destroyed){if(res.headersSent){res.end(JSON.stringify({type:'error',message:e.message})+'\n');}else send(400,{error:e.message});}
      }
      return;
    }
    if(req.method==='GET'&&files.has(url.pathname)){
      const file=files.get(url.pathname);
      try{const data=await readFile(new URL('./dist/'+file,import.meta.url));res.writeHead(200,{'Content-Type':types[file.split('.').at(-1)]+'; charset=utf-8'});res.end(data);}catch{send(500,{error:'页面文件无法读取。'});}return;
    }
    send(404,{error:'没有这个页面。'});
  });
  server.on('close',()=>active?.controller.abort());
  server.cancel=()=>active?.controller.abort();
  return server;
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  const url='http://127.0.0.1:4173/';const open=()=>{if(process.argv.includes('--open'))spawn('/usr/bin/open',[url],{stdio:'ignore'});};
  const server=createServer();
  server.on('error',async error=>{
    if(error.code==='EADDRINUSE'){
      try{const response=await fetch(url+'api/status',{signal:AbortSignal.timeout(12000)});const data=await response.json();if(data.service===service){console.log('句读已经启动：'+url);open();return;}}catch{}
      console.error('4173 端口正在被其他程序使用。请关闭旧的预览服务后重新启动句读。');
    }else console.error('启动失败：'+error.message);
    process.exitCode=1;
  });
  server.listen(4173,'127.0.0.1',()=>{console.log('句读已启动：'+url+'\n使用本机 Codex 订阅。保留此窗口即可继续使用；按 Control+C 关闭。');open();});
  for(const event of ['SIGINT','SIGTERM'])process.on(event,()=>{server.cancel();server.close();server.closeAllConnections();});
}
