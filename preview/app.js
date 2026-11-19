"use strict";
const $=id=>document.getElementById(id);
const list=s=>[...document.querySelectorAll(s)];
const press=(b,on)=>b.setAttribute(b.getAttribute("role")==="switch"?"aria-checked":"aria-pressed",String(on));
const copy=o=>JSON.parse(JSON.stringify(o));
const bands=[50,400,800,1600,3200,6400,26000],quick=[400,800,1200,1600,2400,3200,6400],colors=["#38acba","#ae73df","#f49f60","#e57785","#66a482","#808ece"];
const names=["左鍵","右鍵","滾輪中鍵","後側鍵","前側鍵","DPI 鍵"],actions=["左鍵點擊","右鍵點擊","中鍵點擊","上一頁","下一頁","循環 DPI","提高 DPI","降低 DPI","靜音","播放／暫停","停用"];
const points=[[41,33],[59,33],[50,31],[32,48],[32,40],[50,43]],lampNames={off:"關閉",steady:"恆亮",breathing:"呼吸"};
const initial={slots:[800,1600,2400,3200,5000,26000].map((n,i)=>({x:n,y:n,color:colors[i]})),count:2,rate:500,mode:"steady",keys:actions.slice(0,6),motionSync:false,gripAngle:0,lod:1,ripple:false,snap:false,debounce:8,brightness:80,speed:5};
if (modelId !== "aj199") {
 const max = modelId === "aj179-v2-max";
 const values = max ? [400,800,1200,1600,2400,3200] : [600,800,1000,1200,1500];
 initial.slots = values.map((n,i) => ({x:n,y:n,color:colors[i]}));
 initial.count = values.length;
 if (max) Object.assign(initial,{sensorSync:false,brightness:75,speed:2});
 else Object.assign(initial,{mode:null,brightness:null,speed:null});
}
let state=copy(initial),confirmed=copy(initial),undoState=null,gesture=null,confirmTimer=0,edit=0,live=0,key=3,axis="x",follow=true,split=[false,false,false,false,false,false],last="設定會立即同步",playing=false,steps=[];
let sampleTimer;
let pendingPoint = null;
let shownPoint = null;

function formatAngle(angle) {
 return (angle > 0 ? "+" : "") + angle + "°";
}

function paintSample() {
 const dot = $("angle-pad").querySelector(".sample");
 dot.hidden = !shownPoint;
 if (!shownPoint) return;
 const radians = state.gripAngle * Math.PI / 180;
 const x = shownPoint.x * Math.cos(radians) + shownPoint.y * Math.sin(radians);
 const y = shownPoint.y * Math.cos(radians) - shownPoint.x * Math.sin(radians);
 dot.style.transform = "translate(-50%, -50%) translate(" + x + "px," + y + "px)";
}

function flushSample() {
 clearTimeout(sampleTimer);
 sampleTimer = undefined;
 shownPoint = pendingPoint;
 paintSample();
}

function previewMovement(event) {
 const rect = event.currentTarget.getBoundingClientRect();
 pendingPoint = {x:event.clientX - rect.left - rect.width / 2, y:event.clientY - rect.top - rect.height / 2};
 if (!(modelId === "aj179-v2-max" ? confirmed.sensorSync : confirmed.motionSync)) {
  flushSample();
 } else if (sampleTimer === undefined) {
  // Model report boundaries in the preview. Browser timers do not measure USB timing.
  const period = 1000 / confirmed.rate;
  sampleTimer = setTimeout(flushSample, period - performance.now() % period);
 }
}

function setGripAngle(value, startState) {
 if (!Number.isInteger(value) || value < -30 || value > 30) return;
 change("預覽握姿角度　" + formatAngle(value), () => { state.gripAngle = value; }, null, startState);
}

// The 60-degree adjustment range spans a 180-degree dial.
const dialSweep = 3;

