const http = require('node:http');
const { URL } = require('node:url');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8810);
const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const IMAGE_ORIGIN = 'https://image-generation.perchance.org';
const MAX_BODY = 64 * 1024;
let imageWs = null;
let imageTargetId = null;
let cdpMessageId = 0;

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {'content-type':'application/json; charset=utf-8','access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'content-type,authorization','content-length':Buffer.byteLength(text)});
  res.end(text);
}
function readBody(req) { return new Promise((resolve,reject)=>{ let body=''; let settled=false; req.on('data', c=>{ body+=c; if(body.length>MAX_BODY&&!settled){ settled=true; reject(new Error('request body too large')); req.destroy(); } }); req.on('end',()=>{ if(settled)return; try{resolve(body?JSON.parse(body):{});}catch{reject(new Error('invalid JSON'));} }); req.on('error',e=>{if(!settled)reject(e);}); }); }
function httpJson(pathname, method='GET') { return new Promise((resolve,reject)=>{ const req=http.request({hostname:'127.0.0.1',port:CDP_PORT,path:pathname,method,timeout:5000},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(new Error('invalid CDP response'));}})}); req.on('timeout',()=>req.destroy(new Error('CDP request timeout'))); req.on('error',reject); req.end(); }); }
async function cdpSend(ws, method, params={}) { return new Promise((resolve,reject)=>{ const id=++cdpMessageId; const timer=setTimeout(()=>{ws.removeEventListener('message',handler);reject(new Error(`CDP timeout: ${method}`));},30000); function handler(event){try{const msg=JSON.parse(event.data);if(msg.id!==id)return;clearTimeout(timer);ws.removeEventListener('message',handler);if(msg.error)reject(new Error(msg.error.message));else resolve(msg.result||{});}catch{}} ws.addEventListener('message',handler); try{ws.send(JSON.stringify({id,method,params}));}catch(e){clearTimeout(timer);ws.removeEventListener('message',handler);reject(e);} }); }
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
async function openImageTab(){
  const targets=await httpJson('/json');
  let target=targets.find(t=>t.type==='page'&&t.url.startsWith(IMAGE_ORIGIN));
  if(!target) target=await httpJson('/json/new?'+encodeURIComponent(IMAGE_ORIGIN+'/embed?channel=ai-text-to-image-generator'),'PUT');
  if(imageWs&&imageTargetId===target.id&&imageWs.readyState===1)return imageWs;
  if(imageWs)try{imageWs.close();}catch{}
  const ws=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('CDP WebSocket timeout')),8000);ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});ws.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('CDP WebSocket error'));},{once:true});});
  await cdpSend(ws,'Page.enable'); await cdpSend(ws,'Runtime.enable');
  const embedUrl=IMAGE_ORIGIN+'/embed?channel=ai-text-to-image-generator';
  await cdpSend(ws,'Page.navigate',{url:embedUrl});
  await sleep(12000);
  imageWs=ws; imageTargetId=target.id; ws.addEventListener('close',()=>{if(imageWs===ws){imageWs=null;imageTargetId=null;}}); return ws;
}
async function getUserKey(ws){
  const expression=`(async()=>{let localError='';try{for(const k of Object.keys(localStorage)){const v=localStorage.getItem(k);if((k==='userKey-0'||/^[a-f0-9]{64}$/i.test(v))&&v)return JSON.stringify({key:v,source:'localStorage'})}}catch(e){localError=e.message}try{const r=await fetch('/api/verifyUser?thread=0&__cacheBust='+Math.random());const text=await r.text();const m=text.match(/"userKey"\\s*:\\s*"([a-f0-9]{32,})"/i);return JSON.stringify(m?{key:m[1],source:'verifyUser'}:{error:'userKey not found',status:r.status,localError,body:text.slice(0,200)})}catch(e){return JSON.stringify({error:e.message,localError})}})()`;
  const result=await cdpSend(ws,'Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  const value=result.result&&result.result.value; let parsed; try{parsed=JSON.parse(value);}catch{throw new Error('No se pudo leer userKey desde Perchance');}
  if(!parsed.key) throw new Error(`Perchance no entregó userKey: ${parsed.error||'respuesta inválida'}`); return parsed.key;
}
async function generateViaCdp(input){
  const ws=await openImageTab(); const key=await getUserKey(ws);
  const prompt=String(input.prompt||'').trim(); const negativePrompt=String(input.negative_prompt||''); const size=String(input.size||'768x768');
  const shapeResolution={portrait:'512x768',square:'768x768',landscape:'768x512'}; const resolution=shapeResolution[size]||size;
  const body={generatorName:'ai-image-generator',channel:'ai-text-to-image-generator',subChannel:'public',prompt,negativePrompt,seed:Number.isFinite(Number(input.seed))?Number(input.seed):-1,resolution,guidanceScale:Number(input.guidance_scale)||7,userKey:key,adAccessCode:null,requestId:'aiImageCompletion'+Math.floor(Math.random()*2**30)};
  const expression=`(async()=>{try{const body=${JSON.stringify(body)};const qs=new URLSearchParams({userKey:body.userKey,requestId:body.requestId,__cacheBust:String(Math.random())});const r=await fetch('/api/generate?'+qs.toString(),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});const data=await r.json().catch(()=>({}));if(!r.ok)return JSON.stringify({error:'generate HTTP '+r.status,detail:data});if(!data.imageId)return JSON.stringify({error:'Perchance no devolvió imageId',detail:data});const d=await fetch(data.imageDownloadUrl);if(!d.ok)return JSON.stringify({error:'download HTTP '+d.status});const blob=await d.blob();const b64=await new Promise((resolve,reject)=>{const fr=new FileReader();fr.onloadend=()=>resolve(fr.result);fr.onerror=reject;fr.readAsDataURL(blob)});return JSON.stringify({ok:true,b64,imageId:data.imageId,seed:data.seed,width:data.width,height:data.height})}catch(e){return JSON.stringify({error:e.message})}})()`;
  const result=await cdpSend(ws,'Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true}); let parsed; try{parsed=JSON.parse(result.result&&result.result.value);}catch{throw new Error('Respuesta inválida de Perchance');} if(parsed.error)throw new Error(parsed.error+(parsed.detail?': '+JSON.stringify(parsed.detail).slice(0,300):'')); if(!parsed.b64||!parsed.b64.startsWith('data:image/'))throw new Error('Perchance devolvió un payload de imagen inválido'); return parsed;
}
const server=http.createServer(async(req,res)=>{
  if(req.method==='OPTIONS')return json(res,204,{});
  const p=new URL(req.url,`http://${HOST}:${PORT}`).pathname;
  if(req.method==='GET'&&p==='/health')return json(res,200,{status:'ok',service:'perchance-image-api-v2',cdp_port:CDP_PORT,cdp_configured:true,browser_bridge:'perchance-image-generation',image_tab_connected:Boolean(imageWs&&imageWs.readyState===1)});
  if(req.method==='GET'&&p==='/v1/models')return json(res,200,{object:'list',data:[{id:'perchance-image',object:'model',owned_by:'perchance.org',capability:'image'}]});
  if(req.method==='POST'&&p==='/v1/images/generations'){
    let input;try{input=await readBody(req);}catch(e){return json(res,400,{error:{message:e.message}});}
    const prompt=String(input.prompt||'').trim(); if(!prompt)return json(res,400,{error:{message:'prompt is required'}});
    const size=String(input.size||'square'); if(!['512x512','768x768','1024x1024','portrait','square','landscape'].includes(size))return json(res,400,{error:{message:'unsupported size'}});
    try{const result=await generateViaCdp({...input,size});const raw=result.b64.replace(/^data:image\/[^;]+;base64,/,'');const item=input.response_format==='url'?{url:result.b64}:{b64_json:raw};return json(res,200,{created:Math.floor(Date.now()/1000),data:[item],meta:{image_id:result.imageId,seed:result.seed,width:result.width,height:result.height,provider:'perchance.org'}});}catch(e){return json(res,503,{error:{message:e.message,code:'PERCHANCE_GENERATION_FAILED'}});}
  }
  return json(res,404,{error:{message:'Not found'}});
});
server.listen(PORT,HOST,()=>console.log(`perchance-image-api-v2 listening on http://${HOST}:${PORT} (CDP ${CDP_PORT})`));
