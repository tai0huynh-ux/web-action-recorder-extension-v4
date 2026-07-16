const activeRuns = new Set();
const handedOffRuns = new Set();
let captureMode = false;
let lastTarget = null;
let currentMode = null;

// Add a visible indicator when recording
let indicatorBox = null;
let captureTargetBox = null;
let captureHoverTarget = null;
let captureHoverFrame = null;

function createTargetBox(color = '#ef4444') {
  const box=document.createElement('div');
  box.style.cssText=`position:fixed;display:none;z-index:2147483646;pointer-events:none;border:3px solid ${color};background:${color}18;box-shadow:0 0 0 3px #fff,0 0 0 6px ${color}99,0 6px 24px #0005;border-radius:4px;`;
  const aim=document.createElement('span');
  aim.style.cssText=`position:absolute;left:50%;top:50%;width:14px;height:14px;transform:translate(-50%,-50%);border:2px solid #fff;border-radius:50%;background:${color};box-shadow:0 0 0 2px ${color};`;
  box.appendChild(aim); document.documentElement.appendChild(box); return box;
}

function positionTargetBox(box,target) {
  if(!box||!target?.getBoundingClientRect)return;
  const rect=target.getBoundingClientRect();
  if(rect.width<1||rect.height<1){box.style.display='none';return;}
  box.style.display='block'; box.style.left=`${rect.left}px`; box.style.top=`${rect.top}px`;
  box.style.width=`${rect.width}px`; box.style.height=`${rect.height}px`;
}

function updateIndicator() {
  if (!captureMode) {
    if (indicatorBox) { indicatorBox.remove(); indicatorBox = null; }
    if (captureTargetBox) { captureTargetBox.remove(); captureTargetBox = null; }
    captureHoverTarget = null;
    document.body.style.cursor = '';
    return;
  }
  
  if (!indicatorBox) {
    indicatorBox = document.createElement('div');
    indicatorBox.style.cssText = 'position:fixed;z-index:2147483647;top:16px;right:16px;background:#b42318;color:white;padding:8px 16px;border-radius:20px;font:bold 14px system-ui;box-shadow:0 4px 12px rgba(0,0,0,0.3);display:flex;align-items:center;gap:8px;animation: pulse 1.5s infinite; pointer-events: none;';
    
    const style = document.createElement('style');
    style.textContent = '@keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.6; } 100% { opacity: 1; } }';
    indicatorBox.appendChild(style);
    
    document.documentElement.appendChild(indicatorBox);
  }
  if (!captureTargetBox) captureTargetBox=createTargetBox('#ef4444');
  
  let modeText = 'Recording Click/Type';
  if (currentMode === 'domain') modeText = 'Recording Domain Condition';
  if (currentMode === 'text') modeText = 'Recording Text Condition';
  if (currentMode === 'type') modeText = 'Recording Input Target';
  
  indicatorBox.innerHTML = `🔴 <span>${modeText}</span>`;
  document.body.style.cursor = 'crosshair';
}

document.addEventListener('mousemove',event=>{
  if(!captureMode) return;
  captureHoverTarget=event.target;
  if(captureHoverFrame) return;
  captureHoverFrame=requestAnimationFrame(()=>{
    captureHoverFrame=null;
    positionTargetBox(captureTargetBox,captureHoverTarget);
  });
},true);
window.addEventListener('scroll',()=>{if(captureMode&&captureHoverTarget)positionTargetBox(captureTargetBox,captureHoverTarget);},true);
window.addEventListener('resize',()=>{if(captureMode&&captureHoverTarget)positionTargetBox(captureTargetBox,captureHoverTarget);},true);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

// Prevent default clicks when recording target
document.addEventListener('click', (event) => {
  lastTarget = event.target;
  if (!captureMode) return;
  
  event.preventDefault();
  event.stopPropagation();
  
  captureMode = false;
  updateIndicator();
  
  const target = event.target;
  const selector = bestSelector(target);
  
  if (currentMode === 'domain') {
    sendCaptured({ kind: 'condition', condition: { kind: 'domain', operator: 'matches', value: `*${location.hostname}*` }, name: `Tên miền chứa ${location.hostname}` });
  } else if (currentMode === 'text') {
    sendCaptured({ kind: 'condition', condition: { kind: 'text', operator: 'contains', selector, value: textOf(target).slice(0, 120) }, name: `Điều kiện chữ: ${labelFor(target)}` });
   } else if (currentMode === 'type') {
     if (!['INPUT','TEXTAREA'].includes(target.tagName)) {
       toast('Hãy chọn một ô input hoặc textarea.');
       captureMode=true; updateIndicator(); return;
     }
     const secret=isSecretElement(target);
     sendCaptured({ kind:'action', type:'type', selector, text:secret?'':target.value, requiresSecretPrompt:secret, name:`Nhập liệu ${labelFor(target)}` });
   } else {
    // default target (click)
    sendCaptured({ kind: 'action', type: 'click', selector, name: `Click ${labelFor(target)}` });
  }
  
  currentMode = null;
}, true);