function setupAngleDial() {
 const input = $("grip-angle");
 const dial = input.parentElement;
 const face = $("dial-face");
 const ticks = $("dial-ticks");
 for (let value = -30; value <= 30; value++) {
  const rotation = value * dialSweep;
  const major = value % 5 === 0;
  const tick = document.createElementNS(face.namespaceURI, "path");
  tick.setAttribute("d", major ? "M0 -98 v-10" : "M0 -100 v-5");
  tick.setAttribute("transform", "rotate(" + rotation + ")");
  if (major) tick.classList.add("major");
  ticks.append(tick);
  if (value % 15 === 0) {
   const radians = rotation * Math.PI / 180;
   const label = document.createElementNS(face.namespaceURI, "text");
   label.setAttribute("x", 125 * Math.sin(radians));
   label.setAttribute("y", -125 * Math.cos(radians));
   label.textContent = formatAngle(value);
   ticks.append(label);
  }
 }

 let pointerId = null;
 let startState = null;
 function updateFromPointer(event) {
  const local = new DOMPoint(event.clientX, event.clientY).matrixTransform(face.getScreenCTM().inverse());
  const aboveCenter = Math.max(0, -local.y);
  if (Math.hypot(local.x, aboveCenter) < 9) return;
  const angle = Math.atan2(local.x, aboveCenter) * 180 / Math.PI;
  setGripAngle(Math.round(angle / dialSweep), startState);
 }
 dial.onpointerdown = event => {
  if (pointerId !== null || event.button !== 0 || !event.isPrimary) return;
  event.preventDefault();
  input.focus({preventScroll:true});
  pointerId = event.pointerId;
  startState = copy(state);
  dial.setPointerCapture(pointerId);
  updateFromPointer(event);
 };
 dial.onpointermove = event => {
  if (event.pointerId === pointerId) updateFromPointer(event);
 };
 dial.onpointerup = event => {
  if (event.pointerId === pointerId) updateFromPointer(event);
 };
 dial.onlostpointercapture = event => {
  if (event.pointerId !== pointerId) return;
  pointerId = null;
  startState = null;
 };
 input.oninput = () => setGripAngle(input.valueAsNumber);
}

function renderTuning() {
 const sync = modelId === "aj179-v2-max" ? state.sensorSync : state.motionSync;
 press($("motion-sync"), sync);
 $("motion-sync").querySelector("span").textContent = sync == null ? "未提供" : sync ? "開啟" : "關閉";
 $("grip-angle").value = state.gripAngle;
 const label = formatAngle(state.gripAngle);
 $("angle-value").textContent = label;
 $("grip-angle").setAttribute("aria-valuetext", label);
 $("dial-pointer").style.transform = "rotate(" + state.gripAngle * dialSweep + "deg)";
 $("angle-pad").style.setProperty("--tilt", -state.gripAngle + "deg");
 $("angle-pad").setAttribute("aria-label", "模擬移動方向 " + label);
 $("angle-zero").disabled = state.gripAngle === 0;
 paintSample();
}

function setupTuning() {
 $("motion-sync").onclick = () => {
  if (modelId === "aj179-v2-max") {
   change("移動同步　" + (state.sensorSync ? "關閉" : "開啟"), () => {state.sensorSync = !state.sensorSync;});
   return;
  }
  const next = !state.motionSync;
  change("預覽區移動同步　" + (next ? "開啟" : "關閉"), () => { state.motionSync = next; });
 };
 setupAngleDial();
 $("angle-zero").onclick = () => setGripAngle(0);
 $("angle-pad").onpointermove = previewMovement;
 $("angle-pad").onpointerleave = () => { pendingPoint = null; flushSample(); };
}


