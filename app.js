import { renderComputerVision, wireComputerVisionControls } from "./src/computerVision.js";
import { renderConductorPanel, wireConductorPanelControls, cleanupConductorPanel } from "./src/conductorPanel.js";
/* SMART ST Control Center fleet monitoring and inspection dashboard. */
const pageNames = ["Overview Dashboard","Live Bus Monitoring","Computer Vision Monitoring","Conductor Panel","Mismatch Alerts","Bus & Route Management","Passenger Analytics","Checker Dispatch","Inspection History","Reports & Analytics","Settings"];
const routes = ["Pune – Mumbai","Pune – Nashik","Pune – Kolhapur","Pune – Satara","Pune – Solapur","Mumbai – Nashik"];
const buses = [
  {id:"MH-12-QW-4821",fleet:"ST-1042",route:routes[0],depot:"Swargate",capacity:52,operator:"A. Jadhav",passengers:46,tickets:44,mismatch:2,occupancy:88,status:"Mismatch Detected",stop:"Lonavala",next:"Khandala",updated:"2 min ago"},
  {id:"MH-14-BT-1906",fleet:"ST-0871",route:routes[1],depot:"Shivajinagar",capacity:52,operator:"S. Pawar",passengers:38,tickets:38,mismatch:0,occupancy:73,status:"Normal",stop:"Sangamner",next:"Sinnar",updated:"4 min ago"},
  {id:"MH-09-CV-3372",fleet:"ST-1208",route:routes[2],depot:"Swargate",capacity:52,operator:"R. Shinde",passengers:49,tickets:45,mismatch:4,occupancy:94,status:"Inspection Pending",stop:"Karad",next:"Umbraj",updated:"1 min ago"},
  {id:"MH-12-LM-6510",fleet:"ST-0644",route:routes[3],depot:"Katraj",capacity:52,operator:"P. More",passengers:31,tickets:31,mismatch:0,occupancy:60,status:"Normal",stop:"Shirwal",next:"Wathar",updated:"6 min ago"},
  {id:"MH-11-AX-2208",fleet:"ST-0955",route:routes[4],depot:"Hadapsar",capacity:52,operator:"N. Bhosale",passengers:43,tickets:41,mismatch:2,occupancy:83,status:"Mismatch Detected",stop:"Indapur",next:"Tembhurni",updated:"3 min ago"},
  {id:"MH-01-CD-7834",fleet:"ST-1320",route:routes[5],depot:"Mumbai Central",capacity:52,operator:"M. Chavan",passengers:27,tickets:27,mismatch:0,occupancy:52,status:"Normal",stop:"Igatpuri",next:"Kasara",updated:"8 min ago"},
  {id:"MH-12-JK-9083",fleet:"ST-0712",route:routes[0],depot:"Swargate",capacity:52,operator:"V. Koli",passengers:51,tickets:47,mismatch:4,occupancy:98,status:"Inspection Pending",stop:"Khopoli",next:"Panvel",updated:"1 min ago"},
  {id:"MH-15-GH-4417",fleet:"ST-1106",route:routes[1],depot:"Nashik Road",capacity:52,operator:"D. Pawar",passengers:35,tickets:35,mismatch:0,occupancy:67,status:"Normal",stop:"Ozar",next:"Nashik CBS",updated:"5 min ago"}
];
let alerts = [];
let alertsPollingInterval = null;
let alertsLoaded = false;
let comparisons = [];
let comparisonsLoaded = false;
let comparisonsLoading = false;
let comparisonsError = "";
let comparisonTolerance = 2;
let comparisonsPollingInterval = null;
const COMPARISONS_POLL_MS = 5000;
let inspections = [];
let checkers = [];
let fleetBuses = [];
let analyticsData = null;
let analyticsDays = 7;
let analyticsRoute = "";
let analyticsError = "";
let analyticsLoading = false;
let reportDays = 7;
let reportRoute = "";
let dispatchLoaded = false;
let currentPage="Overview Dashboard", selectedBus=null, globalQuery="", sidebarCollapsed=false;
const settings={adminName:"Admin",adminEmail:"admin@smartst.demo",fleetOverview:true,compactTables:false,demoLabels:true,mismatchThreshold:"2 passengers",highThreshold:"4 passengers",highAlerts:true,assignmentUpdates:true,dailySummary:false,theme:"Light",time24:false};
const $ = (s,root=document)=>root.querySelector(s);
const esc = value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const statusClass = value => {
  const text=String(value??"");
  if (/No Mismatch Found|Mismatch Confirmed/i.test(text)) return "status-normal";
  if (/Mismatch|Attention/i.test(text)) return "status-mismatch";
  if (/\bMatch\b|Within tolerance|Normal|Available|On track/i.test(text)) return "status-normal";
  if (/Stale|Unavailable|Offline|Pending|inspection|No camera/i.test(text)) return "status-pending";
  if (/Review/i.test(text)) return "status-reviewed";
  if (/Resolved/i.test(text)) return "status-resolved";
  return "status-reviewed";
};
const badge = text=>`<span class="status ${statusClass(text)}">${esc(text)}</span>`;
const title = (name,desc,actions="",tag="DEMO DATA")=>`<div class="page-heading"><div><h1>${esc(name)}</h1><p>${desc}</p></div><div class="heading-actions"><span class="demo-tag">${esc(tag)}</span>${actions}</div></div>`;
const kpi=(label,value,icon,note,tone="")=>`<article class="kpi-card"><div class="kpi-top"><span class="kpi-label">${label}</span><span class="kpi-icon ${tone}">${icon}</span></div><div class="kpi-value">${value}</div><div class="kpi-foot">${note}</div></article>`;
const progress=(amount,label=true)=>`<div class="occupancy"><div class="progress"><i class="${amount>90?"high":amount>75?"medium":""}" style="width:${Math.max(0,Math.min(100,Number(amount)||0))}%"></i></div>${label?`<span>${Math.round(Number(amount)||0)}%</span>`:""}</div>`;
const busTable=(rows,short=false)=>`<div class="fleet-table-wrap"><table class="fleet-table"><thead><tr><th>Bus number</th><th>Route</th><th>Current stop</th><th>Passengers</th><th>Tickets</th><th>Mismatch</th><th>Occupancy</th><th>Status</th><th>Updated</th></tr></thead><tbody>${rows.length?rows.slice(0,short?5:100).map(b=>`<tr data-bus-row="${esc(b.id)}"><td class="bus-id"><button class="btn-text" data-action="bus-detail" data-id="${esc(b.id)}">${esc(b.id)}</button></td><td class="route-name">${esc(b.route)}</td><td>${esc(b.stop)}</td><td>${b.passengers}</td><td>${b.tickets}</td><td class="${b.mismatch?"number-bad":""}">${b.mismatch||"—"}</td><td>${progress(b.occupancy)}</td><td>${badge(b.status)}</td><td class="subtle">${esc(b.updated)}</td></tr>`).join(""):`<tr><td colspan="9"><div class="empty-state"><strong>No buses found</strong>Try adjusting your search or filters.</div></td></tr>`}</tbody></table></div>`;
const num=value=>Number(value||0);
const fmtNumber=value=>num(value).toLocaleString("en-IN");
const fmtCurrency=value=>`₹${fmtNumber(Math.round(num(value)))}`;
const fmtPercent=(part,total)=>total?`${Math.round(num(part)/num(total)*100)}%`:"0%";
const dayKey=value=>{
  if(!value) return "";
  const d=new Date(value);
  if(Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
};
const dayRange=days=>Array.from({length:Math.max(1,Number(days)||1)},(_,offset)=>{
  const date=new Date();
  date.setHours(0,0,0,0);
  date.setDate(date.getDate()-(Math.max(1,Number(days)||1)-1-offset));
  return date;
});
const inDayRange=(value,days)=>{
  if(!value) return false;
  const keys=new Set(dayRange(days).map(dayKey));
  return keys.has(dayKey(value));
};
function downloadCsv(filename,rows){
  const csv=rows.map(row=>row.map(value=>`"${String(value??"").replaceAll('"','""')}"`).join(",")).join("\r\n");
  const link=document.createElement("a");
  link.href=URL.createObjectURL(new Blob([`\uFEFF${csv}`],{type:"text/csv;charset=utf-8"}));
  link.download=filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}
function statsStrip(items){return `<div class="stats-strip">${items.map(item=>`<div class="stats-strip-item"><span>${esc(item[0])}</span><strong class="${item[2]||""}">${item[1]}</strong></div>`).join("")}</div>`}
function sparkBars(values,labels,tone="blue",valueLabel="count"){
  const clean=values.map(value=>Math.max(0,num(value)));
  const max=Math.max(1,...clean);
  return `<div class="spark-bars">${clean.map((value,index)=>`<div class="spark-bar-col" title="${esc(labels[index]||"")}: ${value} ${esc(valueLabel)}"><span class="spark-bar-value">${value}</span><i class="spark-bar ${tone}" style="height:${Math.max(3,Math.round(value/max*100))}%"></i><small>${esc(labels[index]||"")}</small></div>`).join("")}</div>`;
}

function lineChart(seriesA,seriesB,labels,legendA,legendB){
  const safeA=Array.isArray(seriesA)?seriesA.map(num):[];
  const safeB=Array.isArray(seriesB)?seriesB.map(num):[];
  const safeLabels=Array.isArray(labels)?labels:[];
  if(!safeLabels.length){return `<div class="chart-empty">No trend data is available for this period.</div>`}
  const w=520,h=190,pad={l:28,r:12,t:10,b:27},cw=w-pad.l-pad.r,ch=h-pad.t-pad.b;
  const max=Math.ceil(Math.max(0,...safeA,...safeB)/5)*5||10;
  const x=i=>pad.l+(safeLabels.length===1?cw/2:i*cw/(safeLabels.length-1));
  const y=v=>pad.t+ch-(num(v)/max)*ch;
  const points=a=>a.map((v,i)=>`${x(i)},${y(v)}`).join(" ");
  const circles=a=>a.map((v,i)=>`<circle class="chart-dot" cx="${x(i)}" cy="${y(v)}" r="3"/>`).join("");
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(legendA)} and ${esc(legendB)} trend chart">${[0,1,2,3].map(i=>{const gy=pad.t+ch*i/3;return `<line class="chart-gridline" x1="${pad.l}" x2="${w-pad.r}" y1="${gy}" y2="${gy}"/><text class="chart-label" x="1" y="${gy+3}">${Math.round(max*(1-i/3))}</text>`}).join("")}${safeLabels.map((label,i)=>`<text class="chart-label" text-anchor="middle" x="${x(i)}" y="${h-5}">${esc(label)}</text>`).join("")}<polyline class="chart-line" points="${points(safeA)}"/>${circles(safeA)}<polyline class="chart-line secondary" points="${points(safeB)}"/>${circles(safeB).replaceAll("chart-dot", "chart-dot teal")}</svg><div class="chart-legend"><span class="legend-item"><i class="legend-dot"></i>${esc(legendA)}</span><span class="legend-item"><i class="legend-dot teal"></i>${esc(legendB)}</span></div>`;
}
function formatAlertTime(isoString){
  if(!isoString) return "";
  try{
    const d = new Date(isoString);
    return d.toLocaleTimeString("en-IN", {hour:"2-digit", minute:"2-digit", hour12:true});
  }catch(e){
    return isoString;
  }
}

function formatDateTime(value){
  if(!value) return "—";
  try{
    return new Date(value).toLocaleString("en-IN", {day:"2-digit", month:"short", hour:"2-digit", minute:"2-digit"});
  }catch(e){
    return value;
  }
}

async function apiRequest(path, options={}){
  const headers={...(options.body?{"Content-Type":"application/json"}:{}),...(options.headers||{})};
  const response=await fetch(path,{cache:"no-store",...options,headers});
  let data={};
  try{data=await response.json()}catch(e){}
  if(!response.ok) throw new Error(data.detail||data.message||`Request failed (${response.status})`);
  return data;
}