// Record typing
document.addEventListener('input', (event) => { 
  lastTarget = event.target; 
}, true);

document.addEventListener('change', (event) => {
  if (captureMode) {
    const target = event.target;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        event.preventDefault();
        event.stopPropagation();
        
        captureMode = false;
        updateIndicator();
        
        const selector = bestSelector(target);
        if (isSecretElement(target)) {
          toast('Không ghi giá trị của trường nhạy cảm. Hãy dùng biến nhập lúc chạy.');
          sendCaptured({ kind: 'action', type: 'type', selector, text: '', requiresSecretPrompt: true, name: `Nhập dữ liệu nhạy cảm ${labelFor(target)}` });
        } else {
          sendCaptured({ kind: 'action', type: 'type', selector, text: target.value, name: `Nhập liệu ${labelFor(target)}` });
        }
        currentMode = null;
    }
  }
}, true);

async function handleMessage(message) {
  if (message?.type === 'WAR_CAPTURE_TARGET') {
    captureMode = !captureMode; // toggle
    currentMode = 'target';
    if (captureMode) toast('Hãy click vào một phần tử trên trang để ghi lại.');
    updateIndicator();
    return { ok: true, isRecording: captureMode };
  }
  if (message?.type === 'WAR_CAPTURE_DOMAIN_TARGET') {
    captureMode = true;
    currentMode = 'domain';
    toast('Click vào trang để ghi lại điều kiện tên miền.');
    updateIndicator();
    return { ok: true, isRecording: true };
  }
  if (message?.type === 'WAR_CAPTURE_TEXT_TARGET') {
    captureMode = true;
    currentMode = 'text';
    toast('Click vào một phần tử để ghi lại điều kiện văn bản.');
    updateIndicator();
    return { ok: true, isRecording: true };
  }
  if (message?.type === 'WAR_CAPTURE_TYPE_TARGET') {
    captureMode=true; currentMode='type'; toast('Click vào ô cần nhập dữ liệu.'); updateIndicator();
    return {ok:true,isRecording:true};
  }
  
  if (message?.type === 'PICK_ELEMENT') {
    return new Promise((resolve) => {
      let isPicking = true;
      const overlayBox = document.createElement('div');
      overlayBox.style.cssText = 'position:fixed;z-index:2147483647;top:16px;right:16px;background:#245cff;color:white;padding:8px 16px;border-radius:20px;font:bold 14px system-ui;box-shadow:0 4px 12px rgba(0,0,0,0.3);pointer-events:none;';
      overlayBox.innerText = '🎯 Đang chọn phần tử... (Bấm ESC để huỷ)';
      document.documentElement.appendChild(overlayBox);
      
      let prevHover = null;
      let selectedTarget = null;
      let chooserDrag = null;
      const targetBox=createTargetBox('#245cff');
      const chooser=document.createElement('div');
      chooser.style.cssText='display:none;position:fixed;z-index:2147483647;right:16px;top:64px;width:min(380px,calc(100vw - 32px));max-height:calc(100vh - 80px);overflow:auto;background:#fff;color:#172033;border:2px solid #245cff;border-radius:12px;box-shadow:0 14px 40px #0007;padding:12px;font:13px system-ui;box-sizing:border-box;';
      document.documentElement.appendChild(chooser);
      
      const cleanup = () => {
        isPicking = false;
        document.removeEventListener('mouseover', onMouseOver, true);
        document.removeEventListener('mousemove', onMouseOver, true);
        window.removeEventListener('scroll', refreshBox, true);
        window.removeEventListener('resize', refreshBox, true);
        window.removeEventListener('pointermove', moveChooser, true);
        window.removeEventListener('pointerup', stopChooserDrag, true);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKeyDown, true);
        overlayBox.remove();
        targetBox.remove();
        chooser.remove();
      };

      const refreshBox=()=>{if(isPicking&&prevHover)positionTargetBox(targetBox,prevHover);};
      const moveChooser=event=>{
        if(!chooserDrag)return;
        const maxLeft=Math.max(0,window.innerWidth-chooser.offsetWidth);
        const maxTop=Math.max(0,window.innerHeight-chooser.offsetHeight);
        chooser.style.left=`${Math.min(maxLeft,Math.max(0,event.clientX-chooserDrag.x))}px`;
        chooser.style.top=`${Math.min(maxTop,Math.max(0,event.clientY-chooserDrag.y))}px`;
        chooser.style.right='auto';
      };
      const stopChooserDrag=()=>{chooserDrag=null;};
      window.addEventListener('pointermove',moveChooser,true);
      window.addEventListener('pointerup',stopChooserDrag,true);

      const onMouseOver = (e) => {
        if(!isPicking) return;
        if(chooser.contains(e.target))return;
        if((e.target===document.body||e.target===document.documentElement)&&prevHover){positionTargetBox(targetBox,prevHover);return;}
        prevHover=e.target;
        positionTargetBox(targetBox,prevHover);
      };

      const describeElement=(el)=>{
        const tag=el.tagName.toLowerCase();
        const role=el.getAttribute('role');
        const label=(el.getAttribute('aria-label')||el.getAttribute('title')||el.getAttribute('placeholder')||textOf(el)).trim().replace(/\s+/g,' ').slice(0,70);
        return `${tag}${role?` [role=${role}]`:''}${label?` — ${label}`:''}`;
      };

      const candidateElements=(target,x,y)=>{
        const found=[];
        const add=el=>{if(el&&el.nodeType===1&&!found.includes(el)&&!chooser.contains(el)&&el!==overlayBox&&el!==targetBox)found.push(el);};
        document.elementsFromPoint?.(x,y).forEach(add);
        let current=target;
        while(current&&current!==document.documentElement){
          const meaningful=/^(BUTTON|A|INPUT|TEXTAREA|SELECT|LABEL|IMG|VIDEO|LI|ARTICLE|SECTION|NAV|FORM)$/.test(current.tagName)
            || current.id||current.getAttribute('role')||current.getAttribute('aria-label')||current.getAttribute('data-testid');
          if(meaningful||current===target)add(current);
          current=current.parentElement;
        }
        return found.filter(el=>{const r=el.getBoundingClientRect();return r.width>2&&r.height>2;}).slice(0,12);
      };

      const showCandidates=(items)=>{
        chooser.replaceChildren(); chooser.style.display='block';
        const title=document.createElement('div'); title.textContent='⠿ Chọn phần tử phù hợp';
        title.title='Giữ và kéo để di chuyển bảng';
        title.style.cssText='font-weight:700;cursor:move;user-select:none;padding:4px 6px;margin:-4px -4px 2px;border-radius:7px;background:#eef2ff;touch-action:none;';
        title.addEventListener('pointerdown',event=>{
          event.preventDefault(); event.stopPropagation();
          const rect=chooser.getBoundingClientRect(); chooserDrag={x:event.clientX-rect.left,y:event.clientY-rect.top};
        });
        chooser.appendChild(title);
        const help=document.createElement('div'); help.textContent='Chọn một mục để xem trước khung và selector, sau đó nhấn Chấp nhận.'; help.style.cssText='color:#5b6475;margin:4px 0 10px;'; chooser.appendChild(help);
        const list=document.createElement('div'); list.style.cssText='display:grid;gap:6px;'; chooser.appendChild(list);
        items.forEach((el,index)=>{
          const button=document.createElement('button'); button.type='button';
          button.style.cssText='display:block;width:100%;text-align:left;padding:8px;border:1px solid #cbd3e1;border-radius:7px;background:#f8fafc;color:#172033;cursor:pointer;font:12px system-ui;';
          button.textContent=`${index+1}. ${describeElement(el)}`;
          button.addEventListener('click',event=>{
            event.preventDefault(); event.stopPropagation(); selectedTarget=el; prevHover=el; positionTargetBox(targetBox,el);
            [...list.children].forEach(item=>item.style.borderColor='#cbd3e1'); button.style.borderColor='#245cff';
            selectorText.textContent=bestSelector(el); accept.disabled=false;
          }); list.appendChild(button);
        });
        const selectorText=document.createElement('code'); selectorText.textContent='Chưa chọn phần tử'; selectorText.style.cssText='display:block;margin:10px 0;padding:8px;background:#eef2ff;word-break:break-all;border-radius:6px;'; chooser.appendChild(selectorText);
        const actions=document.createElement('div'); actions.style.cssText='display:flex;gap:8px;justify-content:flex-end;'; chooser.appendChild(actions);
        const cancel=document.createElement('button'); cancel.textContent='Hủy'; cancel.style.cssText='padding:8px 12px;'; actions.appendChild(cancel);
        const accept=document.createElement('button'); accept.textContent='Chấp nhận'; accept.disabled=true; accept.style.cssText='padding:8px 12px;background:#245cff;color:#fff;border:0;border-radius:7px;'; actions.appendChild(accept);
        cancel.onclick=event=>{event.stopPropagation();cleanup();resolve({error:'Cancelled'});};
        accept.onclick=event=>{event.stopPropagation();if(!selectedTarget)return;const selector=bestSelector(selectedTarget);cleanup();resolve({selector});};
      };
      
      const onClick = (e) => {
        if(!isPicking) return;
        if(chooser.contains(e.target))return;
        e.preventDefault();
        e.stopPropagation();
        selectedTarget=null;
        const candidates=candidateElements(e.target,e.clientX,e.clientY);
        showCandidates(candidates);
      };

      const onKeyDown = (e) => {
        if (e.key === 'Escape' && isPicking) {
            cleanup();
            resolve({ error: 'Cancelled' });
        }
      };
      
      document.addEventListener('mouseover', onMouseOver, true);
      document.addEventListener('mousemove', onMouseOver, true);
      window.addEventListener('scroll', refreshBox, true);
      window.addEventListener('resize', refreshBox, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKeyDown, true);
    });
  }
  
  if (message?.type === 'WAR_RUN_PROFILE') return runProfile(message.runId, message.profile, message.startIds, message.inputs || {});
  if (message?.type === 'WAR_STOP_PROFILE') { activeRuns.delete(message.runId); return { ok: true }; }
  
  // Legacy immediate capture (if no element clicked)
  if (message?.type === 'WAR_CAPTURE_CURRENT_DOMAIN') {
    sendCaptured({ kind: 'condition', condition: { kind: 'domain', operator: 'matches', value: `*${location.hostname}*` }, name: `Tên miền chứa ${location.hostname}` });
    return { ok: true };
  }
  if (message?.type === 'WAR_CAPTURE_TEXT_CONDITION') {
    const target = lastTarget || document.activeElement || document.body;
    sendCaptured({ kind: 'condition', condition: { kind: 'text', operator: 'contains', selector: bestSelector(target), value: textOf(target).slice(0, 120) }, name: `Điều kiện chữ: ${labelFor(target)}` });
    return { ok: true };
  }
  return { ok: false, error: 'Unknown content message' };
}


