import { applyLinksToSteps, findRootStepIds } from '../src/graph.js';

export class NodeEditor {
  constructor(containerId, onStateChange, onPickElement) {
    this.container = document.getElementById(containerId);
    this.onStateChange = onStateChange;
    this.onPickElement = onPickElement;
    
    this.nodes = [];
    this.links = []; 
    
    this.panX = 0;
    this.panY = 0;
    this.scale = 1;
    this.isDragging = false;
    this.dragType = null; // 'pan', 'node', 'link'
    this.dragTarget = null;
    this.startX = 0;
    this.startY = 0;
    this.currentLinkSource = null;
    this.selectedLinkSource = null;
    this.linkRenderFrame = null;
    this.rootIds = new Set();
    
    this.initDOM();
    this.bindEvents();
    this.render();
    this.discoverRoots();
  }

  initDOM() {
    this.container.innerHTML = `
      <div class="canvas-wrapper" style="position:relative; width:100%; height:100%; min-height:300px; overflow:hidden; background:var(--bg); border: 1px solid var(--border); border-radius: 8px;">
        <div class="canvas-plane" style="position:absolute; top:0; left:0; width:0; height:0; transform-origin: 0 0;">
          <svg class="canvas-svg" style="position:absolute; top:-5000px; left:-5000px; width:10000px; height:10000px; overflow:visible; pointer-events:none;">
             <defs>
               <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                 <path d="M 0 0 L 10 5 L 0 10 z" fill="#245cff" />
               </marker>
             </defs>
             <g class="links-layer"></g>
             <path class="temp-link" fill="none" stroke="#245cff" stroke-width="2" stroke-dasharray="5,5" marker-end="url(#arrow)" d=""></path>
          </svg>
          <div class="canvas-nodes" style="position:absolute; top:0; left:0; width: 100%; height: 100%;"></div>
        </div>
      </div>
    `;
    this.wrapper = this.container.querySelector('.canvas-wrapper');
    this.plane = this.container.querySelector('.canvas-plane');
    this.svg = this.container.querySelector('.canvas-svg');
    this.linksLayer = this.container.querySelector('.links-layer');
    this.tempLink = this.container.querySelector('.temp-link');
    this.nodesLayer = this.container.querySelector('.canvas-nodes');
  }

  loadData(steps) {
    this.nodes = [];
    this.links = [];
    let y = 50;
    let x = 50;
    
    const nodeMap = new Map();

    (steps || []).forEach((step, i) => {
      if (!step.ui) {
        step.ui = { x: x, y: y };
        x += 350;
        if (x > 1000) { x = 50; y += 250; }
      }
      this.nodes.push(step);
      nodeMap.set(step.id, step);
    });

    // rebuild links based on step.next and step.ifSteps/elseSteps / conditions
    this.nodes.forEach(step => {
       if (step.next && nodeMap.has(step.next)) {
           this.links.push({ from: step.id, fromPort: 'out', to: step.next, toPort: 'in' });
       }
       if (step.ifSteps) {
           step.ifSteps.forEach(toId => {
               if (nodeMap.has(toId)) this.links.push({ from: step.id, fromPort: 'if-out', to: toId, toPort: 'in' });
           });
       }
       if (step.elseSteps) {
           step.elseSteps.forEach(toId => {
               if (nodeMap.has(toId)) this.links.push({ from: step.id, fromPort: 'else-out', to: toId, toPort: 'in' });
           });
       }
       if (step.conditions) {
           step.conditions.forEach((c, idx) => {
               if (c.next && nodeMap.has(c.next)) {
                   this.links.push({ from: step.id, fromPort: `cond-${idx}-out`, to: c.next, toPort: 'in' });
               }
           });
       }
    });

    this.render();
    this.discoverRoots();
  }

  getData() {
    return this.syncGraphFromLinks();
  }

