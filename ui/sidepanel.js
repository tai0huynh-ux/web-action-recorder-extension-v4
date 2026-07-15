import { NodeEditor } from './canvas-editor.js';
import { uid, normalizeProfile, validateProfile } from '../src/shared.js';
let state = { profiles: [], activeProfileId: null, logs: [], library: [] };
let activeProfile = null;
let currentRunId = null;
let editor = null;
const $ = (id) => document.getElementById(id);

init();
async function init(){ 
  bind(); 
  await refresh(); 
  
  // Listen for background updates
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'CONTENT_CAPTURED') {
      refresh(); // Reload library
    }
    if (message.type === 'RECORDING_STATE_CHANGED') {
      updateRecordingUI(message.isRecording);
    }
  });
}

function bind(){
 $('openWindowBtn').onclick=()=>msg({type:'OPEN_EDITOR_WINDOW'});
 const savedHeight=Number(localStorage.getItem('war_canvas_height')||500);
 $('canvasHeight').value=String(Math.min(1200,Math.max(320,savedHeight)));
 setCanvasHeight(Number($('canvasHeight').value));
 $('canvasHeight').oninput=()=>setCanvasHeight(Number($('canvasHeight').value));
 $('profileSelect').onchange=()=>{state.activeProfileId=$('profileSelect').value; activeProfile=state.profiles.find(p=>p.id===state.activeProfileId); render();};
 
 $('newProfileBtn').onclick=()=>{
   const p=normalizeProfile({id:uid('profile'),name:'Profile mới',steps:[]});
   state.profiles.push(p);
   state.activeProfileId=p.id;
   activeProfile=p;
   renderProfiles();
   renderSteps();
 };

 $('saveBtn').onclick=save;
 $('discoverRootsBtn').onclick=()=>{
   if(!editor)return;
   const roots=editor.discoverRoots();
   activeProfile.steps=editor.getData();
   $('rootStatus').textContent=`Tìm thấy ${roots.length} nút gốc`;
 };
 $('themeToggleBtn').onclick = () => { document.body.classList.toggle('dark'); };
 
 $('runBtn').onclick=async()=>{
   if(!activeProfile)return;
   await save();
   const result=await msg({type:'RUN_PROFILE',profileId:activeProfile.id});
   if(result?.ok){currentRunId=result.runId;$('stopBtn').disabled=false;}
 };
 $('stopBtn').onclick=async()=>{if(currentRunId)await msg({type:'STOP_PROFILE',runId:currentRunId});currentRunId=null;$('stopBtn').disabled=true;await refresh();};
 $('exportBtn').onclick=exportProfile; 
 $('importFile').onchange=importProfile; 
 $('clearLogsBtn').onclick=()=>msg({type:'CLEAR_LOGS'}).then(refresh);
 
 $('captureClickBtn').onclick=async ()=>{
   const payload={type:'WAR_CAPTURE_TARGET'};
   const res = await activeTabMsg(payload).catch(err=>forwardToActiveTab(payload,err));
   if(res?.isRecording !== undefined) updateRecordingUI(res.isRecording, 'captureClickBtn');
 };
 $('captureTypeBtn').onclick=async ()=>{
   const payload={type:'WAR_CAPTURE_TYPE_TARGET'};
   const res=await activeTabMsg(payload).catch(err=>forwardToActiveTab(payload,err));
   if(res?.isRecording!==undefined) updateRecordingUI(res.isRecording,'captureTypeBtn');
 };
 $('captureDomainBtn').onclick=async ()=>{
   const payload={type:'WAR_CAPTURE_DOMAIN_TARGET'};
   const res = await activeTabMsg(payload).catch(err=>forwardToActiveTab(payload,err));
   if(res?.isRecording !== undefined) updateRecordingUI(res.isRecording, 'captureDomainBtn');
 };
 $('captureTextBtn').onclick=async ()=>{
   const payload={type:'WAR_CAPTURE_TEXT_TARGET'};
   const res = await activeTabMsg(payload).catch(err=>forwardToActiveTab(payload,err));
   if(res?.isRecording !== undefined) updateRecordingUI(res.isRecording, 'captureTextBtn');
 };
 
 document.querySelector('.add-row').onclick=(e)=>{if(e.target.dataset.add)addStep(e.target.dataset.add)};
 
 $('helpToggleBtn').onclick=()=>{
   const content = $('helpContent');
   const isOpen = content.classList.contains('open');
   if(isOpen) {
     content.classList.remove('open');
     $('helpToggleBtn').querySelector('span').textContent = '▼';
   } else {
     content.classList.add('open');
     $('helpToggleBtn').querySelector('span').textContent = '▲';
   }
 };
}

function setCanvasHeight(height){
  const value=Math.min(1200,Math.max(320,Number(height)||500));
  document.documentElement.style.setProperty('--canvas-height',`${value}px`);
  $('canvasHeightValue').textContent=`${value} px`;
  localStorage.setItem('war_canvas_height',String(value));
  editor?.renderLinks();
}

// Fallback logic when sidepanel can't directly message tab (e.g. extension page focus)
async function forwardToActiveTab(payload, err) {
  console.log("Direct tab message failed, forwarding via background...", err);
  return msg({type: 'FORWARD_ACTIVE_TAB', payload});
}

function updateRecordingUI(isRecording, activeButtonId) {
  ['captureClickBtn','captureTypeBtn','captureDomainBtn','captureTextBtn'].forEach(id=>{
    const button=$(id); if(!button)return;
    button.classList.toggle('recording',Boolean(isRecording)&&(!activeButtonId||id===activeButtonId));
    button.setAttribute('aria-pressed',String(Boolean(isRecording)&&(!activeButtonId||id===activeButtonId)));
  });
}