async function runProfile(runId, profile, startIds = null, inputs = {}) {
  activeRuns.add(runId);
  const steps = Array.isArray(profile?.steps) ? profile.steps : [];
  const stepById = new Map(steps.map((s) => [s.id, s]));
  if (!steps.length) {
    activeRuns.delete(runId);
    log('error', 'Profile has no steps', runId);
    chrome.runtime.sendMessage({ type: 'WAR_RUN_FINISHED', runId, result: { ok: false, error: 'Profile has no steps' } }).catch(() => {});
    return { ok: false, error: 'Profile has no steps' };
  }
  if (!Array.isArray(startIds) || !startIds.length) {
    activeRuns.delete(runId);
    log('error', 'Missing startIds', runId);
    chrome.runtime.sendMessage({ type: 'WAR_RUN_FINISHED', runId, result: { ok: false, error: 'Missing startIds' } }).catch(() => {});
    return { ok: false, error: 'Missing startIds' };
  }
  log('info', `Đang chạy ${steps.length} bước`, runId);
  
  const roots = startIds.map(id => stepById.get(id)).filter(Boolean);
  const executed = new Set();
  
  // Start execution from roots
  for (const root of roots) {
      if (!activeRuns.has(runId)) break;
      const result = await executeGraphNode(root, stepById, runId, profile, new Set(), inputs, executed);
      if (result?.ok === false) {
        chrome.runtime.sendMessage({ type: 'WAR_RUN_FINISHED', runId, result }).catch(() => {});
        return result;
      }
  }
  if (!activeRuns.has(runId)) {
    if (handedOffRuns.delete(runId)) return { ok: true, runId, handedOff: true };
    chrome.runtime.sendMessage({ type: 'WAR_RUN_FINISHED', runId, result: { ok: false, cancelled: true } }).catch(() => {});
    return { ok: false, runId };
  }
  
  activeRuns.delete(runId);
  log('info', `Hoàn thành chạy: ${profile?.name || 'profile'}`, runId);
  chrome.runtime.sendMessage({ type: 'WAR_RUN_FINISHED', runId, result: { ok: true, runId } }).catch(() => {});
  return { ok: true, runId };
}