  updateTransform() {
    this.plane.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`;
  }

  screenToWorld(x, y) {
    const rect = this.wrapper.getBoundingClientRect();
    return {
      x: (x - rect.left - this.panX) / this.scale,
      y: (y - rect.top - this.panY) / this.scale
    };
  }

  bindEvents() {
    window.addEventListener('keydown',e=>{if(e.key==='Escape'){this.clearSelectedPort();this.cancelLinkDrag();}});
    this.wrapper.addEventListener('click', e => {
      const port=e.target.closest('.node-port');
      if(!port)return;
      e.stopPropagation();
      if(port.dataset.dir==='out') {
        this.clearSelectedPort();
        this.selectedLinkSource={nodeId:port.dataset.node,portId:port.dataset.port,el:port};
        port.classList.add('port-selected');
        return;
      }
      if(port.dataset.dir==='in' && this.selectedLinkSource && port.dataset.node!==this.selectedLinkSource.nodeId) {
        this.connectPorts(this.selectedLinkSource.nodeId,this.selectedLinkSource.portId,port.dataset.node);
        this.clearSelectedPort();
      }
    });
    this.wrapper.addEventListener('keydown', e => {
      if (!['Enter', ' '].includes(e.key)) return;
      const port=e.target.closest('.node-port');
      if(!port)return;
      e.preventDefault();
      port.click();
    });

    this.wrapper.addEventListener('mousedown', e => {
      if (e.button !== 0 && e.button !== 1) return; // only left or middle
      
      const port = e.target.closest('.node-port');
      if (port) {
        if (port.dataset.dir === 'out') {
           this.isDragging = true;
           this.dragType = 'link';
           this.currentLinkSource = { nodeId: port.dataset.node, portId: port.dataset.port, el: port };
           const wp = this.screenToWorld(e.clientX, e.clientY);
           this.updateTempLink(wp.x, wp.y);
           e.stopPropagation();
           return;
        }
      }

      const nodeHeader = e.target.closest('.node-header');
      if (nodeHeader && e.button === 0) {
         this.isDragging = true;
         this.dragType = 'node';
         this.dragTarget = this.nodes.find(n => n.id === nodeHeader.dataset.node);
         const wp = this.screenToWorld(e.clientX, e.clientY);
         this.startX = wp.x - this.dragTarget.ui.x;
         this.startY = wp.y - this.dragTarget.ui.y;
         e.stopPropagation();
         return;
      }

      // Ignore pan if clicking on an input, button or select
      if (['INPUT', 'TEXTAREA', 'BUTTON', 'SELECT'].includes(e.target.tagName)) return;

      // Pan
      this.isDragging = true;
      this.dragType = 'pan';
      this.startX = e.clientX - this.panX;
      this.startY = e.clientY - this.panY;
      this.wrapper.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', e => {
      if (!this.isDragging) return;

      if (this.dragType === 'pan') {
        this.panX = e.clientX - this.startX;
        this.panY = e.clientY - this.startY;
        this.updateTransform();
      } else if (this.dragType === 'node' && this.dragTarget) {
        const wp = this.screenToWorld(e.clientX, e.clientY);
        let nx = wp.x - this.startX;
        let ny = wp.y - this.startY;

        // Snap to grid / other nodes
        const SNAP = 20;
        this.nodes.forEach(n => {
           if (n !== this.dragTarget) {
               if (Math.abs(n.ui.x - nx) < SNAP) nx = n.ui.x;
               if (Math.abs(n.ui.y - ny) < SNAP) ny = n.ui.y;
               if (Math.abs(n.ui.y + 100 - ny) < SNAP) ny = n.ui.y + 100;
           }
        });

        this.dragTarget.ui.x = nx;
        this.dragTarget.ui.y = ny;
        this.renderNodePos(this.dragTarget);
        this.requestRenderLinks();
      } else if (this.dragType === 'link' && this.currentLinkSource) {
        const wp = this.screenToWorld(e.clientX, e.clientY);
        this.updateTempLink(wp.x, wp.y);
      }
    });

    window.addEventListener('mouseup', e => {
      if (!this.isDragging) return;
      
      if (this.dragType === 'link') {
         const port = this.findPortAt(e.clientX, e.clientY);
         if (port && port.dataset.dir === 'in' && port.dataset.node !== this.currentLinkSource.nodeId) {
            this.connectPorts(this.currentLinkSource.nodeId,this.currentLinkSource.portId,port.dataset.node);
         }
         this.tempLink.setAttribute('d', '');
      }

      if (this.dragType === 'node') {
         this.onStateChange(); // save pos
      }

      this.isDragging = false;
      this.dragType = null;
      this.dragTarget = null;
      this.currentLinkSource = null;
      this.wrapper.style.cursor = 'grab';
      this.requestRenderLinks();
    });

    this.wrapper.addEventListener('wheel', e => {
       e.preventDefault();
       const zoomIntensity = 0.001;
       const wheel = e.deltaY < 0 ? 1 : -1;
       const zoom = Math.exp(wheel * zoomIntensity * 50);
       
       const wp = this.screenToWorld(e.clientX, e.clientY);
       
       this.scale *= zoom;
       this.scale = Math.max(0.1, Math.min(this.scale, 3));
       
       this.panX = e.clientX - wp.x * this.scale - this.wrapper.getBoundingClientRect().left;
       this.panY = e.clientY - wp.y * this.scale - this.wrapper.getBoundingClientRect().top;
       
       this.updateTransform();
    }, {passive: false});

    // Delete connections
    this.wrapper.addEventListener('contextmenu', e => {
       const linkEl = e.target.closest('.canvas-link');
       if (linkEl) {
           e.preventDefault();
           const idx = parseInt(linkEl.dataset.idx);
           this.links.splice(idx, 1);
           this.requestRenderLinks();
           this.discoverRoots();
           this.onStateChange();
       }
    });

    // Node inputs
    this.nodesLayer.addEventListener('input', e => {
       if (e.target.dataset.k) {
           const node = this.nodes.find(n => n.id === e.target.dataset.node);
           if (!node) return;
           const k = e.target.dataset.k;
           const v = e.target.value;
           
           if (k.startsWith('cond-')) {
               const parts = k.split('-');
               const idx = parseInt(parts[1]);
               const field = parts[2];
               if (!node.conditions) node.conditions = [];
               if (!node.conditions[idx]) node.conditions[idx] = {};
               node.conditions[idx][field] = v;
           } else if (k.includes('.')) {
               const [a, b] = k.split('.');
               if (!node[a]) node[a] = {};
               node[a][b] = v;
           } else {
               node[k] = v;
           }
           this.onStateChange();
       }
    });
    this.nodesLayer.addEventListener('change', e => {
      if(e.target.matches('select')) e.target.dispatchEvent(new Event('input',{bubbles:true}));
    });

    this.nodesLayer.addEventListener('click', e => {
       const btn = e.target.closest('button');
       if (!btn) return;
       const node = this.nodes.find(n => n.id === btn.dataset.node);
       if (!node) return;

       if (btn.dataset.act === 'del') {
           this.nodes = this.nodes.filter(n => n.id !== node.id);
           this.links = this.links.filter(l => l.from !== node.id && l.to !== node.id);
           this.render();
           this.discoverRoots();
           this.onStateChange();
       } else if (btn.dataset.act === 'pick') {
           this.onPickElement().then(sel => {
               if (sel) {
                   if (btn.dataset.target.startsWith('cond-')) {
                       const parts = btn.dataset.target.split('-');
                       const idx = parseInt(parts[1]);
                       if(!node.conditions) node.conditions = [];
                       if(!node.conditions[idx]) node.conditions[idx] = {};
                       node.conditions[idx].selector = sel;
                   } else if (btn.dataset.target.includes('.')) {
                       const [a, b] = btn.dataset.target.split('.');
                       if (!node[a]) node[a] = {};
                       node[a][b] = sel;
                   } else {
                       node[btn.dataset.target] = sel;
                   }
                   this.render();
                   this.onStateChange();
               }
           });
       } else if (btn.dataset.act === 'add-cond') {
           if (!node.conditions) node.conditions = [];
           node.conditions.push({ kind: 'text', operator: 'contains', value: '' });
           this.render();
           this.onStateChange();
        } else if (btn.dataset.act === 'del-cond') {
           const idx = parseInt(btn.dataset.idx);
           node.conditions.splice(idx, 1);
           // remove links
           this.links = this.links.filter(l => !(l.from === node.id && l.fromPort === `cond-${idx}-out`));
           // shift link ports
           this.links.forEach(l => {
              if (l.from === node.id && l.fromPort.startsWith('cond-')) {
                 const pIdx = parseInt(l.fromPort.split('-')[1]);
                 if (pIdx > idx) l.fromPort = `cond-${pIdx-1}-out`;
              }
           });
            this.render();
            this.onStateChange();
        } else if (btn.dataset.act === 'getCurrentUrl') {
            chrome.tabs.query({active:true,currentWindow:true}).then(tabs => {
              if (!tabs[0]) return;
              node.url=tabs[0].url || '';
              this.render(); this.onStateChange();
            });
       }
    });
  }

  connectPorts(from,fromPort,to) {
    this.links=this.links.filter(link=>!(link.from===from&&link.fromPort===fromPort));
    this.links.push({from,fromPort,to,toPort:'in'});
    this.syncGraphFromLinks();
    this.discoverRoots();
    this.requestRenderLinks();
    this.onStateChange();
  }

  clearSelectedPort() {
    this.selectedLinkSource?.el?.classList.remove('port-selected');
    this.selectedLinkSource=null;
  }

  cancelLinkDrag() {
    this.isDragging = false;
    this.dragType = null;
    this.dragTarget = null;
    this.currentLinkSource = null;
    this.tempLink?.setAttribute('d', '');
    if (this.wrapper) this.wrapper.style.cursor = 'grab';
  }

  findPortAt(clientX, clientY) {
    return document.elementsFromPoint(clientX, clientY).map(el => el.closest?.('.node-port')).find(Boolean) || null;
  }

  syncGraphFromLinks() {
    this.nodes = applyLinksToSteps(this.nodes, this.links);
    return this.nodes;
  }

  discoverRoots() {
    const roots = findRootStepIds(this.syncGraphFromLinks());
    this.rootIds = new Set(roots);
    this.applyRootHighlights();
    return roots;
  }

  getRootIds() {
    return [...this.rootIds];
  }

  applyRootHighlights() {
    if (!this.nodesLayer) return;
    this.nodesLayer.querySelectorAll('.canvas-node').forEach(el => {
      const isRoot = this.rootIds.has(el.dataset.id);
      el.classList.toggle('root-node', isRoot);
      el.querySelector('.root-badge')?.remove();
      if (isRoot) {
        const badge = document.createElement('span');
        badge.className = 'root-badge';
        badge.textContent = 'Gốc';
        el.querySelector('.node-header')?.appendChild(badge);
      }
    });
  }

  updateTempLink(tx, ty) {
     if (!this.currentLinkSource) return;
     const rect = this.currentLinkSource.el.getBoundingClientRect();
     const wr = this.wrapper.getBoundingClientRect();
     const sx = (rect.left + rect.width/2 - wr.left - this.panX) / this.scale;
     const sy = (rect.top + rect.height/2 - wr.top - this.panY) / this.scale;
     this.tempLink.setAttribute('d', `M ${sx+5000} ${sy+5000} C ${sx+5000+50} ${sy+5000}, ${tx+5000-50} ${ty+5000}, ${tx+5000} ${ty+5000}`);
  }

  renderLinks() {
     if (this.linkRenderFrame) {
       cancelAnimationFrame(this.linkRenderFrame);
       this.linkRenderFrame = null;
     }
     this.linksLayer.innerHTML = '';
     const wr = this.wrapper.getBoundingClientRect();
     this.links.forEach((link, idx) => {
          const fromEl = this.nodesLayer.querySelector(`.node-port[data-node="${CSS.escape(link.from)}"][data-port="${CSS.escape(link.fromPort)}"]`);
          const toEl = this.nodesLayer.querySelector(`.node-port[data-node="${CSS.escape(link.to)}"][data-port="${CSS.escape(link.toPort)}"]`);
         if (!fromEl || !toEl) return;

         const fr = fromEl.getBoundingClientRect();
         const tr = toEl.getBoundingClientRect();
         const sx = (fr.left + fr.width/2 - wr.left - this.panX) / this.scale + 5000;
         const sy = (fr.top + fr.height/2 - wr.top - this.panY) / this.scale + 5000;
         const tx = (tr.left + tr.width/2 - wr.left - this.panX) / this.scale + 5000;
         const ty = (tr.top + tr.height/2 - wr.top - this.panY) / this.scale + 5000;

         const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
         path.setAttribute('d', `M ${sx} ${sy} C ${sx+50} ${sy}, ${tx-50} ${ty}, ${tx} ${ty}`);
         path.setAttribute('fill', 'none');
         path.setAttribute('stroke', '#245cff');
         path.setAttribute('stroke-width', '2');
         path.setAttribute('marker-end', 'url(#arrow)');
          path.setAttribute('class', 'canvas-link');
         path.setAttribute('data-idx', idx);
          path.style.cursor = 'pointer';
          path.style.pointerEvents = 'stroke';
         
         // hover effect for deletion
         path.addEventListener('mouseenter', () => path.setAttribute('stroke', '#b42318'));
         path.addEventListener('mouseleave', () => path.setAttribute('stroke', '#245cff'));

         this.linksLayer.appendChild(path);
     });
  }

  requestRenderLinks() {
     if (this.linkRenderFrame) return;
     this.linkRenderFrame = requestAnimationFrame(() => {
       this.linkRenderFrame = null;
       this.renderLinks();
     });
  }

  renderNodePos(node) {
      const el = this.nodesLayer.querySelector(`[data-id="${node.id}"]`);
      if (el) {
          el.style.transform = `translate(${node.ui.x}px, ${node.ui.y}px)`;
      }
  }

  render() {
      this.nodesLayer.innerHTML = '';
      this.nodes.forEach(node => {
          const el = document.createElement('div');
          el.className = 'canvas-node';
          el.dataset.id = node.id;
          el.style.position = 'absolute';
          el.style.transform = `translate(${node.ui.x}px, ${node.ui.y}px)`;
          el.style.background = 'var(--bg)';
          el.style.border = '1px solid var(--border)';
          el.style.borderRadius = '8px';
          el.style.width = '300px';
          el.style.boxShadow = '0 4px 6px rgba(0,0,0,0.1)';
          el.style.display = 'flex';
          el.style.flexDirection = 'column';
          
          let headerColor = '#f0f2f6';
          if (node.type === 'condition' || node.type === 'IFS' || node.type === 'OR' || node.type === 'AND') headerColor = '#e3f2fd';
          
          let content = `
            <div class="node-header" data-node="${node.id}" style="padding:8px; background:${headerColor}; border-bottom:1px solid var(--border); border-radius: 8px 8px 0 0; cursor:grab; display:flex; justify-content:space-between; align-items:center;">
              <input data-node="${node.id}" data-k="name" value="${this.esc(node.name)}" style="font-weight:bold; border:none; background:transparent; width:150px;">
              <button data-node="${node.id}" data-act="del" style="background:transparent; border:none; color:var(--danger); cursor:pointer;">✖</button>
            </div>
            <div class="node-body" style="padding: 8px; position:relative;">
              <div class="node-port in-port" data-node="${node.id}" data-port="in" data-dir="in" style="position:absolute; left:-6px; top:15px; width:12px; height:12px; background:#10b981; border-radius:50%; cursor:crosshair; border:2px solid white;" title="Cổng Vào (Xanh lá)"></div>
          `;

          if (['OR', 'AND', 'IFS'].includes(node.type)) {
              content += `<div style="font-size:12px; margin-bottom:8px;"><b>${node.type} Node</b><br>Delay: <input type="number" data-node="${node.id}" data-k="delayAfterMs" value="${node.delayAfterMs||0}" style="width:60px;"> ms</div>`;
              content += `<div class="conditions-list" style="display:flex; flex-direction:column; gap:4px;">`;
              (node.conditions || []).forEach((c, idx) => {
                  content += `
                    <div style="border:1px solid #ccc; padding:4px; border-radius:4px; position:relative; background:#fafafa;">
                       <select data-node="${node.id}" data-k="cond-${idx}-kind" style="width:100%; margin-bottom:4px; font-size:11px;">
                         ${this.opts([['domain','Tên miền'],['text','Văn bản'],['selector','Selector']], c.kind||'domain')}
                       </select>
                       <div style="display:flex; gap:4px; margin-bottom:4px;">
                         <input data-node="${node.id}" data-k="cond-${idx}-selector" value="${this.esc(c.selector||'')}" placeholder="Selector" style="flex:1; font-size:11px;">
                         <button class="pick-target" data-node="${node.id}" data-act="pick" data-target="cond-${idx}-selector" title="Chọn phần tử trên trang" style="background:#245cff; color:white;">🎯</button>
                       </div>
                       <input data-node="${node.id}" data-k="cond-${idx}-value" value="${this.esc(c.value||'')}" placeholder="Value (hỗ trợ *abc*)" style="width:100%; box-sizing:border-box; font-size:11px;">
                       <div class="node-port out-port" data-node="${node.id}" data-port="cond-${idx}-out" data-dir="out" style="position:absolute; right:-12px; top:50%; transform:translateY(-50%); width:12px; height:12px; background:#245cff; border-radius:50%; cursor:crosshair; border:2px solid white;" title="Cổng Ra (Xanh dương)"></div>
                       <button data-node="${node.id}" data-idx="${idx}" data-act="del-cond" style="position:absolute; right:2px; top:2px; font-size:10px; color:red; border:none; background:transparent;">✖</button>
                    </div>
                  `;
              });
              content += `</div><button data-node="${node.id}" data-act="add-cond" style="margin-top:8px; width:100%; font-size:11px;">➕ Thêm điều kiện</button>`;
              
              if (node.type === 'AND') {
                  content += `<div style="margin-top:8px; font-size:11px; color:var(--danger); position:relative;">Nhánh Fail (Nếu sai):
                     <div class="node-port out-port" data-node="${node.id}" data-port="else-out" data-dir="out" style="position:absolute; right:-14px; top:2px; width:12px; height:12px; background:#b42318; border-radius:50%; cursor:crosshair; border:2px solid white;" title="Fail Port"></div>
                  </div>`;
              }
          } 
          else if (node.type === 'condition') {
              // Legacy If/Else single cond
              const c = node.condition || {};
              content += `<div style="font-size:12px; margin-bottom:8px;"><b>If/Else</b><br>Delay: <input type="number" data-node="${node.id}" data-k="delayAfterMs" value="${node.delayAfterMs||0}" style="width:60px;"> ms</div>`;
              content += `
                    <div style="border:1px solid #ccc; padding:4px; border-radius:4px; position:relative; background:#fafafa;">
                       <select data-node="${node.id}" data-k="condition.kind" style="width:100%; margin-bottom:4px; font-size:11px;">
                         ${this.opts([['domain','Tên miền'],['text','Văn bản'],['selector','Selector']], c.kind||'domain')}
                       </select>
                       <select data-node="${node.id}" data-k="condition.operator" style="width:100%; margin-bottom:4px; font-size:11px;">
                         ${this.opts([['contains','Chứa'],['equals','Bằng'],['matches','Regex'],['>','>'],['<','<'],['!=','Khác']], c.operator||'contains')}
                       </select>
                       <div style="display:flex; gap:4px; margin-bottom:4px;">
                         <input data-node="${node.id}" data-k="condition.selector" value="${this.esc(c.selector||'')}" placeholder="Selector" style="flex:1; font-size:11px;">
                         <button class="pick-target" data-node="${node.id}" data-act="pick" data-target="condition.selector" title="Chọn phần tử trên trang" style="background:#245cff; color:white;">🎯</button>
                       </div>
                       <input data-node="${node.id}" data-k="condition.value" value="${this.esc(c.value||'')}" placeholder="Value" style="width:100%; box-sizing:border-box; font-size:11px;">
                    </div>
                    <div style="display:flex; justify-content:space-between; margin-top:8px;">
                      <div style="position:relative; padding-right:15px; font-size:11px; color:#10b981;">TRUE 
                        <div class="node-port out-port" data-node="${node.id}" data-port="if-out" data-dir="out" style="position:absolute; right:-8px; top:2px; width:12px; height:12px; background:#245cff; border-radius:50%; cursor:crosshair; border:2px solid white;"></div>
                      </div>
                      <div style="position:relative; padding-right:15px; font-size:11px; color:var(--danger);">FALSE 
                        <div class="node-port out-port" data-node="${node.id}" data-port="else-out" data-dir="out" style="position:absolute; right:-8px; top:2px; width:12px; height:12px; background:#b42318; border-radius:50%; cursor:crosshair; border:2px solid white;"></div>
                      </div>
                    </div>
              `;
          }
          else {
              // Action Node
              content += `<div style="font-size:12px; margin-bottom:4px;">Delay: <input type="number" data-node="${node.id}" data-k="delayAfterMs" value="${node.delayAfterMs||0}" style="width:60px;"> ms</div>`;
              if (node.type === 'click' || node.type === 'type') {
                  content += `
                     <div style="display:flex; gap:4px; margin-bottom:4px;">
                         <input data-node="${node.id}" data-k="selector" value="${this.esc(node.selector||'')}" placeholder="Selector" style="flex:1; font-size:11px;">
                         <button class="pick-target" data-node="${node.id}" data-act="pick" data-target="selector" title="Chọn phần tử trên trang" style="background:#245cff; color:white;">🎯</button>
                     </div>
                  `;
              }
              if (node.type === 'type') {
                  content += `<textarea data-node="${node.id}" data-k="text" placeholder="Text to type" style="width:100%; box-sizing:border-box; font-size:11px;">${this.esc(node.text||'')}</textarea>`;
              }
              if (node.type === 'navigate') {
                  content += `<input data-node="${node.id}" data-k="url" value="${this.esc(node.url||'')}" placeholder="URL" style="width:100%; box-sizing:border-box; font-size:11px;">`;
                  content += `<button data-node="${node.id}" data-act="getCurrentUrl" style="font-size:10px; margin-top:4px;">Lấy link hiện tại</button>`;
              }
              if (node.type === 'switchTab') {
                  content += `<input data-node="${node.id}" data-k="tabName" value="${this.esc(node.tabName||'')}" placeholder="Tab name/URL contains" style="width:100%; box-sizing:border-box; font-size:11px;">`;
              }
              if (node.type === 'log') {
                  content += `<input data-node="${node.id}" data-k="message" value="${this.esc(node.message||'')}" placeholder="Log message" style="width:100%; box-sizing:border-box; font-size:11px;">`;
              }

              // Single out port
              content += `<div class="node-port out-port" data-node="${node.id}" data-port="out" data-dir="out" style="position:absolute; right:-6px; top:50%; transform:translateY(-50%); width:12px; height:12px; background:#245cff; border-radius:50%; cursor:crosshair; border:2px solid white;" title="Cổng Ra (Xanh dương)"></div>`;
          }

          content += `</div>`; // node-body
          el.innerHTML = content;
          el.querySelectorAll('.node-port').forEach(port => {
            port.tabIndex = 0;
            port.setAttribute('role', 'button');
            port.setAttribute('aria-label', port.dataset.dir === 'in' ? 'Input port' : 'Output port');
          });
          this.nodesLayer.appendChild(el);
      });

      this.applyRootHighlights();
      // After DOM update, render links
      requestAnimationFrame(() => this.renderLinks());
  }

  opts(values, selected){
    return values.map(v=>{
      if(Array.isArray(v)) return `<option value="${this.esc(v[0])}" ${v[0]===selected?'selected':''}>${this.esc(v[1])}</option>`;
      return `<option value="${this.esc(v)}" ${v===selected?'selected':''}>${this.esc(v)}</option>`;
    }).join('');
  }

  esc(s){return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
}
