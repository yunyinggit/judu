import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {outputSchema,instructions,convertResult} from './ai-format.mjs';

// CODEX_AUTH_FLOW：本项目的 Codex 登录与订阅调用入口，完整操作流程见 README。
// 使用者先在自己的终端执行 `codex login`；登录凭据由官方 CLI 保存和使用。
// 调用链：dist/app.js connectAI -> server.mjs /api/status -> loginStatus；
//         server.mjs /api/analyze -> analyzeBatch -> codex exec。
// 本项目不实现 OAuth，不读取或复制 auth.json，也不向网页提供 Codex 令牌。
// 定位登录问题：检查以下 executable()/environment() 选定的 CLI 和登录环境。
async function executable(){
  for(const path of [process.env.CODEX_CLI_PATH,'/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex','/opt/homebrew/bin/codex','/usr/local/bin/codex'].filter(Boolean)){try{await access(path);return path;}catch{}}
  return 'codex';
}
// CODEX_AUTH_FLOW：保留系统用户环境和 CODEX_HOME，让 CLI 找到使用者已有登录。
// 移除 OPENAI_API_KEY、CODEX_API_KEY 及桌面会话变量，避免继承另一条调用上下文。
// CODEX_CLI_PATH 在 executable() 中读取，无需传给子进程；不创建项目内登录副本。
function environment(){const env={...process.env};delete env.OPENAI_API_KEY;for(const key of Object.keys(env))if(key.startsWith('CODEX_')&&key!=='CODEX_HOME')delete env[key];return env;}
// CODEX_REQUEST_CONFIG：每次调用明确传入模型、思考强度和 Fast，不依赖 CLI 默认值。
// 这些值是本程序请求的配置，不是对服务端实际推理过程的测量。
function requestConfig(){
  const model=process.env.JUDU_CODEX_MODEL?.trim()||'gpt-6.1-sol';
  const reasoningEffort=process.env.JUDU_CODEX_REASONING_EFFORT?.trim()||'high';
  if(!['low','medium','high','xhigh','max'].includes(reasoningEffort))throw Error('JUDU_CODEX_REASONING_EFFORT 需要是 low、medium、high、xhigh 或 max；具体支持范围取决于模型。');
  return {model,reasoningEffort,serviceTier:'fast'};
}
function run(binary,args,{input='',signal,timeout=240000}={}){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(Error('已取消标注。'));return;}
    const child=spawn(binary,args,{stdio:['pipe','pipe','pipe'],env:environment(),shell:false});
    let output='',errors='',failure,killTimer;
    const stop=message=>{failure=Error(message);child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),1500);killTimer.unref();};
    const abort=()=>stop('已取消标注。');signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>stop('这批分析超时了。已完成的标注会保留，请重试剩余句子。'),timeout);
    child.stdout.on('data',chunk=>{output=(output+chunk).slice(-2000000);});
    child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-16000);});
    const cleanup=()=>{clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);};
    child.on('error',()=>{cleanup();reject(Error('没有找到本机 Codex。请先安装并登录 Codex。'));});
    child.on('close',code=>{cleanup();if(failure){reject(failure);return;}resolve({code,output,errors});});
    child.stdin.on('error',()=>{});child.stdin.end(input);
  });
}
// CODEX_AUTH_FLOW：只检查已保存的登录方式；不会打开登录页面或读取凭据。
// ready=true 不保证账号仍有额度或可以使用指定模型，实际调用也可能失败。
export async function loginStatus(){
  try{
    const config=requestConfig();
    const r=await run(await executable(),['login','status'],{timeout:10000});
    const ready=r.code===0&&/logged in using chatgpt/i.test(r.output+r.errors);
    return {ready,requestConfig:config,message:ready?'已连接 Codex 订阅 · 分析需要联网':'请先在本机 Codex 中使用 ChatGPT 账号登录。'};
  }catch(e){return {ready:false,message:e.message};}
}
function failureMessage(result){
  const diagnostic=result.output+result.errors;
  if(/model.*not supported|unknown model|model_not_found/i.test(diagnostic))return '本机 Codex 版本或账号不支持当前模型，请更新 Codex 并检查订阅可用模型。';
  if(/usage.limit|rate.limit|quota|limit reached/i.test(diagnostic))return 'Codex 使用额度暂时不足，请等待额度恢复后重试。';
  if(/not.logged.in|unauthorized|authentication|401|refresh.token/i.test(diagnostic))return 'Codex 登录已失效，请重新用 ChatGPT 账号登录 Codex。';
  if(/network|connect|timed.out|stream.disconnected/i.test(diagnostic))return '无法连接 Codex，请检查网络后重试。';
  return 'Codex 未完成这批标注。已完成的结果会保留，请稍后重试。';
}
// CODEX_AUTH_FLOW：codex exec 自行复用本机登录，使用该账号的 Codex 访问权限。
// --ignore-user-config 隔离个人配置，但不隔离 CLI 认证存储；--ephemeral 不持久化会话。
// forced_login_method="chatgpt" 要求订阅登录，不自动切换到 API Key 付费方式。
// 临时目录只存放输出约束和标注结果，不能用来保存或复制登录凭据。
export async function analyzeBatch(sentences,{signal}={}){
  const {model,reasoningEffort,serviceTier}=requestConfig();
  const directory=await mkdtemp(join(tmpdir(),'judu-'));
  try{
    const schema=join(directory,'schema.json'),output=join(directory,'result.json');
    await writeFile(schema,JSON.stringify(outputSchema),{mode:0o600});
    const args=['exec','--model',model,'--ignore-user-config','--ephemeral','--skip-git-repo-check','--sandbox','read-only',
      '-c','model_reasoning_effort='+JSON.stringify(reasoningEffort),
      '--enable','fast_mode','-c','service_tier='+JSON.stringify(serviceTier),
      '--disable','shell_tool','--disable','apps','--disable','multi_agent',
      '--disable','plugins','--disable','hooks','--disable','browser_use','--disable','computer_use','--disable','image_generation',
      '-c','web_search="disabled"','-c','approval_policy="never"','-c','project_doc_max_bytes=0',
      '-c','forced_login_method="chatgpt"','-c','developer_instructions='+JSON.stringify(instructions),
      '--cd',directory,'--output-schema',schema,'--output-last-message',output,'--json','-'];
    // CODEX_REQUEST_CONFIG：随每句保存请求配置，浏览器保存和 JSON 导出会保留 generation。
    // 旧结果没有此字段，不能据此推断它们当时用了 low 或任何其他强度。
    const generation={provider:'codex',requestedModel:model,requestedReasoningEffort:reasoningEffort,requestedServiceTier:serviceTier,requestedAt:new Date().toISOString()};
    console.info(`[句读] Codex 请求：model=${model}, reasoning_effort=${reasoningEffort}, service_tier=${serviceTier}`);
    const result=await run(await executable(),args,{input:JSON.stringify({sentences:sentences.map((text,id)=>({id,text}))}),signal});
    if(result.code!==0)throw Error(failureMessage(result),{cause:result});
    let raw;try{raw=JSON.parse(await readFile(output,'utf8'));}catch{throw Error('AI 返回的标注格式不完整，请重试。');}
    try{return convertResult(raw,sentences).map(a=>({...a,generation:{...generation}}));}catch(error){throw Error(error.message,{cause:{raw}});}
  }finally{await rm(directory,{recursive:true,force:true});}
}