function normalizeAlert(alert){
  const reported=Number(alert.reported_passengers ?? alert.reported ?? 0);
  const expected=alert.expected_onboard==null?null:Number(alert.expected_onboard);
  const difference=Number(alert.difference ?? alert.reported_difference ?? 0);
  const mismatch=Math.abs(difference)||Math.abs(reported-(expected??reported));
  return {
    id:alert.alert_code||`ALT-${alert.id}`,
    dbId:alert.id,
    bus:alert.bus_id||alert.bus||"",
    route:alert.route||"",
    tripId:alert.trip_id||"",
    passengers:reported,
    tickets:expected??Math.max(0,reported-mismatch),
    mismatch,
    difference,
    time:formatAlertTime(alert.created_at),
    createdAt:alert.created_at||"",
    severity:alert.severity||(mismatch>=4?"High":mismatch>=2?"Medium":"Low"),
    status:alert.status||"New",
    stop:alert.checkpoint||alert.stop||"",
    dispatch:alert.dispatch||null
  };
}

async function loadAlerts(){
  const data=await apiRequest("/api/alerts?limit=200");
  alerts=(data.alerts||[]).map(normalizeAlert);
  alertsLoaded=true;
  updateAlertNavCount();
  return alerts;
}

async function loadComparisons(){
  comparisonsLoading=true;
  try{
    const data=await apiRequest("/api/comparisons/active-trips");
    comparisonTolerance=Number(data.tolerance??2);
    comparisons=(data.comparisons||[]).map(row=>({
      ...row,
      expected:Number(row.expected_passengers||0),
      detected:row.detected_passengers==null?null:Number(row.detected_passengers),
      difference:row.difference==null?null:Number(row.difference),
      tolerance:Number(row.tolerance??0)
    }));
    comparisonsLoaded=true;
    comparisonsError="";
    return comparisons;
  }catch(error){
    comparisonsError=error.message||"Active trip comparisons could not be loaded.";
    throw error;
  }finally{
    comparisonsLoading=false;
  }
}

function comparisonRows(){
  if(comparisonsLoading&&!comparisonsLoaded){
    return `<tr><td colspan="10"><div class="empty-state"><strong>Loading active trip comparisons…</strong>Reading ETM totals and the latest camera count.</div></td></tr>`;
  }
  if(comparisonsError){
    return `<tr><td colspan="10"><div class="empty-state"><strong>Comparisons unavailable</strong>${esc(comparisonsError)}</div></td></tr>`;
  }
  if(!comparisons.length){
    return `<tr><td colspan="10"><div class="empty-state"><strong>No active trips</strong>Start a trip in the Conductor Panel to compare ETM totals with the camera count.</div></td></tr>`;
  }
  return comparisons.map(row=>{
    const difference=row.difference;
    const differenceText=difference==null?"—":`${difference>0?"+":""}${difference}`;
    const updated=row.camera_updated_at||row.expected_updated_at;
    const status=String(row.camera_status||"unavailable");
    const cameraNote=status==="connected"?"Live":status==="stale"?"Stale":status.replaceAll("_"," ");
    const cameraTone=status==="connected"?"status-normal":status==="stale"?"status-pending":"status-mismatch";
    return `<tr class="${row.is_mismatch?"row-warning":""}">
      <td class="bus-id">${esc(row.bus_id)}</td>
      <td class="route-name">${esc(row.route||"—")}</td>
      <td class="subtle">${esc(row.trip_id||"—")}</td>
      <td>${fmtNumber(row.expected)}</td>
      <td>${row.detected==null?"—":fmtNumber(row.detected)}</td>
      <td class="${row.is_mismatch?"number-bad":difference?"number-warn":""}">${differenceText}</td>
      <td>±${row.tolerance}</td>
      <td><span class="status ${cameraTone}">${esc(cameraNote)}</span></td>
      <td class="subtle">${updated?esc(formatDateTime(updated)):"—"}</td>
      <td>${badge(row.status)}</td>
    </tr>`;
  }).join("");
}

function refreshComparisonRows(){
  const body=$("#tripComparisonBody");
  if(body) body.innerHTML=comparisonRows();
  const count=$("#tripComparisonCount");
  if(count) count.textContent=`${comparisons.length} active trip${comparisons.length===1?"":"s"}`;
}

function stopComparisonPolling(){
  if(comparisonsPollingInterval){
    clearInterval(comparisonsPollingInterval);
    comparisonsPollingInterval=null;
  }
}

function startComparisonPolling(){
  stopComparisonPolling();
  comparisonsPollingInterval=setInterval(async()=>{
    if(currentPage!=="Mismatch Alerts"){stopComparisonPolling();return}
    try{
      await loadComparisons();
    }catch(error){
      comparisonsError=error.message||"Active trip comparisons could not be loaded.";
    }
    if(currentPage==="Mismatch Alerts") refreshComparisonRows();
  },COMPARISONS_POLL_MS);
}

async function loadCheckers(){
  const data=await apiRequest("/api/checkers");
  checkers=(data.checkers||[]).map(checker=>({
    id:checker.id,
    name:checker.name,
    availability:checker.availability||"Available",
    bus:checker.bus_id||"—",
    location:checker.location||"—",
    task:checker.task||"Standby"
  }));
  return checkers;
}

async function loadBuses(){
  const data=await apiRequest("/api/conductor/buses");
  fleetBuses=(data.buses||[]).map(bus=>({
    id:bus.id||bus.bus_id||"",
    fleet:bus.fleet||bus.fleet_id||"",
    route:bus.route||"",
    depot:bus.depot||"",
    capacity:Number(bus.capacity||0),
    operator:bus.operator||bus.conductor_name||"",
    next:bus.next||""
  })).filter(bus=>bus.id);
  return fleetBuses;
}

async function loadInspections(){
  const data=await apiRequest("/api/inspections?limit=200");
  inspections=(data.inspections||[]).map(item=>({
    id:item.inspection_id,
    dispatchId:item.dispatch_id,
    bus:item.bus_id||"",
    route:item.route||"",
    checker:item.checker||"",
    checkerId:item.checker_id||"",
    location:item.location||item.checkpoint||"",
    mismatch:item.mismatch||"Pending",
    outcome:item.outcome||"Inspection Pending",
    status:item.status||"",
    findings:item.findings||"",
    severity:item.severity||"",
    time:formatDateTime(item.completed_at||item.created_at),
    createdAt:item.created_at||"",
    completedAt:item.completed_at||""
  }));
  return inspections;
}

async function loadAnalytics(){
  analyticsLoading=true;
  try{
    const params=new URLSearchParams({days:String(analyticsDays)});
    if(analyticsRoute) params.set("route",analyticsRoute);
    const data=await apiRequest(`/api/analytics/passengers?${params}`);
    analyticsData=data.analytics||null;
    analyticsError="";
    return analyticsData;
  }catch(error){
    analyticsError=error.message||"Passenger analytics could not be loaded.";
    throw error;
  }finally{
    analyticsLoading=false;
  }
}

function updateAlertNavCount(){
  const count=$("#navAlertCount");
  if(!count) return;
  const open=alerts.filter(alert=>alert.status!=="Resolved").length;
  count.textContent=String(open);
  count.hidden=open===0;
}

async function refreshAlertsPage(){
  try{
    await Promise.all([loadAlerts(),loadComparisons()]);
    if(currentPage==="Mismatch Alerts") render();
    toast("Alerts and trip comparisons refreshed.");
  }catch(error){toast(error.message||"Failed to refresh alerts.")}
}

async function refreshDispatchData(){
  try{
    await Promise.all([loadCheckers(),loadInspections(),loadAlerts(),loadBuses()]);
    dispatchLoaded=true;
    if(["Checker Dispatch","Inspection History"].includes(currentPage)) render();
  }catch(error){toast(error.message||"Failed to refresh dispatch data.")}
}

async function refreshAnalytics(){
  if(currentPage==="Passenger Analytics") render();
  try{
    await loadAnalytics();
    if(currentPage==="Passenger Analytics") render();
  }catch(error){
    if(currentPage==="Passenger Analytics") render();
    toast(error.message||"Failed to load passenger analytics.");
  }
}

async function loadInitialData(){
  const results=await Promise.allSettled([loadBuses(),loadCheckers(),loadInspections(),loadAlerts()]);
  dispatchLoaded=results.slice(0,3).every(result=>result.status==="fulfilled");
  if(["Overview Dashboard","Mismatch Alerts","Checker Dispatch","Inspection History"].includes(currentPage)) render();
  if(currentPage==="Passenger Analytics") await refreshAnalytics();
}

async function ensurePageData(name){
  try{
    if(name==="Mismatch Alerts"){
      if(!alertsLoaded) await loadAlerts();
      if(!comparisonsLoaded&&!comparisonsLoading){
        try{
          await loadComparisons();
        }catch(error){
          comparisonsError=error.message||"Active trip comparisons could not be loaded.";
        }
      }
      startComparisonPolling();
      if(currentPage===name) render();
    }else if(["Checker Dispatch","Inspection History"].includes(name)&&!dispatchLoaded){
      await refreshDispatchData();
    }else if(name==="Passenger Analytics"&&!analyticsData){
      await refreshAnalytics();
    }
  }catch(error){toast(error.message||"Failed to load page data.")}
}

function alertItems(){
  return alerts.filter(a=>a.status!=="Resolved").slice(0,4).map(a=>`<div class="alert-item"><span class="alert-indicator ${a.severity==="Low"?"medium":""}"></span><div class="alert-main"><strong>${esc(a.bus)} · ${a.mismatch} passenger mismatch${a.mismatch===1?"":"es"}</strong><p>${esc(a.route)} · ${esc(a.stop)} · ${esc(a.time)}</p></div><button class="btn-text" data-action="alert-detail" data-id="${esc(a.id)}">View</button></div>`).join("")||`<div class="empty-state">${alertsLoaded?"No active alerts.":"Loading alerts…"}</div>`
}

function renderDashboard(){
 const totalP=buses.reduce((n,b)=>n+b.passengers,0), totalT=buses.reduce((n,b)=>n+b.tickets,0);
 return `${title("Overview Dashboard","Good morning, Admin. Here's your fleet snapshot for today.")}
 <div class="kpi-grid">${kpi("Active Buses","248","▣",'<span class="trend-up">↑ 6.2%</span> vs yesterday')}${kpi("Total Passengers","1,842","♙",'<span class="trend-up">↑ 12.4%</span> since 8 AM',"teal")}${kpi("Tickets Recorded","1,796","▤",'<span class="trend-up">↑ 11.8%</span> since 8 AM')}${kpi("Passenger–Ticket Mismatches","46","⚑",'<span class="trend-warn">12 require review</span>',"red")}${kpi("Pending Inspections","08","◷",'<span class="trend-warn">3 high priority</span>',"amber")}${kpi("Inspections Completed","34","✓",'<span class="trend-up">↑ 4</span> in the last hour',"teal")}</div>
 <div class="dashboard-grid"><section class="panel"><div class="panel-heading"><div><h2>Mismatch monitoring</h2><div class="panel-subtitle">Alert volume across active routes · sample hourly trend</div></div><select class="select-small" aria-label="Mismatch chart period"><option>Today</option><option>This week</option></select></div><div class="chart-area">${lineChart([3,5,4,8,6,11,8,14,10,13,9,16],[1,2,2,4,3,6,4,8,5,7,4,9],["6 AM","7 AM","8 AM","9 AM","10 AM","11 AM","12 PM","1 PM","2 PM","3 PM","4 PM","5 PM"],"Alerts detected","Reviewed")}</div></section>
 <section class="panel"><div class="panel-heading"><div><h2>Passenger vs ticket count</h2><div class="panel-subtitle">Live sample comparison · current fleet</div></div><span class="mini-pill">Last 6 hours</span></div><div class="chart-area">${lineChart([24,31,29,38,35,46,42,51],[23,30,28,37,34,43,40,47],["6 AM","7 AM","8 AM","9 AM","10 AM","11 AM","12 PM","1 PM"],"Passengers","Tickets")}</div></section></div>
  <div class="dashboard-grid"><section class="panel ${settings.fleetOverview?"":"fleet-hidden"}"><div class="panel-heading"><div><h2>Live fleet overview</h2><div class="panel-subtitle">A snapshot of buses currently on active routes</div></div><button class="btn-text" data-goto="Live Bus Monitoring">View all buses →</button></div>${busTable(buses,true)}</section><section class="panel"><div class="panel-heading"><div><h2>Recent mismatch alerts</h2><div class="panel-subtitle">Requires attention from the control room</div></div><button class="btn-text" data-goto="Mismatch Alerts">All alerts →</button></div><div class="alert-list">${alertItems()}</div><div class="inspection-strip"><div class="inspection-stat"><strong class="stat-green">${inspections.filter(i=>i.status==="Completed").length}</strong><span>Completed</span></div><div class="inspection-stat"><strong>${inspections.filter(i=>i.status!=="Completed").length}</strong><span>Pending</span></div><div class="inspection-stat"><strong>${alerts.filter(a=>a.severity==="High"&&a.status!=="Resolved").length}</strong><span>High alerts</span></div></div></section></div>
 <p class="panel-subtitle" style="text-align:right;margin:8px 2px 0">Summary metrics and chart values are illustrative demonstration data.</p>`;
}