async function executeGraphNode(step, stepById, runId, profile, path, inputs, executed) {
    if (!activeRuns.has(runId)) return;
    if (executed?.has(step.id)) return;
    if (path.has(step.id)) {
      log('error', `Phát hiện vòng lặp tại bước ${step.name || step.id}`, runId);
      activeRuns.delete(runId);
      return;
    }
    const nextPath = new Set(path).add(step.id);
    executed?.add(step.id);
    
    // Execute the step itself
    const executableStep = resolveStepTemplates(step, inputs);
    const result = await executeStep(executableStep, runId, profile, inputs);
    if (!activeRuns.has(runId)) return;
    if (!result?.ok) { activeRuns.delete(runId); return result; }
    if (result.handedOff) { handedOffRuns.add(runId); activeRuns.delete(runId); return result; }
    if (step.delayAfterMs) await delay(Number(step.delayAfterMs), runId);
    if (!activeRuns.has(runId)) return;
    if (result.navigating) {
      const startIds = step.next ? [step.next] : [];
      if (startIds.length) await chrome.runtime.sendMessage({ type: 'WAR_CONTINUE_AFTER_NAVIGATION', runId, profile, startIds, inputs });
      location.assign(result.url);
      return;
    }
    
    // Evaluate connections
    if (step.type === 'condition') {
        const branchIds = result.matched ? step.ifSteps : step.elseSteps;
        if (Array.isArray(branchIds) && branchIds.length) {
            for (const id of branchIds) {
                const nextStep = stepById.get(id);
                if (nextStep) await executeGraphNode(nextStep, stepById, runId, profile, nextPath, inputs, executed);
            }
        }
    } else if (step.type === 'OR') {
        // Evaluate all conditions. The first one that matches fires its next step.
        let matchedIdx = -1;
        if (executableStep.conditions) {
            for (let i = 0; i < executableStep.conditions.length; i++) {
                if (evaluateCondition(executableStep.conditions[i])) {
                    matchedIdx = i;
                    break;
                }
            }
        }
        if (matchedIdx !== -1 && step.conditions[matchedIdx].next) {
            const nextStep = stepById.get(step.conditions[matchedIdx].next);
            if (nextStep) await executeGraphNode(nextStep, stepById, runId, profile, nextPath, inputs, executed);
        }
    } else if (step.type === 'AND') {
        // Evaluate all. ALL must match.
        let allMatched = true;
        if (executableStep.conditions && executableStep.conditions.length > 0) {
            for (let i = 0; i < executableStep.conditions.length; i++) {
                if (!evaluateCondition(executableStep.conditions[i])) {
                    allMatched = false;
                    break;
                }
            }
        }
        if (allMatched) {
            // If ALL matched, fire all outgoing connections of all conditions concurrently
            const nexts = [];
            if (executableStep.conditions) {
                executableStep.conditions.forEach(c => {
                    if (c.next) nexts.push(c.next);
                });
            }
            // Run them concurrently
            await Promise.all(nexts.map(id => {
                const nextStep = stepById.get(id);
                if (nextStep) return executeGraphNode(nextStep, stepById, runId, profile, nextPath, inputs, executed);
            }));
        } else {
            // Fire Fail port
            if (step.elseSteps && step.elseSteps.length > 0) {
                 for (const id of step.elseSteps) {
                     const nextStep = stepById.get(id);
                      if (nextStep) await executeGraphNode(nextStep, stepById, runId, profile, nextPath, inputs, executed);
                 }
            }
        }
    } else if (step.type === 'IFS') {
        // Sequential priority if. First match fires.
        let matchedIdx = -1;
        if (executableStep.conditions) {
            for (let i = 0; i < executableStep.conditions.length; i++) {
                if (evaluateCondition(executableStep.conditions[i])) {
                    matchedIdx = i;
                    break;
                }
            }
        }
        if (matchedIdx !== -1 && step.conditions[matchedIdx].next) {
            const nextStep = stepById.get(step.conditions[matchedIdx].next);
            if (nextStep) await executeGraphNode(nextStep, stepById, runId, profile, nextPath, inputs, executed);
        }
    } else {
        // Standard action nodes follow "next"
        if (step.next) {
            const nextStep = stepById.get(step.next);
            if (nextStep) await executeGraphNode(nextStep, stepById, runId, profile, nextPath, inputs, executed);
        }
    }
}