async function refresh(){const r=await msg({type:'GET_STATE'});state=r.state;activeProfile=state.profiles.find(p=>p.id===state.activeProfileId)||state.profiles[0];render();}
function render(){renderProfiles();renderSteps();renderLibrary();renderLogs();}

function renderProfiles(){ 
  $('profileSelect').innerHTML=state.profiles.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join(''); 
  $('profileSelect').value=activeProfile?.id||''; 
  $('profileName').value=activeProfile?.name||''; 
  $('profileName').oninput=()=>{activeProfile.name=$('profileName').value;renderProfiles();};
  $('profileEnabled').checked=Boolean(activeProfile?.enabled);
  $('profileEnabled').onchange=()=>{if(activeProfile)activeProfile.enabled=$('profileEnabled').checked;};
}


function renderSteps() {
  if (!editor) {
      editor = new NodeEditor('canvas-container', () => {
          activeProfile.steps = editor.getData();
          updateRootStatus();
          // auto save maybe?
      }, async () => {
          try {
              const res = await activeTabMsg({type: 'PICK_ELEMENT'});
              return res ? res.selector : null;
          } catch(err) {
              console.error(err);
              return null;
          }
      });
      globalThis.__warEditor = editor;
  }
  editor.loadData(activeProfile.steps || []);
  updateRootStatus();
}





function update(step,key,value){
  if(!key)return;
  if(key.includes('.')){
    const [a,b]=key.split('.');
    step[a]||={};
    step[a][b]=value;
  }else if(key==='ifSteps'||key==='elseSteps') {
    step[key]=value.split(',').map(s=>s.trim()).filter(Boolean);
  } else {
    step[key]=value;
  }
}


function addStep(type){
  const base={id:uid('step'),name:`Bước ${type}`,type,delayAfterMs:500};
  
  if (editor) {
      const v = editor.screenToWorld(editor.wrapper.getBoundingClientRect().width / 2 + editor.wrapper.getBoundingClientRect().left, 100 + editor.wrapper.getBoundingClientRect().top);
      base.ui = { x: v.x, y: v.y };
  }
  

  if(type==='condition')Object.assign(base,{condition:{kind:'domain',operator:'contains',value:location?.hostname||''},ifSteps:[],elseSteps:[]});
  if(['OR', 'AND', 'IFS'].includes(type)) Object.assign(base,{conditions:[{kind:'domain',operator:'contains',value:location?.hostname||''}]});
  
  activeProfile.steps.push(base);
  renderSteps();
}



function renderLibrary(){ 
  $('library').innerHTML=(state.library||[]).map(item=>`<div class="lib-item"><b>${esc(item.name||item.kind)}</b><code>${esc(JSON.stringify(item.condition||{type:item.type,selector:item.selector}).slice(0,180))}</code><button data-id="${esc(item.id)}">➕ Thêm vào profile</button></div>`).join(''); 
  $('library').onclick=(e)=>{
    const item=state.library.find(x=>x.id===e.target.dataset.id);
    if(item){
      activeProfile.steps.push(normalizeLibrary(item));
      renderSteps();
    }
  };
}

function normalizeLibrary(item){
  if(item.condition) return {id:uid('step'),name:item.name||'Điều kiện đã ghi',type:'condition',delayAfterMs:500,condition:item.condition,ifSteps:[],elseSteps:[]};
  return {id:uid('step'),name:item.name||'Hành động đã ghi',type:item.type||'click',delayAfterMs:500,selector:item.selector,text:item.text||''};
}

function renderLogs(){ 
  $('logs').textContent=(state.logs||[]).slice(0,80).map(l=>`[${l.time}] ${l.level}: ${l.message}`).join('\n');
}

async function save(){
  activeProfile=normalizeProfile(activeProfile);
  const i=state.profiles.findIndex(p=>p.id===activeProfile.id);
  state.profiles[i]=activeProfile;
  await msg({type:'SAVE_PROFILES',profiles:state.profiles,activeProfileId:activeProfile.id});
  await refresh();
}

function exportProfile(){
  const blob=new Blob([JSON.stringify(activeProfile,null,2)],{type:'application/json'});
  const a=Object.assign(document.createElement('a'),{href:URL.createObjectURL(blob),download:`${activeProfile.name}.json`});
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importProfile(e){
  const file=e.target.files[0];
  if(!file)return;
  try {
    if(file.size>1024*1024) throw new Error('File profile vượt quá giới hạn 1 MB');
    const raw=JSON.parse(await file.text()); validateProfile(raw);
    const p=normalizeProfile(raw); if(state.profiles.some(existing=>existing.id===p.id)) p.id=uid('profile');
    state.profiles.push(p); state.activeProfileId=p.id; activeProfile=p; render();
  } catch(error) { alert(`Không thể import: ${error.message}`); }
  finally { e.target.value=''; }
}

async function msg(m){return chrome.runtime.sendMessage(m);} 

async function activeTabMsg(m){
  const response=await msg({type:'FORWARD_ACTIVE_TAB',payload:m});
  if(response?.ok===false) throw new Error(response.error||'Không tìm thấy tab web');
  return response;
} 

function updateRootStatus(){
  if(!$('rootStatus'))return;
  const count=editor?.getRootIds?.().length || 0;
  $('rootStatus').textContent=count ? `Tìm thấy ${count} nút gốc` : 'Không có nút gốc';
}

function opts(values, selected){
  return values.map(v=>{
    if(Array.isArray(v)) {
      return `<option value="${esc(v[0])}" ${v[0]===selected?'selected':''}>${esc(v[1])}</option>`;
    }
    return `<option value="${esc(v)}" ${v===selected?'selected':''}>${esc(v)}</option>`;
  }).join('');
}

function esc(s){return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