function renderLive(){
 return `${title("Live Bus Monitoring","Monitor active buses, route activity, and passenger–ticket variance.",'<button class="btn btn-primary" data-goto="Computer Vision Monitoring">📷 Computer Vision Camera</button><button class="btn" data-action="refresh">↻ Refresh</button>')}
 <div class="kpi-grid">${kpi("Active on routes","248","▣","Across 18 routes")}${kpi("Normal status","214","✓","86% of active fleet","teal")}${kpi("Mismatch detected","26","⚑","8 need immediate attention","red")}${kpi("Inspection pending","08","◷","Checkers en route","amber")}</div>
 <div class="toolbar"><input id="busSearch" placeholder="Search bus number or route..." aria-label="Search buses" value="${esc(globalQuery)}" /><select id="busStatusFilter" aria-label="Filter by bus status"><option value="">All statuses</option><option>Normal</option><option>Mismatch Detected</option><option>Inspection Pending</option></select><select id="busRouteFilter" aria-label="Filter by route"><option value="">All routes</option>${routes.map(r=>`<option>${esc(r)}</option>`).join("")}</select><span class="toolbar-spacer"></span><span class="mini-pill">Positions are illustrative · no live GPS</span></div>
 <div class="monitor-layout"><section class="panel"><div class="panel-heading"><div><h2>Fleet activity</h2><div class="panel-subtitle">Select a bus to inspect its sample activity</div></div><span class="mini-pill" id="busResultCount">${buses.length} buses</span></div><div id="liveBusTable">${busTable(filterBuses(),false)}</div></section><section class="panel"><div class="panel-heading"><div><h2>Route map</h2><div class="panel-subtitle">Schematic view · sample bus markers</div></div><span class="mini-pill">Maharashtra</span></div><div class="map-card"><div class="map-grid"></div><div class="map-river"></div><i class="map-road road-one"></i><i class="map-road road-two"></i><span class="map-label mumbai">Mumbai</span><span class="map-label pune">Pune</span><span class="map-label nashik">Nashik</span><span class="map-label kolhapur">Kolhapur</span><button class="map-marker m1 warn" data-action="bus-detail" data-id="${esc(buses[0].id)}" aria-label="Open bus ${esc(buses[0].id)}"><span>1</span></button><button class="map-marker m2" data-action="bus-detail" data-id="${esc(buses[1].id)}" aria-label="Open bus ${esc(buses[1].id)}"><span>2</span></button><button class="map-marker m3 warn" data-action="bus-detail" data-id="${esc(buses[2].id)}" aria-label="Open bus ${esc(buses[2].id)}"><span>3</span></button><button class="map-marker m4" data-action="bus-detail" data-id="${esc(buses[5].id)}" aria-label="Open bus ${esc(buses[5].id)}"><span>4</span></button><div class="map-caption">Visual mockup · markers do not indicate real bus locations</div></div><div class="detail-list"><div><span>Visible routes</span><strong>6 corridors</strong></div><div><span>Fleet capacity in sample</span><strong>52 seats per bus</strong></div></div></section></div>`;
}
function filterBuses(){
 const q=($("#busSearch")?.value??globalQuery).toLowerCase(), st=$("#busStatusFilter")?.value??"",rt=$("#busRouteFilter")?.value??"";
 return buses.filter(b=>(!q||`${b.id} ${b.route} ${b.stop}`.toLowerCase().includes(q))&&(!st||b.status===st)&&(!rt||b.route===rt));
}

function renderAlerts(){
 const severity=$("#severityFilter")?.value??"",state=$("#alertStatusFilter")?.value??"",route=$("#alertRouteFilter")?.value??"",q=$("#alertSearch")?.value.toLowerCase().trim()??"";
 const data=alerts.filter(a=>(!severity||a.severity===severity)&&(!state||a.status===state)&&(!route||a.route===route)&&(!q||`${a.id} ${a.bus} ${a.route} ${a.stop}`.toLowerCase().includes(q)));
 const high=alerts.filter(a=>a.severity==="High"&&a.status!=="Resolved").length;
 const review=alerts.filter(a=>a.status==="Under Review").length;
 const resolved=alerts.filter(a=>a.status==="Resolved").length;
 const open=alerts.filter(a=>a.status!=="Resolved").length;
 const compMismatch=comparisons.filter(row=>row.is_mismatch).length;
 const compLive=comparisons.filter(row=>row.camera_status==="connected").length;
 const compUnavailable=comparisons.filter(row=>row.camera_status!=="connected").length;
 const hasFilters=Boolean(severity||state||route||q);
 const alertRoutes=[...new Set(alerts.map(a=>a.route).filter(Boolean))].sort();
 const statuses=[...new Set(["New","Under Review","Resolved",...alerts.map(a=>a.status)])].filter(Boolean);
 return `${title("Mismatch Alerts","Compare active-trip ETM totals with the latest camera count, investigate variance, and track resolution.",`<button class="btn" data-action="refresh-alerts">↻ Refresh</button><button class="btn btn-primary" data-action="export-filtered-alerts">⇩ Export alerts</button>`,"BACKEND DATA")}
 <div class="kpi-grid alert-kpi-grid">${kpi("Open alerts",String(open),"⚑","Awaiting resolution",open?"red":"teal")}${kpi("High severity",String(high),"↑","Open high-priority alerts",high?"red":"teal")}${kpi("Under review",String(review),"◷","Checker verification underway","amber")}${kpi("Resolved",String(resolved),"✓","Closed alert records","teal")}</div>
 <section class="panel page-panel">
  <div class="panel-heading">
    <div><h2>Active trip comparison</h2><div class="panel-subtitle">Detected passengers minus ETM expected passengers · tolerance ±${comparisonTolerance} · auto-refreshes every 5 seconds</div></div>
    <div class="heading-inline"><span class="mini-pill" id="tripComparisonCount">${comparisons.length} active trip${comparisons.length===1?"":"s"}</span><button class="btn btn-small" data-action="refresh-alerts">↻ Sync now</button></div>
  </div>
  ${statsStrip([["Live cameras",compLive,"stat-green"],["Variance alerts",compMismatch,compMismatch?"stat-red":""],["Camera unavailable / stale",compUnavailable,compUnavailable?"stat-amber":""],["Tolerance",`±${comparisonTolerance}`,""]])}
  <div class="data-card comparison-table-wrap"><table class="generic-table"><thead><tr><th>Bus number</th><th>Route</th><th>Trip</th><th>Expected</th><th>Detected</th><th>Difference</th><th>Tolerance</th><th>Camera</th><th>Last update</th><th>Status</th></tr></thead><tbody id="tripComparisonBody">${comparisonRows()}</tbody></table></div>
 </section>
 <section class="panel page-panel">
  <div class="panel-heading"><div><h2>Alert register</h2><div class="panel-subtitle">Stored mismatch records with severity, workflow status, and inspection context.</div></div><span class="mini-pill">${data.length} of ${alerts.length} records</span></div>
  <div class="toolbar">
    <input id="alertSearch" placeholder="Search alert ID, bus, route, checkpoint…" value="${esc(q)}" aria-label="Search alerts"/>
    <select id="severityFilter" aria-label="Filter severity"><option value="">All severities</option>${["High","Medium","Low"].map(x=>`<option ${severity===x?"selected":""}>${x}</option>`).join("")}</select>
    <select id="alertStatusFilter" aria-label="Filter alert status"><option value="">All statuses</option>${statuses.map(x=>`<option ${state===x?"selected":""}>${esc(x)}</option>`).join("")}</select>
    <select id="alertRouteFilter" aria-label="Filter alert route"><option value="">All routes</option>${alertRoutes.map(x=>`<option ${route===x?"selected":""}>${esc(x)}</option>`).join("")}</select>
    <span class="toolbar-spacer"></span>
    <button class="btn btn-small" data-action="clear-alert-filters" ${hasFilters?"":"disabled"}>Clear filters</button>
  </div>
  <div class="data-card"><table class="generic-table"><thead><tr><th>Alert ID</th><th>Bus number</th><th>Route</th><th>Passengers</th><th>Expected</th><th>Variance</th><th>Checkpoint</th><th>Detected</th><th>Severity</th><th>Status</th><th>Actions</th></tr></thead><tbody>${data.length?data.map(a=>`<tr class="${a.status==="Resolved"?"row-resolved":""}"><td class="bus-id">${esc(a.id)}</td><td>${esc(a.bus)}</td><td class="route-name">${esc(a.route||"—")}</td><td>${fmtNumber(a.passengers)}</td><td>${fmtNumber(a.tickets)}</td><td class="${a.mismatch?"number-bad":""}">${a.difference<0?"":"+"}${a.difference}</td><td>${esc(a.stop||"—")}</td><td class="subtle">${esc(a.time||"—")}</td><td>${badge(a.severity)}</td><td>${badge(a.status)}</td><td><div class="row-actions"><button class="btn-text" data-action="alert-detail" data-id="${esc(a.id)}">Details</button><button class="btn-text" data-action="alert-menu" data-id="${esc(a.id)}">Update</button></div></td></tr>`).join(""):`<tr><td colspan="11"><div class="empty-state"><strong>${alertsLoaded?"No matching alerts":"Loading alerts…"}</strong>${alertsLoaded?"Change or clear the filters to see stored alerts.":"Fetching alert records from the backend."}</div></td></tr>`}</tbody></table></div>
  <p class="panel-footnote">${alertsLoaded?`Showing ${data.length} of ${alerts.length} alert records. Severity and status values come from the backend.`:"Alert records are loading from the backend."}</p>
 </section>`;
}

function renderManagement(){
 return `${title("Bus & Route Management","Manage the demonstration fleet register and its route assignments.",'<button class="btn btn-primary" data-action="add-bus">＋ Add bus</button>')}
 <div class="toolbar"><input id="manageSearch" placeholder="Search bus, fleet ID, route..." aria-label="Search fleet" /><select id="manageStatus"><option value="">All operational statuses</option><option>Active</option><option>Maintenance</option></select><span class="toolbar-spacer"></span><span class="mini-pill">${buses.length} registered sample buses</span></div>
 <div class="data-card" id="managementTable"></div>`;
}
function managementRows(){
 const q=($("#manageSearch")?.value??"").toLowerCase(),st=$("#manageStatus")?.value??"";
 const data=buses.filter(b=>(!q||`${b.id} ${b.fleet} ${b.route} ${b.depot}`.toLowerCase().includes(q))&&(!st||"Active"===st));
 $("#managementTable").innerHTML=`<table class="generic-table"><thead><tr><th>Registration number</th><th>Fleet ID</th><th>Route name</th><th>Depot</th><th>Capacity</th><th>Assigned operator</th><th>Operational status</th><th>Actions</th></tr></thead><tbody>${data.length?data.map(b=>`<tr><td class="bus-id">${esc(b.id)}</td><td>${esc(b.fleet)}</td><td>${esc(b.route)}</td><td>${esc(b.depot)}</td><td>${b.capacity} seats</td><td>${esc(b.operator)}</td><td>${badge(b.status==="Inspection Pending"?"Active":b.status==="Mismatch Detected"?"Active":"Active")}</td><td><div class="row-actions"><button class="btn-text" data-action="bus-detail" data-id="${esc(b.id)}">View</button><button class="btn-text" data-action="edit-bus" data-id="${esc(b.id)}">Edit</button></div></td></tr>`).join(""):`<tr><td colspan="8"><div class="empty-state"><strong>No buses found</strong>Try another search.</div></td></tr>`}</tbody></table>`;
}