function notify(label){$("last").textContent=label}
let confirmedLive=0;
function layoutSnapshot(){
 return {edit,live,axis,follow,split:[...split]};
}
function restoreLayout(layout){
 edit=layout.edit;live=layout.live;axis=layout.axis;follow=layout.follow;split=[...layout.split];
}
function acknowledge(){
 clearTimeout(confirmTimer);confirmTimer=0;confirmed=copy(state);confirmedLive=live;
}
function change(label,update,layout=null,startState=gesture){
 if (!simulation && (!deviceUI.snapshot || deviceUI.busy)) return;
 const before=copy(state);update();if(JSON.stringify(before)===JSON.stringify(state)){render();return}
 undoState={value:startState?copy(startState):before,layout};last=label;
 if (!simulation) { queueDeviceWrite(); render(); return; }
 if(!confirmTimer) confirmTimer=setTimeout(()=>{acknowledge();render()},120);
 render();
}
function undo(){
 if(!undoState)return;
 const previous=undoState;
 change("已復原上一步",()=>{
  state=copy(previous.value);
  if(previous.layout)restoreLayout(previous.layout);
 });
 undoState=null;render();
}
function addStage(){
 if(state.count>=initial.slots.length)return;
 const next=state.count;
 change("已新增第 "+(next+1)+" 檔",()=>{
  const saved=state.slots[next], fallback=initial.slots[next];
  state.slots[next]=simulation ? copy(fallback) : {x:saved.x??fallback.x,y:saved.y??fallback.y,color:saved.color??fallback.color};
  state.count++;
  edit=next;follow=false;split[next]=state.slots[next].x!==state.slots[next].y;axis="x";
 },layoutSnapshot());
}
function removeStage(){
 if(state.count<=1)return;
 const removed=edit;
 change("已刪除第 "+(removed+1)+" 檔",()=>{
  const lastActive=state.count-1;
  for(let i=removed;i<lastActive;i++){
   state.slots[i]=state.slots[i+1];split[i]=split[i+1];
  }
  if(simulation) state.slots[lastActive]=copy(initial.slots[lastActive]);
  else state.slots[lastActive]=copy(state.slots[lastActive]);
  split[lastActive]=false;
  state.count--;
  live=live>removed?live-1:Math.min(live,state.count-1);
  edit=Math.min(removed,state.count-1);
  if(!split[edit])axis="x";
 },layoutSnapshot());
}
function page(p){for(const b of list(".tabs button")){const selected=b.dataset.page===p;press(b,selected);$(b.dataset.page).hidden=!selected}}
function adjust(n){if(!Number.isFinite(n))return;const field=state.slots[edit],old=field[axis],next=Math.max(currentModel().step,Math.min(currentModel().maxDpi,Math.round(n/currentModel().step)*currentModel().step));change("第 "+(edit+1)+" 檔 "+(split[edit]?axis.toUpperCase()+" 軸":"DPI")+"　"+(gesture?gesture.slots[edit][axis]:old)+" → "+next,()=>{field[axis]=next;if(!split[edit])field.x=field.y=next})}
function pos(n){let i=0;while(i<5&&bands[i+1]<n)i++;return (i+(n-bands[i])/(bands[i+1]-bands[i]))*1000}
function dpi(p){const i=Math.min(5,Math.floor(p/1000));return bands[i]+(p/1000-i)*(bands[i+1]-bands[i])}
function chooseSlot(i,manual){edit=i;if(manual)follow=false;if(modelId!=="aj179-v2-max"&&state.slots[i].x!==state.slots[i].y)split[i]=true;if(!split[i])axis="x";render()}
function cycle(){if(!simulation)return;if(confirmTimer)acknowledge();live=(live+1)%state.count;confirmedLive=live;if(follow)chooseSlot(live,false);else render()}
function syncStatus(){
 if(!simulation){renderDeviceUI();return}
 keyProfiles.render();updateModelOptions();
 const busy=!!confirmTimer;$("sync-status").textContent=busy?"模擬同步中":"模擬已讀回";$("sync-status").parentElement.classList.toggle("busy",busy);notify(last);$("undo").disabled=!undoState;
}
function render(){
 const cur=confirmed.slots[confirmedLive],s=state.slots[edit];if(modelId!=="aj179-v2-max"&&s.x!==s.y)split[edit]=true;document.documentElement.style.setProperty("--led",cur.color || "#737a74");
 document.documentElement.style.setProperty("--brightness",(confirmed.brightness ?? 65)/100);document.documentElement.style.setProperty("--period",(1.1-((confirmed.speed ?? 4)-1)*.135)+"s");
 const wheel=document.querySelector(".wheel");wheel.hidden=modelId!=="aj199";wheel.className="wheel "+(!cur.color || !confirmed.mode ? "off" : confirmed.mode);
 const readout=document.querySelector(".slot-read");
 const slotId=String(confirmedLive);
 if(readout.dataset.slot!==slotId){
  if(readout.dataset.slot!==undefined && (simulation||deviceUI.snapshot)) readout.classList.add("changed");
  readout.dataset.slot=slotId;
 }
 $("live-stage").textContent="第 "+(confirmedLive+1)+" 檔使用中";$("live-light").textContent="· 滾輪燈"+(lampNames[confirmed.mode] ?? "未提供");document.querySelector(".slot-read i").style.background=confirmed.mode==="off"?"transparent":cur.color;
 $("live-x").textContent=cur.x;$("live-y").textContent=cur.y;$("live-rate").textContent=confirmed.rate;
 press($("follow"),follow);$("stage-count").textContent=state.count+" / "+Math.max(state.count,currentModel().stages)+" 檔";
 $("add-stage").disabled=state.count===initial.slots.length;
 $("remove-stage").disabled=state.count===1;
 $("remove-stage").querySelector("span").textContent="刪除第 "+(edit+1)+" 檔";$("editing").textContent="編輯第 "+(edit+1)+" 檔";
 for(const [i,b] of list("#stage-list button").entries()){
  const visible=i<state.count || (!simulation && i===confirmedLive && i<state.slots.length);
  b.hidden=!visible;
  if(!visible)continue;
  press(b,i===edit);b.style.setProperty("--dot",state.slots[i].color || "transparent");b.querySelector("em").textContent=i===live?"使用中":i===edit?"編輯中":"";
  const st=state.slots[i];
  b.querySelector(".stage-dpi").textContent=st.x===st.y?st.x:st.x+" × "+st.y;
 }
 list("#axes-mode button").forEach(b=>press(b,(b.value==="split")===split[edit]));
 for(const a of ["x","y"]){
  const row=$("axis-"+a), number=$("num-"+a), slider=$("slider-"+a), choice=$("which-"+a);
  const linked=a==="y"&&!split[edit];
  row.disabled=linked;
  choice.querySelector("span").textContent=linked?"連動":"DPI";
  if(document.activeElement!==number || number.dataset.typing!==String(edit)){
   delete number.dataset.typing; number.value=s[a];
  }
  const position=pos(s[a]);
  slider.value=position;
  slider.setAttribute("aria-valuetext",s[a]+" DPI");
  press(choice,axis===a);
  row.style.setProperty("--pos",position/60+"%");
 }
 $("preset-label").textContent=split[edit]?axis.toUpperCase()+" 軸快選":"常用 DPI";list("#presets button").forEach(b=>press(b,+b.value===s[axis]));$("color").value=s.color || "#000000";$("color").title=s.color?.toUpperCase() || "裝置未回報燈色";
 list("#rate button").forEach(b=>press(b,+b.value===state.rate));list("#modes button").forEach(b=>press(b,b.value===state.mode));
 for(let i=0;i<6;i++){press($("hot-"+i),key===i);press($("key-"+i),key===i);$("key-"+i).querySelector("small").textContent=state.keys[i] ?? "其他指派"}
 $("action-label").textContent=names[key]+"的功能";$("key-action").value=state.keys[key] ?? "";for(const opt of $("key-action").options)opt.disabled=!opt.value || opt.value!=="左鍵點擊"&&state.keys[key]==="左鍵點擊"&&state.keys.filter(v=>v==="左鍵點擊").length===1;
 list("#lod button").forEach(b=>press(b,+b.value===state.lod));for(const k of ["ripple","snap"]){press($(k),state[k]);$(k).querySelector("span").textContent=state[k]?"開啟":"關閉"}
 renderTuning();
 $("debounce").value=state.debounce ?? "";$("brightness").value=state.brightness;$("brightness").disabled=state.mode==="off";$("bright-value").textContent=(state.brightness==null?"—":state.brightness+"%");$("speed").value=state.speed ?? "";$("speed").disabled=state.mode!=="breathing";syncStatus()
}
for(let i=0;i<8;i++){
 const b=document.createElement("button");b.className="stage";b.innerHTML="<i></i><b>第 "+(i+1)+" 檔</b><em></em><small><span class='stage-dpi'></span> <span class='stage-unit'>DPI</span></small>";b.onclick=()=>chooseSlot(i,true);$("stage-list").append(b);
 if(i>=6) continue;
 const k=document.createElement("button");k.id="key-"+i;k.innerHTML="<i>"+(i+1)+"</i><strong>"+names[i]+"</strong><small></small>";k.onclick=()=>{key=i;render()};$("key-list").append(k);
 const dot=document.createElement("button");dot.id="hot-"+i;dot.className="hotspot";dot.textContent=i+1;dot.ariaLabel=names[i];dot.style.left=points[i][0]+"%";dot.style.top=points[i][1]+"%";dot.onclick=k.onclick;$("hotspots").append(dot)
}
actions.forEach(a=>$("key-action").add(new Option(a,a)));$("key-action").onchange=e=>change(names[key]+" → "+e.target.value,()=>state.keys[key]=e.target.value);
for(const a of ["x","y"]){
 const el=document.createElement("fieldset");el.id="axis-"+a;el.className="axis";el.setAttribute("aria-label",a.toUpperCase()+" 軸 DPI");
 el.innerHTML='<button class="which" id="which-'+a+'">'+a.toUpperCase()+'<span>DPI</span></button><div class="track"><span class="rail"><i></i></span><input id="slider-'+a+'" type="range" min="0" max="6000" step="1" aria-label="'+a.toUpperCase()+' 軸 DPI"><div class="ticks" aria-hidden="true">'+bands.map(n=>'<span>'+n+'</span>').join('')+'</div></div><div class="stepper"><button data-step="-50" aria-label="減少 50 DPI">−</button><input type="number" min="50" max="26000" step="50" id="num-'+a+'" aria-label="'+a.toUpperCase()+' 軸精確 DPI"><button data-step="50" aria-label="增加 50 DPI">＋</button></div>';
 $("axes").append(el);$("which-"+a).onclick=()=>{axis=a;render()};const slider=$("slider-"+a),num=$("num-"+a);slider.oninput=()=>{axis=a;adjust(dpi(+slider.value))};
 slider.onkeydown=e=>{if(["ArrowLeft","ArrowDown","ArrowRight","ArrowUp"].includes(e.key)){e.preventDefault();axis=a;adjust(state.slots[edit][a]+(["ArrowLeft","ArrowDown"].includes(e.key)?-currentModel().step:currentModel().step))}};
 for(const step of el.querySelectorAll("[data-step]")){step.title=(step.dataset.step==="50"?"增加":"減少")+" 50 DPI";step.onclick=()=>{axis=a;adjust(state.slots[edit][a]+Number(step.dataset.step))}};
 let timer;num.oninput=()=>{num.dataset.typing=String(edit);clearTimeout(timer);const slot=edit,n=num.valueAsNumber;if(num.value!==""&&num.checkValidity())timer=setTimeout(()=>{if(edit===slot && num.dataset.typing===String(slot)){axis=a;adjust(n)}},320)};
 num.onchange=()=>{const source=num.dataset.typing;delete num.dataset.typing;clearTimeout(timer);if(source===String(edit)&&num.value!==""&&num.checkValidity()){axis=a;adjust(num.valueAsNumber)}else render()};num.onblur=()=>{delete num.dataset.typing;render()};num.onkeydown=e=>{if(e.key==="Enter")num.blur()};
 slider.onpointerdown=()=>{axis=a;gesture=copy(state)};slider.onfocus=num.onfocus=()=>{if(axis!==a){axis=a;render()}}
}
for(const n of quick){const b=document.createElement("button");b.value=n;b.textContent=n;b.onclick=()=>adjust(n);$("presets").append(b)}
const clearGesture=()=>{
 gesture=null;
 if(!simulation && deviceUI.pending) queueDeviceWrite();
 else if(!simulation && deviceUI.queuedRead && !deviceUI.busy){
  deviceUI.queuedRead=false;
  scheduleDeviceRead(90);
 }
};window.addEventListener("pointerup",clearGesture);window.addEventListener("pointercancel",clearGesture);
list(".tabs button").forEach(b=>b.onclick=()=>page(b.dataset.page));$("follow").onclick=()=>{follow=!follow;if(follow)chooseSlot(live,false);else render()};$("cycle").onclick=cycle;
$("add-stage").onclick=addStage;$("remove-stage").onclick=removeStage;
list("#axes-mode button").forEach(b=>b.onclick=()=>{split[edit]=b.value==="split";if(!split[edit]){axis="x";change("第 "+(edit+1)+" 檔 X/Y 同步",()=>state.slots[edit].y=state.slots[edit].x)}render()});
function handleGroup(id,fn){list("#"+id+" button").forEach(b=>b.onclick=()=>fn(b.value))}
handleGroup("rate",v=>change("回報率　"+state.rate+" → "+v+" Hz",()=>state.rate=+v));handleGroup("modes",v=>change($("led-title").textContent+"　"+lampNames[v],()=>state.mode=v));$("color").oninput=e=>change("第 "+(edit+1)+" 檔燈色　"+e.target.value.toUpperCase(),()=>state.slots[edit].color=e.target.value);
handleGroup("lod",v=>change("抬升高度　"+v+" mm",()=>state.lod=+v));for(const k of ["snap","ripple"])$(k).onclick=()=>change((k==="snap"?"直線修正":"波紋控制")+"　"+(state[k]?"關閉":"開啟"),()=>state[k]=!state[k]);
$("debounce").onchange=e=>{const n=e.target.valueAsNumber;if(Number.isInteger(n)&&n>=0&&n<=currentModel().debounce)change("按鍵去抖　"+n+" ms",()=>state.debounce=n);else render()};
$("brightness").onpointerdown=()=>gesture=copy(state);$("brightness").oninput=e=>change("亮度　"+e.target.value+"%",()=>state.brightness=+e.target.value);$("speed").onchange=e=>change("呼吸速度　"+e.target.selectedOptions[0].textContent,()=>state.speed=Number(e.target.value));$("undo").onclick=undo;
function stop(){steps.forEach(clearTimeout);steps=[];playing=false;$("play").textContent="▷ 播放操作示範"}
function demo(){if(playing){stop();return}playing=true;$("play").textContent="■ 停止示範";clearTimeout(confirmTimer);confirmTimer=0;state=copy(initial);confirmed=copy(initial);undoState=null;last="設定會立即同步";edit=live=confirmedLive=0;axis="x";follow=true;split.fill(false);page("common");render();
 const step=(ms,fn)=>steps.push(setTimeout(fn,ms));step(820,()=>adjust(1200));step(2000,cycle);step(2850,()=>{if(modelId!=="aj179-v2-max"){split[edit]=true;axis="y"}adjust(2400)});if(modelId!=="aj179-pro")step(4000,()=>$("modes").querySelector('[value="breathing"]').click());if(modelId!=="aj179-pro")step(6150,()=>$("modes").querySelector('[value="off"]').click());step(7350,stop)}
$("play").onclick=demo;document.addEventListener("pointerdown",e=>{if(playing&&!e.target.closest("#play"))stop()},true);document.addEventListener("keydown",e=>{if(playing&&e.key!=="Tab"&&!e.target.closest("#play"))stop()},true);
document.querySelector(".slot-read").addEventListener("animationend",event=>event.currentTarget.classList.remove("changed"));
document.body.classList.toggle("disconnected", !simulation);
keyProfiles.setup();setupDeviceUI();setupTuning();page(simulation && modelId==="aj199"?"advanced":"common");render();