async function executeStep(step, runId, profile, inputs) {
  try {
    if (step.type === 'click') {
      const el = await waitForSelector(step.selector, step.timeoutMs || 8000, runId);
      el.click();
      log('info', `Đã click: ${step.name}`, runId);
      return { ok: true };
    }
    if (step.type === 'type') {
      const el = await waitForSelector(step.selector, step.timeoutMs || 8000, runId);
      el.focus();
      const isSecret = /password|token|secret|otp|pin/i.test(`${step.selector || ''} ${step.name || ''}`);
      if (isSecret && !step.recordSecret) throw new Error('Từ chối nhập thông tin mật nếu không bật recordSecret');
      el.value = step.text || '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      log('info', `Đã nhập: ${step.name}`, runId);
      return { ok: true };
    }
    
    if (step.type === 'navigate') {
      log('info', `Chuyển hướng: ${step.url}`, runId);
      const url = new URL(step.url, location.href);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Chỉ cho phép điều hướng HTTP/HTTPS');
      return { ok: true, navigating: true, url: url.href };
    }
    if (step.type === 'switchTab') {
      const result = await chrome.runtime.sendMessage({
        type: 'WAR_SWITCH_TAB',
        tabName: step.tabName,
        runId,
        profile,
        inputs,
        startIds: step.next ? [step.next] : [],
        sourceUrl: location.href,
        sourceTitle: document.title
      });
      if (!result?.ok) throw new Error(result?.error || `Không thể chuyển tab: ${step.tabName}`);
      log('info', `Yêu cầu chuyển tab: ${step.tabName}`, runId);
      return result.handedOff ? { ok: true, handedOff: true, tabId: result.tabId } : { ok: true };
    }
    if (['OR', 'AND', 'IFS'].includes(step.type)) {
      log('info', `Xử lý ${step.type}`, runId);
      return { ok: true };
    }

    if (step.type === 'condition') {
      const matched = evaluateCondition(step.condition || {});
      log('info', `Điều kiện ${matched ? 'đúng' : 'sai'}: ${step.name}`, runId);
      return { ok: true, matched };
    }
    if (step.type === 'log') {
      log('info', step.message || step.name || 'Bước ghi log', runId);
      return { ok: true };
    }
    throw new Error(`Loại bước không hỗ trợ: ${step.type}`);
  } catch (error) {
    log('error', `${step.name || step.type}: ${error.message}`, runId);
    return { ok: false, error: error.message };
  }
}


