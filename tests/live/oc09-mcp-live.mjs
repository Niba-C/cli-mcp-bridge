/** 显式真实验收：只使用指定的两个模型、独立 daemon/MCP/工作副本。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {ipcCall} from '../../src/daemon/ipc.ts';
import {resolveDaemonPaths} from '../../src/daemon/layout.ts';

if(process.env.ZB_OC09_LIVE!=='1'){console.error('真实测试需 ZB_OC09_LIVE=1');process.exit(3)}
const args=process.argv.slice(2), backend=args.includes('--backend')?args[args.indexOf('--backend')+1]:'codebuddy';
assert.ok(['codebuddy','qoder'].includes(backend));
const flag=name=>{const i=args.indexOf('--'+name);return i<0?null:args[i+1]};
const model=flag('model'), executable=flag('executable');
assert.ok(model&&!model.startsWith('--'),'必须用 --model 指定本人账号可用的原生模型 ID');
assert.ok(executable&&executable.startsWith('/')&&fs.existsSync(executable),'必须用 --executable 指定已安装官方 CLI 的绝对路径');
const repo=fileURLToPath(new URL('../../',import.meta.url));
const label=new Date().toISOString().replaceAll(/[:.]/g,'-')+'-'+backend;
const evidence=resolve(repo,'.local/live',label);fs.mkdirSync(evidence,{recursive:true,mode:0o700});
const source=join(evidence,'source');fs.mkdirSync(source);
const marker='MCP_LIVE_'+randomBytes(6).toString('hex');
fs.writeFileSync(join(source,'README.md'),marker+'\n中文🙂只读验收，禁止写文件或执行命令。\n');
for(let i=1;i<=24;i++)fs.writeFileSync(join(source,`note-${String(i).padStart(2,'0')}.txt`),`条目 ${i}：校验值 ${randomBytes(5).toString('hex')}。\n`);
const hashes=()=>Object.fromEntries(fs.readdirSync(source).sort().map(name=>[name,createHash('sha256').update(fs.readFileSync(join(source,name))).digest('hex')]));
const baseline=hashes();
const root=fs.mkdtempSync(join(tmpdir(),'oc09-real-mcp-')),data=join(root,'data'),config=join(root,'config.json'),paths=resolveDaemonPaths(data);
fs.writeFileSync(config,JSON.stringify({schemaVersion:3,mode:'personal',defaultBackend:backend,backends:{[backend]:{adapter:backend+'-sdk',enabled:true,pinnedVersion:backend==='codebuddy'?'2.173.0':'1.1.78',executable,auth:{mode:'cli-login'},models:{default:model,allowed:[model]}}},workspaces:[{id:'live',name:'live',root:source,profiles:['review']}],limits:{activeRuns:1,runTimeoutMs:120000,approvalTimeoutMs:30000},transport:{stdio:true,http:{enabled:false,bind:'127.0.0.1'}}}),{mode:0o600});
const report={backend,model,evidence,startedAt:new Date().toISOString(),checks:[],runs:[],approvalDecisions:[],tools:[],error:null};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const redact=s=>String(s).replace(/Bearer\s+\S+/gi,'Bearer [REDACTED]').replace(/eyJ[A-Za-z0-9_.-]+/g,'[REDACTED_JWT]');
const trace=(kind,value)=>fs.appendFileSync(join(evidence,'mcp-trace.jsonl'),redact(JSON.stringify({at:new Date().toISOString(),kind,...value}))+'\n',{mode:0o600});
const check=(name,details={})=>{report.checks.push({name,pass:true,...details});console.log(JSON.stringify({backend,check:name,...details}))};
let daemon,client,transport,stderr='',approveTimer,approving=false,epoch,workspaceId;
async function boot(){daemon=spawn(process.execPath,[join(repo,'bin/ocbridge.mjs'),'daemon','serve','--config',config,'--data-dir',data],{cwd:root,stdio:['ignore','pipe','pipe']});daemon.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-20000)});daemon.stdout.on('data',chunk=>{stderr=(stderr+chunk).slice(-20000)});for(let i=0;i<200;i++){if(daemon.exitCode!==null)throw Error('daemon exited: '+redact(stderr));try{await ipcCall(paths.operatorSocket,'ping',{});return}catch{}await delay(100)}throw Error('daemon startup timeout: '+redact(stderr))}
async function connect(){transport=new StdioClientTransport({command:process.execPath,args:[join(repo,'bin/ocbridge.mjs'),'mcp','serve','--data-dir',data],stderr:'pipe'});client=new Client({name:'oc09-real-live',version:'1'},{capabilities:{}});await client.connect(transport)}
async function call(name,params={},allowError=false){const raw=await client.callTool({name,arguments:params});trace('tool',{name,params,response:raw});if(!allowError)assert.notEqual(raw.isError,true,JSON.stringify(raw.structuredContent));return raw.structuredContent??raw}
async function ready(){await connect();const tools=await client.listTools();report.tools=tools.tools.map(t=>t.name);assert.equal(report.tools.length,12);check('12 tools discovered');const caps=await call('agent_capabilities');epoch=caps.serviceEpoch;assert.equal(caps.contractVersion,'2');assert.equal(caps.defaultBackend,backend);const list=await call('workspace_list');workspaceId=list.workspaces[0].workspaceId;check('capabilities/workspace', {serviceEpoch:epoch});}
async function approve(){if(approving)return;approving=true;try{const list=await ipcCall(paths.operatorSocket,'approval.list',{});for(const row of list.approvals){if(row.state!=='pending')continue;const safe=['Read','Glob','Grep','LS'].includes(row.toolName)&&!row.targetPaths.some(p=>p.startsWith('/')&&!p.startsWith(data+'/workspaces/'));const decision=safe?'allow_once':'deny';await ipcCall(paths.operatorSocket,'approval.decide',{approvalId:row.approvalId,decision,payloadHash:row.payloadHash,serverEpoch:row.serverEpoch,attemptId:row.attemptId});report.approvalDecisions.push({tool:row.toolName,decision});}}catch{}finally{approving=false}}
async function start(prompt,sessionId){assert.ok(report.runs.length<7,'最多 7 次模型任务');const request={workspaceId,prompt,clientRequestId:backend+'-'+randomBytes(8).toString('hex'),serviceEpoch:epoch,backend,model,...(sessionId?{sessionId}:{})};const receipt=await call('agent_start',request);report.runs.push({request,receipt});return {request,receipt}}
async function wait(runId){const end=Date.now()+150000;for(;;){const got=await call('agent_get',{runId});if(['completed','failed','unknown','cancelled','interrupted','timed_out'].includes(got.state))return got;if(Date.now()>end)throw Error('run not terminal');await call('agent_wait',{runs:[{runId,afterRevision:got.revision}],returnWhen:'any_change',timeoutMs:2000});}}
async function completed(runId,contains){const got=await wait(runId);assert.equal(got.state,'completed',JSON.stringify(got));assert.equal(got.selectedModel,model);assert.equal(got.observedModel,model,'必须有本轮消息模型身份');const result=await call('agent_result',{runId,section:'agentReported'});assert.ok(result.page.text.includes(contains),result.page.text);return {got,result}}
async function errors(runId){const invalid=await call('agent_start',{workspaceId,prompt:'must not execute',clientRequestId:backend+'-forbidden-model',serviceEpoch:epoch,backend,model:'unapproved-paid-model'},true);assert.equal(invalid.error.code,'PROFILE_NOT_ALLOWED');const edit=await call('agent_start',{workspaceId,prompt:'must not execute',clientRequestId:backend+'-forbidden-edit',serviceEpoch:epoch,backend,model,profile:'edit'},true);assert.equal(edit.error.code,'PROFILE_NOT_ALLOWED');const get=await call('agent_get',{runId:'run_00000000-0000-4000-8000-000000000000'},true);assert.equal(get.error.code,'NOT_FOUND');const current=await call('agent_get',{runId});const stale=await call('agent_interrupt',{runId,clientRequestId:backend+'-stale-revision',expectedRevision:Math.max(0,current.revision-1),serviceEpoch:epoch},true);assert.equal(stale.error.code,'REVISION_CONFLICT');check('negative boundaries: model/profile/unknown id/revision');}
async function readArtifacts(runId){const result=await call('agent_result',{runId});let all='',offset=0;do{const page=await call('agent_result',{runId,offset,limitChars:37});all+=page.page.text;offset=page.page.nextOffset;if(!page.page.hasMore)break;}while(offset<30000);assert.equal(all,result.page.text);for(const art of result.artifacts){const read=await call('artifact_read',{artifactId:art.artifactId});trace('artifact',{metadata:art,response:read});assert.equal(read.sha256,createHash('sha256').update(read.page.text).digest('hex'));}check('result pagination/artifact hash',{artifacts:result.artifacts.length});const events=await call('agent_events',{runId,limit:2});const more=await call('agent_events',{runId,afterSeq:events.nextSeq-1,limit:100});assert.ok(events.events.length>0);check('event pagination',{eventCount:events.events.length+more.events.length});}
async function stopRun(tool,sessionId){const job=await start('使用 Read 工具逐一读取 note-01.txt 到 note-24.txt，每次只读一个文件。只读，不使用其他工具，不执行命令。最后用一句话总结所有条目。',sessionId);const runId=job.receipt.runId;const deadline=Date.now()+80000;let actualTool=false;for(;;){const ev=await call('agent_events',{runId,limit:100});actualTool=ev.events.some(e=>e.type==='run.tool');const got=await call('agent_get',{runId});if(actualTool||['completed','failed','unknown'].includes(got.state))break;if(Date.now()>deadline)break;await delay(300)}const got=await call('agent_get',{runId});assert.ok(!['completed','failed','unknown'].includes(got.state),'停止前任务必须在途');assert.ok(actualTool,'必须已经有真实模型工具请求');let response;for(let i=0;i<8;i++){const snapshot=await call('agent_get',{runId});const input={runId,clientRequestId:backend+'-'+tool+'-'+i,expectedRevision:snapshot.revision,serviceEpoch:epoch};response=await call(tool,input,true);if(!response.error){const replay=await call(tool,input);assert.deepEqual(replay,response);break;}assert.equal(response.error.code,'REVISION_CONFLICT');}assert.equal(response.confirmed,true,JSON.stringify(response));const final=await wait(runId);assert.equal(final.state,tool==='agent_interrupt'?'interrupted':'cancelled');check(tool+' active + receipt replay',{runId,state:final.state,method:response.method});return job;}
async function shutdown(){if(client)await client.close().catch(()=>{});try{await ipcCall(paths.operatorSocket,'daemon.shutdown',{}, {timeoutMs:10000})}catch{daemon?.kill('SIGTERM')}for(let i=0;i<200&&daemon?.exitCode===null&&daemon?.signalCode===null;i++)await delay(50);if(daemon?.exitCode===null&&daemon?.signalCode===null)daemon.kill('SIGKILL')}
try{
 await boot();await ready();approveTimer=setInterval(()=>void approve(),200);
 const first=await start('必须使用 Read 工具读取 README.md。只返回第一行原文，再加上 中文🙂 两个字和表情，不要解释，不要执行命令或修改文件。');
 const runId=first.receipt.runId;
 const replay=await call('agent_start',first.request);assert.equal(replay.runId,runId);assert.equal(replay.reused,true);check('start idempotency',{runId});
 if(!args.includes('--smoke')){await client.close();await connect();check('gateway reconnect during run');}
 const initial=await completed(runId,marker);check('real read/model identity',{runId,observedModel:initial.got.observedModel});
 const sessions=await call('agent_sessions',{workspaceId});const sessionId=initial.got.sessionId;assert.ok(sessions.sessions.some(s=>s.sessionId===sessionId));check('sessions');
 await errors(runId);await readArtifacts(runId);
 if(!args.includes('--smoke')){
  const follow=await start('不读取任何文件，只回答上轮 README 第一行的标记，保留原文。',sessionId);await completed(follow.receipt.runId,marker);check('same-session context');
  await client.close();client=null;await ipcCall(paths.operatorSocket,'daemon.shutdown',{});while(daemon.exitCode===null&&daemon.signalCode===null)await delay(100);await boot();await ready();
  const resumed=await start('不读取文件，只回答本会话第一轮 README 的完整标记。',sessionId);await completed(resumed.receipt.runId,marker);check('daemon restart session resume');
  await stopRun('agent_interrupt',sessionId);
  const continued=await start('不读取文件，只返回会话最初读取的 README 第一行标记。',sessionId);await completed(continued.receipt.runId,marker);check('continue after interrupt');
  await stopRun('agent_cancel');
  const finalList=await call('agent_sessions',{workspaceId});for(const row of finalList.sessions){const input={sessionId:row.sessionId,clientRequestId:backend+'-close-'+row.sessionId,expectedRevision:row.revision,serviceEpoch:epoch};const closed=await call('agent_close',input);assert.equal(closed.state,'closed');assert.deepEqual(await call('agent_close',input),closed);}check('close + receipt replay + retained history');await call('agent_result',{runId});
 }
 assert.deepEqual(hashes(),baseline);check('source unchanged');
}catch(error){report.error={name:error.name,message:redact(error.message).slice(0,6000)};console.log(JSON.stringify({backend,error:report.error}));process.exitCode=1;}
finally{
 if(approveTimer)clearInterval(approveTimer);await shutdown();report.endedAt=new Date().toISOString();report.sourceUnchanged=JSON.stringify(hashes())===JSON.stringify(baseline);fs.writeFileSync(join(evidence,'daemon-stderr.log'),redact(stderr),{mode:0o600});
 const db=join(data,'data','opencode-bridge.sqlite');if(fs.existsSync(db)){const sql=new DatabaseSync(db,{readOnly:true});report.dispatchCount=Number(sql.prepare('SELECT COUNT(*) n FROM dispatch_intents').get().n);report.outcomes=sql.prepare('SELECT run_id,backend_id,state,selected_model,observed_model FROM runs').all();sql.close();fs.copyFileSync(db,join(evidence,'runs.sqlite'));}
 fs.writeFileSync(join(evidence,'report.json'),JSON.stringify(report,null,2),{mode:0o600});fs.rmSync(root,{recursive:true,force:true});console.log(JSON.stringify({backend,summary:report}));
}