function renderAnalytics(){
 const summary=analyticsData?.summary||{};
 const trend=analyticsData?.trend||{labels:[],ticket_passengers:[],pass_passengers:[],alerts:[]};
 const routeRows=analyticsData?.route_breakdown||[];
 const busRows=analyticsData?.bus_breakdown||[];
 const expected=num(summary.expected_passengers);
 const ticketPassengers=num(summary.ticket_passengers);
 const passPassengers=num(summary.pass_passengers);
 const coverage=expected?Math.min(100,Math.round(ticketPassengers/expected*1000)/10):0;
 const mismatchRate=num(summary.checkpoint_count)?Math.round(num(summary.mismatch_checkpoints)/num(summary.checkpoint_count)*1000)/10:0;
 const highest=[...routeRows].sort((a,b)=>num(b.mismatches)-num(a.mismatches))[0];
 const largestVariance=[...busRows].filter(row=>row.camera_estimate!=null).sort((a,b)=>num(b.difference_abs)-num(a.difference_abs))[0];
 const ranges=[["0–50%",0],["51–75%",0],["76–90%",0],["91–100%",0]];
 busRows.forEach(bus=>{
   const value=bus.camera_estimate==null?0:num(bus.camera_estimate)/Math.max(1,num(bus.capacity))*100;
   ranges[value<=50?0:value<=75?1:value<=90?2:3][1]+=1;
 });
 const rangeTotal=Math.max(1,busRows.length);
 const routeOptions=[...new Set([...routeRows.map(row=>row.route),...fleetBuses.map(bus=>bus.route),analyticsRoute].filter(Boolean))].sort();
 const periodLabel=analyticsDays===1?"Today":`Last ${analyticsDays} days`;
 const emptyAnalytics=!analyticsData&&!analyticsLoading;
 return `${title("Passenger Analytics","Understand boarding demand, ETM coverage, route performance, and camera-verified variance.","<button class=\"btn\" data-action=\"refresh-analytics\">↻ Refresh</button><button class=\"btn btn-primary\" data-action=\"export-analytics\">⇩ Export data</button>","BACKEND DATA")}
 ${analyticsError?`<div class="inline-alert"><div><strong>Passenger analytics unavailable</strong><span>${esc(analyticsError)}</span></div><button class="btn btn-small" data-action="refresh-analytics">Retry</button></div>`:""}
 <div class="toolbar analytics-toolbar">
   <div class="segmented" role="group" aria-label="Analytics period">
     ${[[1,"Today"],[7,"7 days"],[30,"30 days"]].map(([days,label])=>`<button class="segmented-option ${analyticsDays===days?"active":""}" data-action="set-analytics-days" data-days="${days}">${label}</button>`).join("")}
   </div>
   <select id="analyticsRoute" aria-label="Filter analytics by route"><option value="">All routes</option>${routeOptions.map(route=>`<option ${analyticsRoute===route?"selected":""}>${esc(route)}</option>`).join("")}</select>
   <span class="toolbar-spacer"></span>
   <span class="mini-pill">${analyticsLoading?"Refreshing backend data…":analyticsData?`${periodLabel} · backend aggregated`:"Awaiting backend data"}</span>
 </div>
 <div class="kpi-grid analytics-kpi-grid">
   ${kpi("Expected passengers",fmtNumber(expected),"♙","ETM tickets plus valid passes","teal")}
   ${kpi("Ticket passengers",fmtNumber(ticketPassengers),"▤",`${fmtPercent(ticketPassengers,expected)} of expected passengers`)}
   ${kpi("Valid pass passengers",fmtNumber(passPassengers),"◫",`${fmtNumber(summary.pass_count)} passes recorded`,"amber")}
   ${kpi("Ticket revenue",fmtCurrency(summary.revenue),"₹","Valid ticket fare total","teal")}
   ${kpi("Checkpoint mismatches",fmtNumber(summary.mismatch_checkpoints),"⚑",`${mismatchRate}% of ${fmtNumber(summary.checkpoint_count)} checkpoints`,num(summary.mismatch_checkpoints)?"red":"teal")}
   ${kpi("Average variance",`${num(summary.average_variance).toFixed(1)}`,"↕",`Maximum ${fmtNumber(summary.maximum_variance)} passengers`,num(summary.average_variance)? "amber":"teal")}
 </div>
 <div class="dashboard-grid analytics-chart-grid">
   <section class="panel">
     <div class="panel-heading"><div><h2>Passenger boarding trends</h2><div class="panel-subtitle">Daily ticketed and pass passengers over the last seven recorded days</div></div><span class="mini-pill">${periodLabel}</span></div>
     <div class="chart-area">${lineChart(trend.ticket_passengers||[],trend.pass_passengers||[],trend.labels||[],"Ticketed passengers","Pass passengers")}</div>
   </section>
   <section class="panel">
     <div class="panel-heading"><div><h2>Daily alert volume</h2><div class="panel-subtitle">Mismatch alerts recorded on each day</div></div><span class="mini-pill">${fmtNumber((trend.alerts||[]).reduce((total,value)=>total+num(value),0))} total</span></div>
     ${sparkBars(trend.alerts||[],trend.labels||[],"red","alerts")}
     <div class="insight-list">
       <div><span>Largest bus variance</span><strong>${largestVariance?`${esc(largestVariance.bus_id)} · ${fmtNumber(largestVariance.difference_abs)}`:"No camera comparison"}</strong></div>
       <div><span>Highest mismatch route</span><strong>${highest?.route?esc(highest.route):"No route variance"}</strong></div>
     </div>
   </section>
 </div>
 <section class="panel page-panel">
   <div class="panel-heading"><div><h2>Route performance</h2><div class="panel-subtitle">ETM passenger volume, ticket revenue, checkpoints, and alert activity by corridor.</div></div><span class="mini-pill">${routeRows.length} routes</span></div>
   <div class="data-card"><table class="generic-table"><thead><tr><th>Route</th><th>Tickets</th><th>Passes</th><th>ETM total</th><th>Revenue</th><th>Checkpoints</th><th>Mismatches</th><th>Alerts</th><th>Coverage</th></tr></thead><tbody>${routeRows.length?routeRows.map(row=>{
     const total=num(row.ticket_passengers)+num(row.pass_passengers);
     const routeCoverage=total?Math.round(num(row.ticket_passengers)/total*100):0;
     return `<tr><td class="route-name">${esc(row.route||"Unassigned")}</td><td>${fmtNumber(row.ticket_passengers)}</td><td>${fmtNumber(row.pass_passengers)}</td><td>${fmtNumber(total)}</td><td>${fmtCurrency(row.revenue)}</td><td>${fmtNumber(row.checkpoint_count)}</td><td class="${num(row.mismatches)?"number-bad":""}">${fmtNumber(row.mismatches)}</td><td>${fmtNumber(row.alerts)}</td><td>${progress(routeCoverage)}</td></tr>`;
   }).join(""):`<tr><td colspan="9"><div class="empty-state"><strong>No route data for this period</strong>Complete a trip or change the selected date range and route.</div></td></tr>`}</tbody></table></div>
 </section>
 <div class="dashboard-grid">
   <section class="panel">
     <div class="panel-heading"><div><h2>Bus-level comparison</h2><div class="panel-subtitle">Latest checkpoint count compared with registered bus capacity.</div></div><span class="mini-pill">${busRows.length} buses</span></div>
     <div class="data-card"><table class="generic-table"><thead><tr><th>Bus number</th><th>Route</th><th>Tickets</th><th>Passes</th><th>Camera</th><th>Capacity</th><th>Variance</th><th>Occupancy</th><th>Status</th></tr></thead><tbody>${busRows.length?busRows.map(row=>{
       const occupancy=row.camera_estimate==null?0:Math.round(num(row.camera_estimate)/Math.max(1,num(row.capacity))*100);
       const status=row.camera_estimate==null?"No camera":num(row.difference_abs)<=comparisonTolerance?"Within tolerance":"Mismatch";
       return `<tr><td class="bus-id">${esc(row.bus_id)}</td><td class="route-name">${esc(row.route||"—")}</td><td>${fmtNumber(row.ticket_passengers)}</td><td>${fmtNumber(row.pass_passengers)}</td><td>${row.camera_estimate==null?"—":fmtNumber(row.camera_estimate)}</td><td>${fmtNumber(row.capacity)}</td><td class="${num(row.difference_abs)>comparisonTolerance?"number-bad":""}">${row.difference_abs==null?"—":fmtNumber(row.difference_abs)}</td><td>${progress(occupancy)}</td><td>${badge(status)}</td></tr>`;
     }).join(""):`<tr><td colspan="9"><div class="empty-state">No registered bus data for this period.</div></td></tr>`}</tbody></table></div>
   </section>
   <section class="panel">
     <div class="panel-heading"><div><h2>Camera occupancy</h2><div class="panel-subtitle">Latest camera estimate as a share of bus capacity.</div></div><span class="mini-pill">${rangeTotal} buses</span></div>
     <div class="occupancy-ranges">${ranges.map(([label,count])=>{
       const share=Math.round(count/rangeTotal*100);
       return `<div class="occupancy-range"><div class="occupancy-range-head"><span>${label}</span><strong>${count} · ${share}%</strong></div><div class="progress progress-wide"><i style="width:${share}%"></i></div></div>`;
     }).join("")}</div>
     <div class="coverage-card"><div><span>ETM passenger coverage</span><strong>${coverage.toFixed(1)}%</strong></div>${progress(coverage,false)}<p>${fmtNumber(ticketPassengers)} ticketed passengers against ${fmtNumber(expected)} expected passengers.</p></div>
     <div class="insight-list">
       <div><span>Inspections completed</span><strong>${fmtNumber(summary.completed_inspections)} of ${fmtNumber(summary.dispatch_count)}</strong></div>
       <div><span>Open alerts</span><strong>${fmtNumber(summary.open_alerts)}</strong></div>
     </div>
   </section>
 </div>
 ${emptyAnalytics?`<div class="panel"><div class="empty-state"><strong>No analytics have been loaded yet</strong>Start a trip, issue tickets, or refresh to retrieve backend data.</div></div>`:""}`;
}