function evaluateCondition(condition) {
  if (condition.kind === 'domain') return match(location.hostname, condition.operator, condition.value);
  if (condition.kind === 'selector') return Boolean(document.querySelector(condition.selector));
  if (condition.kind === 'text') {
    const el = condition.selector ? document.querySelector(condition.selector) : document.body;
    return match(textOf(el), condition.operator, condition.value);
  }
  return false;
}


function match(actual, operator = 'contains', expected = '') {
  const a = String(actual || '');
  const e = String(expected || '');
  if (operator === 'equals') return a === e;
  if (operator === 'matches') return wildcardToRegExp(e).test(a);
  if (operator === '>') return Number(a) > Number(e);
  if (operator === '<') return Number(a) < Number(e);
  if (operator === '>=') return Number(a) >= Number(e);
  if (operator === '<=') return Number(a) <= Number(e);
  if (operator === '!=') return a !== e;
  return a.toLowerCase().includes(e.replaceAll('*', '').toLowerCase());
}

function wildcardToRegExp(pattern) {
  const escaped = String(pattern || '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function waitForSelector(selector, timeoutMs, runId) {
  return new Promise((resolve, reject) => {
    if (!activeRuns.has(runId)) return reject(new Error('Run stopped'));
    const found = document.querySelector(selector);
    if (found) return resolve(found);
    let timer = null;
    let stopCheck = null;
    const observer = new MutationObserver(() => {
      if (!activeRuns.has(runId)) {
        observer.disconnect();
        clearTimeout(timer);
        clearInterval(stopCheck);
        reject(new Error('Run stopped'));
        return;
      }
      const el = document.querySelector(selector);
      if (el) { observer.disconnect(); clearTimeout(timer); clearInterval(stopCheck); resolve(el); }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    stopCheck = setInterval(() => {
      if (!activeRuns.has(runId)) {
        observer.disconnect();
        clearTimeout(timer);
        clearInterval(stopCheck);
        reject(new Error('Run stopped'));
      }
    }, 100);
    timer = setTimeout(() => { observer.disconnect(); clearInterval(stopCheck); reject(new Error(`Không tìm thấy phần tử: ${selector}`)); }, timeoutMs);
  });
}

function bestSelector(el) {
  if (!el || el === document.body) return 'body';
  if (el.id) return `#${CSS.escape(el.id)}`;
  const attr = ['name', 'aria-label', 'placeholder', 'data-testid'].find((name) => el.getAttribute(name));
  if (attr) return `${el.tagName.toLowerCase()}[${attr}="${cssAttr(el.getAttribute(attr))}"]`;
  const cls = [...el.classList].slice(0, 2).map((c) => `.${CSS.escape(c)}`).join('');
  return `${el.tagName.toLowerCase()}${cls}`;
}

function isSecretElement(el) {
  return el?.type === 'password' || /password|passwd|passcode|token|secret|otp|2fa|mfa|pin|cvv|credit.?card|api.?key/i.test(
    `${el?.name || ''} ${el?.id || ''} ${el?.placeholder || ''} ${el?.getAttribute?.('aria-label') || ''}`
  );
}

function cssAttr(value) { return String(value).replaceAll('"', '\\"'); }
function labelFor(el) { return (el?.innerText || el?.value || el?.getAttribute?.('aria-label') || el?.tagName || 'phần tử').trim().slice(0, 40); }
function textOf(el) { return el ? (el.innerText || el.value || el.textContent || '') : ''; }
function resolveStepTemplates(step, inputs = {}) {
  const next = { ...step };
  for (const key of ['selector', 'text', 'url', 'message', 'tabName']) {
    if (typeof next[key] === 'string') next[key] = resolveTemplate(next[key], inputs);
  }
  if (next.condition) next.condition = resolveConditionTemplate(next.condition, inputs);
  if (Array.isArray(next.conditions)) next.conditions = next.conditions.map((condition) => resolveConditionTemplate(condition, inputs));
  return next;
}
function resolveConditionTemplate(condition, inputs = {}) {
  const next = { ...condition };
  for (const key of ['selector', 'value']) {
    if (typeof next[key] === 'string') next[key] = resolveTemplate(next[key], inputs);
  }
  return next;
}
function resolveTemplate(value, inputs = {}) {
  return String(value).replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => {
    if (!Object.prototype.hasOwnProperty.call(inputs, key)) throw new Error(`Missing input: ${key}`);
    return String(inputs[key] ?? '');
  });
}
function delay(ms, runId) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (!activeRuns.has(runId) || Date.now() - started >= Math.max(0, ms)) return resolve();
      setTimeout(tick, Math.min(100, Math.max(0, ms)));
    };
    tick();
  });
}
function sendCaptured(item) { chrome.runtime.sendMessage({ type: 'CONTENT_CAPTURED', item }); toast(`Đã ghi: ${item.name || item.type}`); }
function log(level, message, runId) { chrome.runtime.sendMessage({ type: 'CONTENT_LOG', entry: { level, message, runId, url: location.href } }); }
function toast(message) {
  const box = document.createElement('div');
  box.textContent = message;
  box.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;background:#172033;color:white;padding:12px 16px;border-radius:8px;font:14px system-ui;box-shadow:0 8px 24px #0005;';
  document.documentElement.appendChild(box);
  setTimeout(() => box.remove(), 3500);
}