function renderDispatch(){
 const available=checkers.filter(c=>c.availability==="Available");
 const onInspection=checkers.filter(c=>c.availability!=="Available");
 const pending=inspections.filter(i=>i.status!=="Completed");
 const activeAlerts=alerts.filter(a=>a.status!=="Resolved");
 const assignableBuses=fleetBuses.length?fleetBuses:[...new Map(activeAlerts.map(a=>[a.bus,{id:a.bus,route:a.route}])).values()];
 return `${title("Checker Dispatch","Assign available checkers to flagged buses and track active inspections.",'<button class="btn btn-primary" data-action="assign-checker">＋ New assignment</button>',"BACKEND DATA")}
 <div class="summary-grid" style="margin-bottom:14px">${[["Checkers",String(checkers.length)],["Available now",String(available.length)],["On inspection",String(onInspection.length)],["Pending inspections",String(pending.length)]].map(([l,v])=>`<div class="panel summary-card"><div class="metric">${v}</div><div class="metric-label">${l}</div></div>`).join("")}</div>
 <div class="dashboard-grid"><section class="panel"><div class="panel-heading"><div><h2>Checker availability</h2><div class="panel-subtitle">Live roster and current assignments</div></div><span class="mini-pill">${checkers.length} shown</span></div><div class="data-card"><table class="generic-table"><thead><tr><th>Checker</th><th>Checker ID</th><th>Availability</th><th>Assigned bus</th><th>Location</th><th>Task</th></tr></thead><tbody>${checkers.length?checkers.map(c=>`<tr><td class="bus-id">${esc(c.name)}</td><td>${esc(c.id)}</td><td>${badge(c.availability)}</td><td>${esc(c.bus)}</td><td>${esc(c.location)}</td><td>${esc(c.task)}</td></tr>`).join(""):`<tr><td colspan="6"><div class="empty-state">No checkers are configured.</div></td></tr>`}</tbody></table></div></section><section class="panel"><div class="panel-heading"><div><h2>Quick assignment</h2><div class="panel-subtitle">Dispatch an available checker and notify the backend workflow.</div></div></div><form id="assignmentForm" class="form-grid"><div class="form-group full"><label for="assignBus">Bus</label><select class="form-control" id="assignBus" required>${assignableBuses.map(b=>`<option value="${esc(b.id)}">${esc(b.id)} · ${esc(b.route||"Unassigned route")}</option>`).join("")}</select></div><div class="form-group"><label for="assignChecker">Available checker</label><select class="form-control" id="assignChecker" required ${available.length?"":"disabled"}><option value="">${available.length?"Select checker":"No checkers available"}</option>${available.map(c=>`<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")}</select></div><div class="form-group"><label for="assignStop">Inspection location</label><input class="form-control" id="assignStop" required placeholder="Checkpoint or bus stand"/></div><div class="form-group"><label for="assignAlert">Related alert</label><select class="form-control" id="assignAlert"><option value="">None</option>${activeAlerts.map(a=>`<option value="${esc(a.id)}">${esc(a.id)} · ${esc(a.bus)}</option>`).join("")}</select></div><div class="form-group full"><label for="assignNotes">Notes</label><input class="form-control" id="assignNotes" placeholder="Optional instructions"/></div><div class="form-group full"><button class="btn btn-primary" type="submit">Confirm assignment</button></div></form></section></div>
 <div class="section-title-row"><h2>Active inspection assignments</h2><span class="mini-pill">${pending.length} pending</span></div><div class="data-card"><table class="generic-table"><thead><tr><th>Inspection ID</th><th>Bus</th><th>Route</th><th>Checker</th><th>Location</th><th>Task status</th><th>Assigned</th><th>Actions</th></tr></thead><tbody>${inspections.length?inspections.map(i=>`<tr><td class="bus-id">${esc(i.id)}</td><td>${esc(i.bus)}</td><td>${esc(i.route)}</td><td>${esc(i.checker)}</td><td>${esc(i.location)}</td><td>${badge(i.outcome)}</td><td>${esc(formatDateTime(i.createdAt))}</td><td><div class="row-actions"><button class="btn-text" data-action="inspection-detail" data-id="${esc(i.id)}">View</button>${i.status!=="Completed"?`<button class="btn-text" data-action="complete-dispatch" data-id="${esc(i.id)}">Complete</button>`:""}</div></td></tr>`).join(""):`<tr><td colspan="8"><div class="empty-state">No checker assignments yet.</div></td></tr>`}</tbody></table></div>`;
}

function renderHistory(){
 const historyRoutes=[...new Set(inspections.map(i=>i.route).filter(Boolean))].sort();
 return `${title("Inspection History","Review checker visits, findings, and outcomes from dispatch records.",'<button class="btn" data-action="refresh-inspections">↻ Refresh</button>',"BACKEND DATA")}
 <div class="toolbar"><input id="historySearch" placeholder="Search inspection, bus, checker..." aria-label="Search inspections"/><select id="historyStatus" aria-label="Filter inspection outcome"><option value="">All outcomes</option><option>Mismatch Confirmed</option><option>No Mismatch Found</option><option>Inconclusive</option><option>Inspection Pending</option></select><select id="historyRoute" aria-label="Filter inspection route"><option value="">All routes</option>${historyRoutes.map(r=>`<option>${esc(r)}</option>`).join("")}</select></div><div class="data-card" id="historyTable"></div>`;
}
function historyRows(){
 const q=($("#historySearch")?.value??"").toLowerCase(),st=$("#historyStatus")?.value??"",rt=$("#historyRoute")?.value??"";
 const data=inspections.filter(i=>(!q||`${i.id} ${i.bus} ${i.checker} ${i.location}`.toLowerCase().includes(q))&&(!st||i.outcome===st)&&(!rt||i.route===rt));
 $("#historyTable").innerHTML=`<table class="generic-table"><thead><tr><th>Inspection ID</th><th>Bus number</th><th>Route</th><th>Assigned checker</th><th>Inspection location</th><th>Mismatch detected</th><th>Outcome</th><th>Date &amp; time</th><th>Details</th></tr></thead><tbody>${data.length?data.map(i=>`<tr><td class="bus-id">${esc(i.id)}</td><td>${esc(i.bus)}</td><td>${esc(i.route)}</td><td>${esc(i.checker)}</td><td>${esc(i.location)}</td><td>${esc(i.mismatch)}</td><td>${badge(i.outcome)}</td><td>${esc(i.time)}</td><td><div class="row-actions"><button class="btn-text" data-action="inspection-detail" data-id="${esc(i.id)}">View</button>${i.status!=="Completed"?`<button class="btn-text" data-action="complete-dispatch" data-id="${esc(i.id)}">Complete</button>`:""}</div></td></tr>`).join(""):`<tr><td colspan="9"><div class="empty-state"><strong>No matching inspections</strong>Adjust your filters or complete a checker assignment.</div></td></tr>`}</tbody></table>`;
}

function renderReports(){
 const scopedAlerts=alerts.filter(alert=>inDayRange(alert.createdAt,reportDays)&&(!reportRoute||alert.route===reportRoute));
 const scopedInspections=inspections.filter(item=>inDayRange(item.createdAt,reportDays)&&(!reportRoute||item.route===reportRoute));
 const resolved=scopedAlerts.filter(a=>a.status==="Resolved").length;
 const open=scopedAlerts.filter(a=>a.status!=="Resolved").length;
 const high=scopedAlerts.filter(a=>a.severity==="High").length;
 const confirmed=scopedInspections.filter(i=>i.outcome==="Mismatch Confirmed").length;
 const completed=scopedInspections.filter(i=>i.status==="Completed").length;
 const rate=scopedAlerts.length?Math.round(resolved/scopedAlerts.length*100):0;
 const confirmationRate=completed?Math.round(confirmed/completed*100):0;
 const days=dayRange(reportDays);
 const labels=days.map(date=>reportDays<=7?date.toLocaleDateString("en-IN",{weekday:"short"}):date.toLocaleDateString("en-IN",{day:"2-digit",month:"short"}));
 const alertCounts={};const inspectionCounts={};
 scopedAlerts.forEach(alert=>{const key=dayKey(alert.createdAt);if(key)alertCounts[key]=(alertCounts[key]||0)+1});
 scopedInspections.forEach(item=>{const key=dayKey(item.createdAt);if(key)inspectionCounts[key]=(inspectionCounts[key]||0)+1});
 const alertSeries=days.map(date=>alertCounts[dayKey(date)]||0);
 const inspectionSeries=days.map(date=>inspectionCounts[dayKey(date)]||0);
 const routeOptions=[...new Set([...alerts.map(a=>a.route),...inspections.map(i=>i.route),reportRoute].filter(Boolean))].sort();
 const routeStats=[...new Set([...scopedAlerts.map(a=>a.route),...scopedInspections.map(i=>i.route)].filter(Boolean))].map(routeName=>{
   const routeAlerts=scopedAlerts.filter(a=>a.route===routeName);
   const routeInspections=scopedInspections.filter(i=>i.route===routeName);
   const resolvedCount=routeAlerts.filter(a=>a.status==="Resolved").length;
   return {
     route:routeName,
     alerts:routeAlerts.length,
     high:routeAlerts.filter(a=>a.severity==="High").length,
     inspections:routeInspections.length,
     confirmed:routeInspections.filter(i=>i.outcome==="Mismatch Confirmed").length,
     rate:routeAlerts.length?Math.round(resolvedCount/routeAlerts.length*100):0
   };
 }).sort((a,b)=>b.alerts-a.alerts);
 const outcomes=["Mismatch Confirmed","No Mismatch Found","Inconclusive","Inspection Pending"].map(outcome=>({
   outcome,
   count:scopedInspections.filter(item=>item.outcome===outcome).length
 }));
 const outcomeTotal=Math.max(1,scopedInspections.length);
 const periodLabel=reportDays===1?"Today":`Last ${reportDays} days`;
 const recentAlerts=[...scopedAlerts].sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).slice(0,8);
 return `${title("Reports & Analytics","Filter, review, print, and export operational summaries built from stored alert and inspection records.",`<button class="btn" data-action="print-report">⌘ Print</button><button class="btn btn-primary" data-action="export-report">⇩ Export report</button>`,"BACKEND DATA")}
 <div class="toolbar report-toolbar">
   <div class="segmented" role="group" aria-label="Report period">
     ${[[1,"Today"],[7,"7 days"],[30,"30 days"],[90,"90 days"]].map(([daysValue,label])=>`<button class="segmented-option ${reportDays===daysValue?"active":""}" data-action="set-report-days" data-days="${daysValue}">${label}</button>`).join("")}
   </div>
   <select id="reportRoute" aria-label="Filter report by route"><option value="">All routes</option>${routeOptions.map(route=>`<option ${reportRoute===route?"selected":""}>${esc(route)}</option>`).join("")}</select>
   <span class="toolbar-spacer"></span>
   <span class="mini-pill">${periodLabel}${reportRoute?` · ${esc(reportRoute)}`:""} · ${scopedAlerts.length} alerts · ${scopedInspections.length} inspections</span>
 </div>
 <div class="report-header-note">
   <div><strong>Report scope</strong><span>Alerts and inspections created within the selected period. Values are calculated from records already loaded from the FastAPI backend.</span></div>
   <span class="demo-tag">ENGINEERING DATA</span>
 </div>
 <div class="kpi-grid report-kpi-grid">
   ${kpi("Alerts in period",fmtNumber(scopedAlerts.length),"⚑",`${fmtNumber(high)} high severity`,high?"red":"teal")}
   ${kpi("Resolved alerts",fmtNumber(resolved),"✓",`${rate}% resolution rate`,"teal")}
   ${kpi("Open alerts",fmtNumber(open),"◷","Still require action",open?"amber":"teal")}
   ${kpi("Confirmed mismatches",fmtNumber(confirmed),"!",`${confirmationRate}% of completed inspections`,confirmed?"red":"teal")}
   ${kpi("Inspections completed",fmtNumber(completed),"▣",`${fmtNumber(scopedInspections.length)} total inspections`)}
   ${kpi("Resolution rate",`${rate}%`,"↗","Resolved ÷ alerts in period","teal")}
 </div>
 <div class="dashboard-grid report-trend-grid">
   <section class="panel">
     <div class="panel-heading"><div><h2>Alert and inspection trend</h2><div class="panel-subtitle">Record creation volume across the selected reporting period.</div></div><span class="mini-pill">${periodLabel}</span></div>
     <div class="chart-area">${lineChart(alertSeries,inspectionSeries,labels,"Mismatch alerts","Inspections")}</div>
   </section>
   <section class="panel">
     <div class="panel-heading"><div><h2>Inspection outcomes</h2><div class="panel-subtitle">Outcome mix for inspections in this report.</div></div><span class="mini-pill">${scopedInspections.length} records</span></div>
     <div class="outcome-list">${outcomes.map(item=>{
       const share=Math.round(item.count/outcomeTotal*100);
       const tone=item.outcome==="Mismatch Confirmed"?"red":item.outcome==="No Mismatch Found"?"green":item.outcome==="Inconclusive"?"amber":"blue";
       return `<div class="outcome-row"><div class="outcome-head"><span>${esc(item.outcome)}</span><strong>${item.count} · ${share}%</strong></div><div class="progress progress-wide"><i class="${tone}" style="width:${share}%"></i></div></div>`;
     }).join("")}</div>
     <div class="insight-list">
       <div><span>Confirmation rate</span><strong>${confirmationRate}%</strong></div>
       <div><span>Alerts awaiting resolution</span><strong>${fmtNumber(open)}</strong></div>
     </div>
   </section>
 </div>
 <section class="panel page-panel">
   <div class="panel-heading"><div><h2>Route-wise statistics</h2><div class="panel-subtitle">Alert volume, inspection outcomes, and resolution performance by corridor.</div></div><span class="mini-pill">${routeStats.length} routes</span></div>
   <div class="data-card"><table class="generic-table"><thead><tr><th>Route</th><th>Alerts</th><th>High severity</th><th>Inspections</th><th>Confirmed</th><th>Resolution rate</th><th>Status</th></tr></thead><tbody>${routeStats.length?routeStats.map(row=>`<tr><td class="route-name">${esc(row.route||"Unassigned")}</td><td>${fmtNumber(row.alerts)}</td><td class="${row.high?"number-bad":""}">${fmtNumber(row.high)}</td><td>${fmtNumber(row.inspections)}</td><td>${fmtNumber(row.confirmed)}</td><td>${progress(row.rate)}</td><td>${badge(row.rate>=80?"On track":row.rate>=50?"Review":"Attention")}</td></tr>`).join(""):`<tr><td colspan="7"><div class="empty-state"><strong>No report data in this period</strong>Select a wider period, clear the route filter, or complete an inspection.</div></td></tr>`}</tbody></table></div>
 </section>
 <div class="dashboard-grid">
   <section class="panel">
     <div class="panel-heading"><div><h2>Recent alerts in scope</h2><div class="panel-subtitle">Most recent mismatch records included in this report.</div></div><button class="btn-text" data-goto="Mismatch Alerts">Open alerts →</button></div>
     <div class="data-card"><table class="generic-table"><thead><tr><th>Alert ID</th><th>Bus</th><th>Route</th><th>Variance</th><th>Severity</th><th>Status</th></tr></thead><tbody>${recentAlerts.length?recentAlerts.map(alert=>`<tr><td class="bus-id">${esc(alert.id)}</td><td>${esc(alert.bus)}</td><td>${esc(alert.route||"—")}</td><td class="${alert.mismatch?"number-bad":""}">${alert.difference>0?"+":""}${alert.difference}</td><td>${badge(alert.severity)}</td><td>${badge(alert.status)}</td></tr>`).join(""):`<tr><td colspan="6"><div class="empty-state">No alerts in this report scope.</div></td></tr>`}</tbody></table></div>
   </section>
   <section class="panel">
     <div class="panel-heading"><div><h2>Export notes</h2><div class="panel-subtitle">What is included in the downloadable report.</div></div></div>
     <div class="report-notes">
       <div><span class="note-index">01</span><p>The CSV includes the selected period and route scope plus a route summary and all matching alert records.</p></div>
       <div><span class="note-index">02</span><p>Rows reflect records loaded from the backend in this browser session. Refresh before exporting if field data may have changed.</p></div>
       <div><span class="note-index">03</span><p>This is an engineering dashboard and does not represent official Maharashtra State Transport statistics.</p></div>
     </div>
     <button class="btn btn-primary btn-block" data-action="export-report">⇩ Download filtered report</button>
   </section>
 </div>`;
}

function renderSettings(){
 return `${title("Settings","Set local display preferences for this browser session.",'<button class="btn btn-primary" data-action="save-settings">Save preferences</button>')}
 <div class="settings-grid"><section class="panel settings-card"><h2>Admin profile</h2>${settingsRow("Display name","Shown only in this demo control room.")}<div class="form-group"><label for="adminName">Name</label><input class="form-control setting-input" id="adminName" value="${esc(settings.adminName)}" /></div><div class="form-group" style="margin-top:11px"><label for="adminEmail">Email</label><input class="form-control setting-input" id="adminEmail" type="email" value="${esc(settings.adminEmail)}" /></div></section>
 <section class="panel settings-card"><h2>Dashboard preferences</h2>${switchRow("fleetOverview","Show fleet overview","Include fleet status in the overview dashboard.")}${switchRow("compactTables","Compact data tables","Use denser table spacing throughout the app.")}${switchRow("demoLabels","Show demo data labels","Keep visible indicators that sample data is in use.")}</section>
 <section class="panel settings-card"><h2>Alert thresholds</h2><div class="settings-row"><div><strong>Mismatch alert threshold</strong><small>Passenger-ticket difference before flagging.</small></div>${settingsSelect("mismatchThreshold",["1 passenger","2 passengers","3 passengers"])}</div><div class="settings-row"><div><strong>High severity threshold</strong><small>Mark larger mismatches as high priority.</small></div>${settingsSelect("highThreshold",["3 passengers","4 passengers","5 passengers"])}</div></section>
 <section class="panel settings-card"><h2>Notification preferences</h2>${switchRow("highAlerts","High severity alerts","Show an in-app alert for high severity mismatches.")}${switchRow("assignmentUpdates","Checker assignment updates","Show local confirmation after assignments.")}${switchRow("dailySummary","Daily summary","Include daily digest in the demo notifications.")}</section>
 <section class="panel settings-card"><h2>Display settings</h2><div class="settings-row"><div><strong>Interface theme</strong><small>Theme is stored for this browser only.</small></div>${settingsSelect("theme",["Light","System"])}</div>${switchRow("time24","24-hour time","Display timestamps in 24-hour format.")}</section>
 <section class="panel settings-card"><h2>About this environment</h2><div class="settings-row"><div><strong>SMART ST Control Center</strong><small>Local backend-connected engineering project.</small></div><span class="mini-pill">v1.19.4</span></div><div class="settings-row"><div><strong>Data source</strong><small>Alerts, ETM, analytics, dispatch, and inspections use the FastAPI backend. Remaining monitoring screens are labelled sample data.</small></div><span class="status status-normal">Backend connected</span></div></section></div>`;
}
function settingsRow(label,desc){return `<div class="settings-row"><div><strong>${label}</strong><small>${desc}</small></div></div>`}
function switchRow(key,label,desc){return `<div class="settings-row"><div><strong>${label}</strong><small>${desc}</small></div><label class="switch" aria-label="${esc(label)}"><input type="checkbox" data-setting="${key}" ${settings[key]?"checked":""}/><i></i></label></div>`}
function settingsSelect(key,options){return `<select class="form-control" data-setting="${key}" style="width:112px">${options.map(option=>`<option ${settings[key]===option?"selected":""}>${esc(option)}</option>`).join("")}</select>`}

function render(){
 const content=$("#pageContent");
 const renderers={"Overview Dashboard":renderDashboard,"Live Bus Monitoring":renderLive,"Computer Vision Monitoring":renderComputerVision,"Conductor Panel":renderConductorPanel,"Mismatch Alerts":renderAlerts,"Bus & Route Management":renderManagement,"Passenger Analytics":renderAnalytics,"Checker Dispatch":renderDispatch,"Inspection History":renderHistory,"Reports & Analytics":renderReports,"Settings":renderSettings};
 content.innerHTML=(renderers[currentPage]||renderDashboard)();
 $("#breadcrumbTitle").textContent=currentPage;
 if(currentPage==="Bus & Route Management")managementRows();
 if(currentPage==="Inspection History")historyRows();
 if(currentPage==="Computer Vision Monitoring")wireComputerVisionControls();
 if(currentPage==="Conductor Panel")wireConductorPanelControls();
 wirePageControls();
 wireSettings();
 updateAlertNavCount();
}
function applySettings(){
 document.body.classList.toggle("compact-tables",settings.compactTables);
 document.body.classList.toggle("hide-demo-labels",!settings.demoLabels);
 updateDate();
 const name=$("#profileButton .profile-text strong");
 if(name)name.textContent=settings.adminName||"Admin";
}
function wireSettings(){
 document.querySelectorAll("[data-setting]").forEach(input=>input.addEventListener("change",()=>{
   const key=input.dataset.setting;
   settings[key]=input.type==="checkbox"?input.checked:input.value;
   applySettings();
 }));
 $("#adminName")?.addEventListener("input",e=>{settings.adminName=e.target.value});
 $("#adminEmail")?.addEventListener("input",e=>{settings.adminEmail=e.target.value});
 applySettings();
}
function gotoPage(name){
 if(!pageNames.includes(name))return;
 if(currentPage==="Computer Vision Monitoring" && window.__stopVisionMonitoring){
   window.__stopVisionMonitoring();
 }
 if(currentPage==="Conductor Panel" && window.__stopConductorPolling){
   window.__stopConductorPolling();
 }
 if(currentPage==="Mismatch Alerts") stopComparisonPolling();
 currentPage=name;
 globalQuery="";
 $("#globalSearch").value="";
 document.querySelectorAll(".nav-link").forEach(b=>b.classList.toggle("active",b.dataset.page===name));
 document.body.classList.remove("sidebar-open");
 render();
 ensurePageData(name);
 window.scrollTo({top:0,behavior:"smooth"});
}
function toast(message){const root=$("#toastRoot"),el=document.createElement("div");el.className="toast";el.textContent=message;root.append(el);setTimeout(()=>el.remove(),3200);}
window.__smartstToast=toast;
function openModal(headline,sub,body,footer=""){
 $("#modalRoot").innerHTML=`<div class="modal-backdrop" data-close-backdrop><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle"><header class="modal-header"><div><h2 id="modalTitle">${headline}</h2><p>${sub}</p></div><button class="modal-close" aria-label="Close dialog" data-action="close-modal">×</button></header><div class="modal-body">${body}</div>${footer?`<footer class="modal-footer">${footer}</footer>`:""}</section></div>`;
 $(".modal-close").focus();
}
function closeModal(){$("#modalRoot").innerHTML=""}
function showBus(id){const b=buses.find(x=>x.id===id);if(!b)return;selectedBus=b;openModal(`Bus details · ${esc(b.id)}`,"Illustrative bus activity · location and counts are sample data.",`<div class="detail-grid">${[["Route",b.route],["Current stop",b.stop],["Next stop",b.next],["Passenger count",b.passengers],["Ticket count",b.tickets],["Mismatch count",b.mismatch],["Occupancy",`${b.occupancy}%`],["Status",b.status],["Fleet ID",b.fleet],["Depot",b.depot]].map(([k,v])=>`<div class="detail-field"><span>${k}</span><strong>${esc(v)}</strong></div>`).join("")}</div><div class="detail-note">${b.mismatch?`Passenger count is ${b.mismatch} higher than recorded tickets. A checker may verify the sample variance at ${esc(b.next)}.`:"No passenger-ticket mismatch is currently recorded for this sample bus."}</div><div class="detail-list"><div><span>Last update</span><strong>${esc(b.updated)}</strong></div><div><span>Recent event</span><strong>${b.mismatch?"Variance alert generated":"Routine count update"}</strong></div></div>`,`<button class="btn" data-action="close-modal">Close</button>${b.mismatch?`<button class="btn btn-primary" data-action="assign-from-bus" data-id="${esc(b.id)}">Assign checker</button>`:""}`)}
function showAlert(id){const a=alerts.find(x=>x.id===id);if(!a)return;openModal(`Alert details · ${esc(a.id)}`,"Passenger–ticket mismatch recorded by the backend.",`<div class="detail-grid">${[["Bus number",a.bus],["Route",a.route],["Checkpoint",a.stop],["Detection time",formatDateTime(a.createdAt)||a.time],["Detected passengers",a.passengers],["Recorded tickets",a.tickets],["Mismatch count",`${a.mismatch} passenger${a.mismatch===1?"":"s"}`],["Severity",a.severity],["Alert status",a.status],["Dispatch",a.dispatch?`${a.dispatch.checker_name||"Assigned"} · ${a.dispatch.status}`:"Not assigned"]].map(([k,v])=>`<div class="detail-field"><span>${k}</span><strong>${esc(v)}</strong></div>`).join("")}</div><div class="detail-note">The recorded passenger count (${a.passengers}) differs from the ticket count (${a.tickets}) by ${a.mismatch}. This alert is a prompt for a human checker to verify the counts; it is not a finding of fare evasion.</div>`,`<button class="btn" data-action="close-modal">Close</button>${a.status!=="Resolved"?`<button class="btn" data-action="review-alert" data-id="${esc(a.id)}">Mark reviewed</button>${!a.dispatch?`<button class="btn btn-primary" data-action="assign-from-alert" data-id="${esc(a.id)}">Assign checker</button>`:""}`:""}`)}
function showInspection(id){const i=inspections.find(x=>x.id===id);if(!i)return;openModal(`Inspection · ${esc(i.id)}`,"Checker visit and recorded outcome.",`<div class="detail-grid">${[["Bus",i.bus],["Route",i.route],["Checker",i.checker],["Location",i.location],["Mismatch",i.mismatch],["Outcome",i.outcome],["Status",i.status],["Assigned",formatDateTime(i.createdAt)],["Completed",i.completedAt?formatDateTime(i.completedAt):"—"],["Findings",i.findings||"—"]].map(([k,v])=>`<div class="detail-field"><span>${k}</span><strong>${esc(v)}</strong></div>`).join("")}</div><div class="detail-note">This inspection is built from the checker dispatch record stored in the backend.</div>`,`<button class="btn" data-action="close-modal">Close</button>${i.status!=="Completed"?`<button class="btn btn-primary" data-action="complete-dispatch" data-id="${esc(i.id)}">Complete inspection</button>`:""}`)}

function actionAlertMenu(id){
 const a=alerts.find(x=>x.id===id);if(!a||!a.dbId){toast("This alert cannot be updated.");return}
 openModal(`Update alert · ${esc(a.id)}`,"Choose a status action for this alert.",`<div class="detail-field"><span>Current status</span><strong>${esc(a.status)}</strong></div><div class="detail-note">Status changes are saved to the backend and reflected across the dashboard.</div>`,`<button class="btn" data-action="close-modal">Cancel</button><button class="btn" data-action="review-alert" data-id="${esc(id)}">Mark reviewed</button><button class="btn btn-primary" data-action="resolve-alert" data-id="${esc(id)}">Mark resolved</button>`);
}
function showAssign(busId="",alertDisplayId=""){
 const available=checkers.filter(c=>c.availability==="Available");
 if(!available.length){toast("No checkers are currently available.");return}
 const selectedAlert=alerts.find(a=>a.id===alertDisplayId);
 const activeAlerts=alerts.filter(a=>a.status!=="Resolved");
 const assignableBuses=fleetBuses.length?fleetBuses:[...new Map(activeAlerts.map(a=>[a.bus,{id:a.bus,route:a.route}])).values()];
 const selectedBus=busId||selectedAlert?.bus||assignableBuses[0]?.id||"";
 const defaultLocation=assignableBuses.find(b=>b.id===selectedBus)?.next||selectedAlert?.stop||"";
 openModal("Assign checker","Choose a bus, available checker, and inspection location.",`<form id="modalAssignForm" class="form-grid"><div class="form-group full"><label for="modalAssignBus">Bus</label><select class="form-control" id="modalAssignBus" required>${assignableBuses.map(b=>`<option value="${esc(b.id)}" ${selectedBus===b.id?"selected":""}>${esc(b.id)} · ${esc(b.route||"Unassigned route")}</option>`).join("")}</select></div><div class="form-group"><label for="modalAssignChecker">Available checker</label><select class="form-control" id="modalAssignChecker" required>${available.map(c=>`<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")}</select></div><div class="form-group"><label for="modalAssignAlert">Related alert</label><select class="form-control" id="modalAssignAlert"><option value="">None</option>${activeAlerts.map(a=>`<option value="${esc(a.id)}" ${alertDisplayId===a.id?"selected":""}>${esc(a.id)} · ${esc(a.bus)}</option>`).join("")}</select></div><div class="form-group full"><label for="modalAssignLocation">Inspection location</label><input class="form-control" id="modalAssignLocation" required value="${esc(defaultLocation)}" placeholder="Checkpoint or bus stand"/></div><div class="form-group full"><label for="modalAssignNotes">Notes</label><input class="form-control" id="modalAssignNotes" placeholder="Optional instructions"/></div></form>`,`<button class="btn" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="submit-modal-assignment">Confirm assignment</button>`);
}
async function setAlertStatus(id,status){
 const a=alerts.find(x=>x.id===id);if(!a||!a.dbId){toast("This alert cannot be updated.");return}
 try{
   await apiRequest(`/api/alerts/${a.dbId}/status`,{method:"PUT",body:JSON.stringify({status})});
   await loadAlerts();
   closeModal();render();toast(`${id} marked ${status.toLowerCase()}.`);
 }catch(error){toast(error.message||"Failed to update alert status.")}
}
async function submitAssignment(busId,checkerId,location,alertDisplayId="",notes=""){
 const alert=alerts.find(a=>a.id===alertDisplayId);
 const bus=fleetBuses.find(b=>b.id===busId);
 if(!busId||!checkerId||!location){toast("Bus, checker, and location are required.");return}
 try{
   const data=await apiRequest("/api/checker-dispatches",{method:"POST",body:JSON.stringify({
     bus_id:busId,
     checker_id:checkerId,
     location,
     checkpoint:location,
     notes,
     alert_id:alert?.dbId||null,
     route:bus?.route||alert?.route||"",
     trip_id:alert?.tripId||""
   })});
   await Promise.all([loadCheckers(),loadInspections(),loadAlerts()]);
   closeModal();render();
   toast(`${data.dispatch?.checker_name||"Checker"} dispatched. Inspection #${data.dispatch?.id||""}.`);
 }catch(error){toast(error.message||"Failed to create checker dispatch.")}
}
function showCompleteDispatch(id){
 const item=inspections.find(i=>i.id===id);if(!item)return;
 if(item.status==="Completed"){toast("This inspection is already complete.");return}
 openModal(`Complete inspection · ${esc(item.id)}`,"Record the checker outcome and any findings.",`<div class="detail-grid">${[["Bus",item.bus],["Checker",item.checker],["Location",item.location]].map(([k,v])=>`<div class="detail-field"><span>${k}</span><strong>${esc(v)}</strong></div>`).join("")}</div><div class="form-group" style="margin-top:12px"><label for="completionOutcome">Outcome</label><select class="form-control" id="completionOutcome"><option>Mismatch Confirmed</option><option>No Mismatch Found</option><option>Inconclusive</option></select></div><div class="form-group" style="margin-top:11px"><label for="completionNotes">Findings / notes</label><input class="form-control" id="completionNotes" placeholder="Optional inspection findings"/></div>`,`<button class="btn" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="submit-dispatch-completion" data-id="${esc(item.id)}">Save outcome</button>`);
}
async function submitDispatchCompletion(inspectionId){
 const item=inspections.find(i=>i.id===inspectionId);if(!item?.dispatchId){toast("Dispatch record not found.");return}
 const outcome=$("#completionOutcome")?.value||"Inconclusive";
 const notes=$("#completionNotes")?.value.trim()||"";
 try{
   await apiRequest(`/api/checker-dispatches/${item.dispatchId}/complete`,{method:"POST",body:JSON.stringify({outcome,notes,mismatch_confirmed:outcome==="Mismatch Confirmed"})});
   await Promise.all([loadCheckers(),loadInspections(),loadAlerts()]);
   closeModal();render();toast(`${inspectionId} completed: ${outcome}.`);
 }catch(error){toast(error.message||"Failed to complete inspection.")}
}
function showBusForm(id=""){
 const b=buses.find(x=>x.id===id),isEdit=!!b;
 openModal(isEdit?`Edit bus · ${esc(b.id)}`:"Add a bus","Changes are held in local browser memory only.",`<form id="busForm" class="form-grid"><div class="form-group"><label for="busReg">Registration number</label><input id="busReg" class="form-control" required value="${esc(b?.id||"")}" placeholder="MH-12-AB-1234"/></div><div class="form-group"><label for="busFleet">Fleet ID</label><input id="busFleet" class="form-control" required value="${esc(b?.fleet||"")}" placeholder="ST-1401"/></div><div class="form-group full"><label for="busRoute">Route</label><select id="busRoute" class="form-control">${routes.map(r=>`<option ${b?.route===r?"selected":""}>${esc(r)}</option>`).join("")}</select></div><div class="form-group"><label for="busDepot">Depot</label><input id="busDepot" class="form-control" required value="${esc(b?.depot||"Swargate")}"/></div><div class="form-group"><label for="busCapacity">Capacity</label><input id="busCapacity" class="form-control" type="number" min="1" max="100" required value="${b?.capacity||52}"/></div><div class="form-group full"><label for="busOperator">Assigned conductor or driver</label><input id="busOperator" class="form-control" required value="${esc(b?.operator||"")}"/></div></form>`,`<button class="btn" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="save-bus" data-id="${esc(id)}">${isEdit?"Save changes":"Add bus"}</button>`);
}
function saveBus(id){
 const form=$("#busForm");if(!form.reportValidity())return;
 const record={id:$("#busReg").value.trim().toUpperCase(),fleet:$("#busFleet").value.trim().toUpperCase(),route:$("#busRoute").value,depot:$("#busDepot").value.trim(),capacity:Number($("#busCapacity").value),operator:$("#busOperator").value.trim(),passengers:0,tickets:0,mismatch:0,occupancy:0,status:"Normal",stop:"—",next:"—",updated:"Just now"};
 if(id){const original=buses.find(b=>b.id===id);Object.assign(original,record);if(original.id!==id)original.id=record.id}
 else {if(buses.some(b=>b.id===record.id)){toast("A bus with that registration number already exists.");return}buses.unshift(record)}
 closeModal();render();toast(id?"Bus details updated locally.":"Demo bus added to the fleet.");
}
function currentAlertFilters(){
 return {
   severity:$("#severityFilter")?.value??"",
   state:$("#alertStatusFilter")?.value??"",
   route:$("#alertRouteFilter")?.value??"",
   query:$("#alertSearch")?.value.toLowerCase().trim()??""
 };
}
function filteredAlerts(){
 const filters=currentAlertFilters();
 return alerts.filter(alert=>
   (!filters.severity||alert.severity===filters.severity)&&
   (!filters.state||alert.status===filters.state)&&
   (!filters.route||alert.route===filters.route)&&
   (!filters.query||`${alert.id} ${alert.bus} ${alert.route} ${alert.stop}`.toLowerCase().includes(filters.query))
 );
}
function alertCsvRows(records){
 return [
   ["Alert ID","Bus number","Route","Checkpoint","Detected passengers","Expected passengers","Variance","Detection time","Severity","Status","Trip ID"],
   ...records.map(alert=>[alert.id,alert.bus,alert.route,alert.stop,alert.passengers,alert.tickets,alert.difference,alert.createdAt||alert.time,alert.severity,alert.status,alert.tripId])
 ];
}
function exportFilteredAlerts(){
 const records=filteredAlerts();
 if(!records.length){toast("There are no matching alerts to export.");return}
 downloadCsv(`smart-st-alerts-${dayKey(new Date())}.csv`,alertCsvRows(records));
 toast(`${records.length} alert record${records.length===1?"":"s"} exported.`);
}
function exportAnalyticsCsv(){
 if(!analyticsData){toast("Passenger analytics have not loaded yet.");return}
 const summary=analyticsData.summary||{};
 const routes=analyticsData.route_breakdown||[];
 const buses=analyticsData.bus_breakdown||[];
 const rows=[
   ["SMART ST Passenger Analytics"],
   ["Period",analyticsDays===1?"Today":`Last ${analyticsDays} days`],
   ["Route",analyticsRoute||"All routes"],
   ["Generated",new Date().toISOString()],
   [],
   ["Summary metric","Value"],
   ["Expected passengers",summary.expected_passengers],
   ["Ticket passengers",summary.ticket_passengers],
   ["Pass passengers",summary.pass_passengers],
   ["Ticket revenue",summary.revenue],
   ["Checkpoints",summary.checkpoint_count],
   ["Mismatch checkpoints",summary.mismatch_checkpoints],
   ["Average variance",summary.average_variance],
   ["Open alerts",summary.open_alerts],
   [],
   ["Route","Ticket passengers","Pass passengers","Revenue","Checkpoints","Mismatches","Alerts"],
   ...routes.map(row=>[row.route,row.ticket_passengers,row.pass_passengers,row.revenue,row.checkpoint_count,row.mismatches,row.alerts]),
   [],
   ["Bus","Route","Ticket passengers","Pass passengers","Camera estimate","Capacity","Variance"],
   ...buses.map(row=>[row.bus_id,row.route,row.ticket_passengers,row.pass_passengers,row.camera_estimate,row.capacity,row.difference_abs])
 ];
 downloadCsv(`smart-st-passenger-analytics-${dayKey(new Date())}.csv`,rows);
 toast("Passenger analytics exported as CSV.");
}
function exportReportCsv(){
 const scopedAlerts=alerts.filter(alert=>inDayRange(alert.createdAt,reportDays)&&(!reportRoute||alert.route===reportRoute));
 const scopedInspections=inspections.filter(item=>inDayRange(item.createdAt,reportDays)&&(!reportRoute||item.route===reportRoute));
 const resolved=scopedAlerts.filter(alert=>alert.status==="Resolved").length;
 const confirmed=scopedInspections.filter(item=>item.outcome==="Mismatch Confirmed").length;
 const completed=scopedInspections.filter(item=>item.status==="Completed").length;
 const routeNames=[...new Set([...scopedAlerts.map(alert=>alert.route),...scopedInspections.map(item=>item.route)].filter(Boolean))].sort();
 const rows=[
   ["SMART ST Operational Report"],
   ["Period",reportDays===1?"Today":`Last ${reportDays} days`],
   ["Route",reportRoute||"All routes"],
   ["Generated",new Date().toISOString()],
   [],
   ["Summary metric","Value"],
   ["Alerts",scopedAlerts.length],
   ["Resolved alerts",resolved],
   ["Resolution rate",`${scopedAlerts.length?Math.round(resolved/scopedAlerts.length*100):0}%`],
   ["High severity alerts",scopedAlerts.filter(alert=>alert.severity==="High").length],
   ["Inspections",scopedInspections.length],
   ["Completed inspections",completed],
   ["Confirmed mismatches",confirmed],
   [],
   ["Route","Alerts","High severity","Inspections","Confirmed","Resolution rate"],
   ...routeNames.map(routeName=>{
     const routeAlerts=scopedAlerts.filter(alert=>alert.route===routeName);
     const routeResolved=routeAlerts.filter(alert=>alert.status==="Resolved").length;
     return [
       routeName,
       routeAlerts.length,
       routeAlerts.filter(alert=>alert.severity==="High").length,
       scopedInspections.filter(item=>item.route===routeName).length,
       scopedInspections.filter(item=>item.route===routeName&&item.outcome==="Mismatch Confirmed").length,
       `${routeAlerts.length?Math.round(routeResolved/routeAlerts.length*100):0}%`
     ];
   }),
   [],
   ["Alert ID","Bus number","Route","Checkpoint","Detected passengers","Expected passengers","Variance","Detection time","Severity","Status"],
   ...scopedAlerts.map(alert=>[alert.id,alert.bus,alert.route,alert.stop,alert.passengers,alert.tickets,alert.difference,alert.createdAt||alert.time,alert.severity,alert.status])
 ];
 downloadCsv(`smart-st-operational-report-${dayKey(new Date())}.csv`,rows);
 toast(`Report exported with ${scopedAlerts.length} alert records.`);
}
function wirePageControls(){
 $("#busSearch")?.addEventListener("input",()=>{const rows=filterBuses();$("#liveBusTable").innerHTML=busTable(rows);$("#busResultCount").textContent=`${rows.length} buses`});
 ["busStatusFilter","busRouteFilter"].forEach(id=>$("#"+id)?.addEventListener("change",()=>{const rows=filterBuses();$("#liveBusTable").innerHTML=busTable(rows);$("#busResultCount").textContent=`${rows.length} buses`}));
 $("#alertSearch")?.addEventListener("input",e=>{const value=e.target.value,start=e.target.selectionStart,y=window.scrollY;render();const input=$("#alertSearch");input?.focus();input?.setSelectionRange(start,start);window.scrollTo(0,y)});
 ["severityFilter","alertStatusFilter","alertRouteFilter"].forEach(id=>$("#"+id)?.addEventListener("change",()=>render()));
 $("#manageSearch")?.addEventListener("input",managementRows);$("#manageStatus")?.addEventListener("change",managementRows);
 $("#historySearch")?.addEventListener("input",historyRows);["historyStatus","historyRoute"].forEach(id=>$("#"+id)?.addEventListener("change",historyRows));
 $("#assignmentForm")?.addEventListener("submit",e=>{e.preventDefault();submitAssignment($("#assignBus").value,$("#assignChecker").value,$("#assignStop").value.trim(),$("#assignAlert").value,$("#assignNotes").value.trim())});
  $("#analyticsRange")?.addEventListener("change",e=>{analyticsDays=Number(e.target.value)||7;refreshAnalytics()});
  $("#analyticsRoute")?.addEventListener("change",e=>{analyticsRoute=e.target.value;refreshAnalytics()});
  $("#reportRoute")?.addEventListener("change",e=>{reportRoute=e.target.value;render()});
  $("#modalAssignForm")?.addEventListener("submit",e=>e.preventDefault());
}

function handleDocumentClick(e){
 const button=e.target.closest("[data-action],[data-page],[data-goto]");
 if(button?.dataset.page){e.preventDefault();gotoPage(button.dataset.page);return}
 if(button?.dataset.goto){gotoPage(button.dataset.goto);return}
 if(e.target.closest("#sidebarToggle")){if(innerWidth<=900)document.body.classList.toggle("sidebar-open");else{sidebarCollapsed=!sidebarCollapsed;document.body.classList.toggle("sidebar-collapsed",sidebarCollapsed)}return}
 if(e.target.closest("#notificationButton")){openModal("Notifications","Open mismatch alerts from the backend.",`<div class="alert-list">${alerts.filter(a=>a.status!=="Resolved").slice(0,4).map(a=>`<div class="alert-item"><span class="alert-indicator"></span><div class="alert-main"><strong>${esc(a.id)} · ${esc(a.bus)}</strong><p>${a.mismatch} passenger variance · ${esc(a.time)}</p></div>${badge(a.severity)}</div>`).join("")||`<div class="empty-state">${alertsLoaded?"No open alerts.":"Loading alerts…"}</div>`}</div>`,`<button class="btn" data-action="close-modal">Close</button><button class="btn btn-primary" data-goto="Mismatch Alerts">Open alerts</button>`);return}
 if(e.target.closest("#profileButton")){openModal("Admin profile","Demo profile controls are local only.",`<div class="detail-grid"><div class="detail-field"><span>Name</span><strong>${esc($("#adminName")?.value||"Admin")}</strong></div><div class="detail-field"><span>Role</span><strong>Control room administrator</strong></div></div><div class="detail-note">No authentication or account management is configured in this frontend demonstration.</div>`,`<button class="btn btn-primary" data-action="close-modal">Close</button>`);return}
 if(e.target.matches("[data-close-backdrop]")){closeModal();return}
 if(!button)return;
 const {action,id}=button.dataset;
 if(action==="bus-detail")showBus(id);
 else if(action==="alert-detail")showAlert(id);
 else if(action==="alert-menu")actionAlertMenu(id);
 else if(action==="inspection-detail")showInspection(id);
 else if(action==="close-modal")closeModal();
 else if(action==="review-alert")setAlertStatus(id,"Under Review");
 else if(action==="resolve-alert")setAlertStatus(id,"Resolved");
 else if(action==="assign-checker")showAssign();
 else if(action==="assign-from-bus"){closeModal();gotoPage("Checker Dispatch");showAssign(id)}
 else if(action==="assign-from-alert"){const alert=alerts.find(a=>a.id===id);closeModal();gotoPage("Checker Dispatch");showAssign(alert?.bus||"",id)}
 else if(action==="complete-dispatch")showCompleteDispatch(id);
 else if(action==="submit-dispatch-completion")submitDispatchCompletion(id);
 else if(action==="add-bus")showBusForm();
 else if(action==="edit-bus")showBusForm(id);
 else if(action==="save-bus")saveBus(id);
 else if(action==="submit-modal-assignment"){const form=$("#modalAssignForm");if(form.reportValidity())submitAssignment($("#modalAssignBus").value,$("#modalAssignChecker").value,$("#modalAssignLocation").value.trim(),$("#modalAssignAlert").value,$("#modalAssignNotes").value.trim())}
 else if(action==="export-report")exportReportCsv();
 else if(action==="export-filtered-alerts")exportFilteredAlerts();
 else if(action==="export-analytics")exportAnalyticsCsv();
 else if(action==="clear-alert-filters"){["alertSearch","severityFilter","alertStatusFilter","alertRouteFilter"].forEach(elementId=>{const element=$("#"+elementId);if(element)element.value=""});render()}
 else if(action==="set-analytics-days"){analyticsDays=Number(button.dataset.days)||7;refreshAnalytics()}
 else if(action==="set-report-days"){reportDays=Number(button.dataset.days)||7;render()}
 else if(action==="print-report"){document.body.classList.add("printing-report");window.print();setTimeout(()=>document.body.classList.remove("printing-report"),600)}
 else if(action==="refresh-alerts")refreshAlertsPage();
 else if(action==="refresh-analytics")refreshAnalytics();
 else if(action==="refresh-inspections")refreshDispatchData();
 else if(action==="refresh"){render();toast("Fleet view refreshed.")}
 else if(action==="save-settings"){if($("#adminEmail")&&!$("#adminEmail").reportValidity())return;settings.adminName=$("#adminName")?.value.trim()||"Admin";settings.adminEmail=$("#adminEmail")?.value.trim()||settings.adminEmail;applySettings();toast("Preferences saved for this page session.")}
}
function handleGlobalSearch(e){
 const query=e.target.value;globalQuery=query;
 if(query.trim()&&currentPage!=="Live Bus Monitoring"){gotoPage("Live Bus Monitoring");globalQuery=query;$("#globalSearch").value=query}
 if(currentPage==="Live Bus Monitoring"){const input=$("#busSearch");if(input){input.value=query;input.dispatchEvent(new Event("input"))}}
}
function handleGlobalSearchKeydown(e){if(e.key==="Escape"){e.target.value="";globalQuery="";if($("#busSearch")){$("#busSearch").value="";$("#busSearch").dispatchEvent(new Event("input"))}}}
function handleDocumentKeydown(e){if(e.key==="Escape")closeModal();if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="k"){e.preventDefault();$("#globalSearch").focus()}}
function updateDate(){const now=new Date();$("#topDate").textContent=now.toLocaleDateString("en-IN",{weekday:"short",day:"2-digit",month:"short"})+" · "+now.toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit",hour12:!settings.time24})}

export function initializeDashboard(){
 const globalSearch=$("#globalSearch");
 document.addEventListener("click",handleDocumentClick);
 document.addEventListener("keydown",handleDocumentKeydown);
 globalSearch.addEventListener("input",handleGlobalSearch);
 globalSearch.addEventListener("keydown",handleGlobalSearchKeydown);
 const dateInterval=setInterval(updateDate,60000);
 updateDate();
 render();
 loadInitialData();
 return ()=>{
  document.removeEventListener("click",handleDocumentClick);
  document.removeEventListener("keydown",handleDocumentKeydown);
  globalSearch.removeEventListener("input",handleGlobalSearch);
  globalSearch.removeEventListener("keydown",handleGlobalSearchKeydown);
  clearInterval(dateInterval);
  stopComparisonPolling();
 };
}
