/* SMART ST is a frontend-only demonstration. All records below are mock data. */
const pageNames = ["Overview Dashboard","Live Bus Monitoring","Mismatch Alerts","Bus & Route Management","Passenger Analytics","Checker Dispatch","Inspection History","Reports & Analytics","Settings"];
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
let alerts = [
  {id:"ALT-24081",bus:buses[0].id,route:routes[0],passengers:46,tickets:44,mismatch:2,time:"10:42 AM",severity:"Medium",status:"New",stop:"Lonavala"},
  {id:"ALT-24080",bus:buses[2].id,route:routes[2],passengers:49,tickets:45,mismatch:4,time:"10:38 AM",severity:"High",status:"New",stop:"Karad"},
  {id:"ALT-24079",bus:buses[4].id,route:routes[4],passengers:43,tickets:41,mismatch:2,time:"10:21 AM",severity:"Medium",status:"Under Review",stop:"Indapur"},
  {id:"ALT-24077",bus:buses[6].id,route:routes[0],passengers:51,tickets:47,mismatch:4,time:"09:56 AM",severity:"High",status:"New",stop:"Khopoli"},
  {id:"ALT-24075",bus:"MH-12-KL-2811",route:routes[3],passengers:40,tickets:39,mismatch:1,time:"09:32 AM",severity:"Low",status:"Resolved",stop:"Shirwal"},
  {id:"ALT-24072",bus:"MH-14-TR-7104",route:routes[1],passengers:44,tickets:42,mismatch:2,time:"09:08 AM",severity:"Medium",status:"Under Review",stop:"Sangamner"}
];
let inspections = [
  {id:"INSP-6018",bus:buses[1].id,route:routes[1],checker:"Pravin Deshmukh",location:"Sangamner Bus Stand",mismatch:"No",outcome:"No Mismatch Found",time:"Today, 10:16 AM"},
  {id:"INSP-6017",bus:buses[4].id,route:routes[4],checker:"Meena Patil",location:"Indapur Bypass",mismatch:"Yes · 2",outcome:"Mismatch Confirmed",time:"Today, 09:48 AM"},
  {id:"INSP-6016",bus:buses[2].id,route:routes[2],checker:"Rahul Gaikwad",location:"Karad Bus Stand",mismatch:"Pending",outcome:"Inspection Pending",time:"Today, 09:41 AM"},
  {id:"INSP-6015",bus:"MH-12-KL-2811",route:routes[3],checker:"Sunita More",location:"Shirwal Checkpoint",mismatch:"No",outcome:"No Mismatch Found",time:"Today, 09:22 AM"},
  {id:"INSP-6014",bus:buses[0].id,route:routes[0],checker:"Ajay Jadhav",location:"Lonavala Depot",mismatch:"Yes · 1",outcome:"Mismatch Confirmed",time:"Today, 08:57 AM"}
];
let checkers = [
  {name:"Pravin Deshmukh",id:"CHK-018",availability:"Available",bus:"—",location:"Pune · Shivajinagar",task:"Standby"},
  {name:"Meena Patil",id:"CHK-024",availability:"On inspection",bus:buses[4].id,location:"Indapur Bypass",task:"Passenger check"},
  {name:"Rahul Gaikwad",id:"CHK-031",availability:"On inspection",bus:buses[2].id,location:"Karad Bus Stand",task:"Mismatch verification"},
  {name:"Sunita More",id:"CHK-012",availability:"Available",bus:"—",location:"Pune · Swargate",task:"Standby"},
  {name:"Ajay Jadhav",id:"CHK-027",availability:"Available",bus:"—",location:"Lonavala Depot",task:"Standby"}
];
let currentPage="Overview Dashboard", selectedBus=null, globalQuery="", sidebarCollapsed=false;
const settings={adminName:"Admin",adminEmail:"admin@smartst.demo",fleetOverview:true,compactTables:false,demoLabels:true,mismatchThreshold:"2 passengers",highThreshold:"4 passengers",highAlerts:true,assignmentUpdates:true,dailySummary:false,theme:"Light",time24:false};
const $ = (s,root=document)=>root.querySelector(s);
const esc = value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const statusClass = value => {
  if (/Normal|Available|No Mismatch Found|Mismatch Confirmed/i.test(value)) return "status-normal";
  if (/Mismatch Detected|New|High|Confirmed/i.test(value)) return "status-mismatch";
  if (/Pending|inspection/i.test(value)) return "status-pending";
  if (/Review|On inspection/i.test(value)) return "status-reviewed";
  if (/Resolved/i.test(value)) return "status-resolved";
  return "status-reviewed";
};
const badge = text=>`<span class="status ${statusClass(text)}">${esc(text)}</span>`;
const title = (name,desc,actions="")=>`<div class="page-heading"><div><h1>${esc(name)}</h1><p>${desc}</p></div><div class="heading-actions"><span class="demo-tag">DEMO DATA</span>${actions}</div></div>`;
const kpi=(label,value,icon,note,tone="")=>`<article class="kpi-card"><div class="kpi-top"><span class="kpi-label">${label}</span><span class="kpi-icon ${tone}">${icon}</span></div><div class="kpi-value">${value}</div><div class="kpi-foot">${note}</div></article>`;
const progress=(amount)=>`<div class="occupancy"><div class="progress"><i class="${amount>90?"high":amount>75?"medium":""}" style="width:${amount}%"></i></div><span>${amount}%</span></div>`;
const busTable=(rows,short=false)=>`<div class="fleet-table-wrap"><table class="fleet-table"><thead><tr><th>Bus number</th><th>Route</th><th>Current stop</th><th>Passengers</th><th>Tickets</th><th>Mismatch</th><th>Occupancy</th><th>Status</th><th>Updated</th></tr></thead><tbody>${rows.length?rows.slice(0,short?5:100).map(b=>`<tr data-bus-row="${esc(b.id)}"><td class="bus-id"><button class="btn-text" data-action="bus-detail" data-id="${esc(b.id)}">${esc(b.id)}</button></td><td class="route-name">${esc(b.route)}</td><td>${esc(b.stop)}</td><td>${b.passengers}</td><td>${b.tickets}</td><td class="${b.mismatch?"number-bad":""}">${b.mismatch||"—"}</td><td>${progress(b.occupancy)}</td><td>${badge(b.status)}</td><td class="subtle">${esc(b.updated)}</td></tr>`).join(""):`<tr><td colspan="9"><div class="empty-state"><strong>No buses found</strong>Try adjusting your search or filters.</div></td></tr>`}</tbody></table></div>`;

function lineChart(seriesA,seriesB,labels,legendA,legendB){
  const w=520,h=190,pad={l:28,r:12,t:10,b:27},cw=w-pad.l-pad.r,ch=h-pad.t-pad.b;
  const max=Math.ceil(Math.max(...seriesA,...seriesB)/5)*5||10;
  const points=a=>a.map((v,i)=>`${pad.l+i*cw/(a.length-1)},${pad.t+ch-(v/max)*ch}`).join(" ");
  const circles=a=>a.map((v,i)=>`<circle class="chart-dot" cx="${pad.l+i*cw/(a.length-1)}" cy="${pad.t+ch-(v/max)*ch}" r="3"/>`).join("");
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(legendA)} and ${esc(legendB)} trend chart">${[0,1,2,3].map(i=>{let y=pad.t+ch*i/3;return `<line class="chart-gridline" x1="${pad.l}" x2="${w-pad.r}" y1="${y}" y2="${y}"/><text class="chart-label" x="1" y="${y+3}">${Math.round(max*(1-i/3))}</text>`}).join("")}${labels.map((l,i)=>`<text class="chart-label" text-anchor="middle" x="${pad.l+i*cw/(labels.length-1)}" y="${h-5}">${esc(l)}</text>`).join("")}<polyline class="chart-line" points="${points(seriesA)}"/>${circles(seriesA)}<polyline class="chart-line secondary" points="${points(seriesB)}"/>${circles(seriesB).replaceAll("chart-dot", "chart-dot teal")}</svg><div class="chart-legend"><span class="legend-item"><i class="legend-dot"></i>${esc(legendA)}</span><span class="legend-item"><i class="legend-dot teal"></i>${esc(legendB)}</span></div>`;
}
function alertItems(){return alerts.filter(a=>a.status!=="Resolved").slice(0,4).map(a=>`<div class="alert-item"><span class="alert-indicator ${a.severity==="Low"?"medium":""}"></span><div class="alert-main"><strong>${esc(a.bus)} · ${a.mismatch} passenger mismatch${a.mismatch===1?"":"es"}</strong><p>${esc(a.route)} · ${esc(a.stop)} · ${esc(a.time)}</p></div><button class="btn-text" data-action="alert-detail" data-id="${esc(a.id)}">View</button></div>`).join("")||`<div class="empty-state">No active alerts.</div>`}

function renderDashboard(){
 const totalP=buses.reduce((n,b)=>n+b.passengers,0), totalT=buses.reduce((n,b)=>n+b.tickets,0);
 return `${title("Overview Dashboard","Good morning, Admin. Here's your fleet snapshot for today.")}
 <div class="kpi-grid">${kpi("Active Buses","248","▣",'<span class="trend-up">↑ 6.2%</span> vs yesterday')}${kpi("Total Passengers","1,842","♙",'<span class="trend-up">↑ 12.4%</span> since 8 AM',"teal")}${kpi("Tickets Recorded","1,796","▤",'<span class="trend-up">↑ 11.8%</span> since 8 AM')}${kpi("Passenger–Ticket Mismatches","46","⚑",'<span class="trend-warn">12 require review</span>',"red")}${kpi("Pending Inspections","08","◷",'<span class="trend-warn">3 high priority</span>',"amber")}${kpi("Inspections Completed","34","✓",'<span class="trend-up">↑ 4</span> in the last hour',"teal")}</div>
 <div class="dashboard-grid"><section class="panel"><div class="panel-heading"><div><h2>Mismatch monitoring</h2><div class="panel-subtitle">Alert volume across active routes · sample hourly trend</div></div><select class="select-small" aria-label="Mismatch chart period"><option>Today</option><option>This week</option></select></div><div class="chart-area">${lineChart([3,5,4,8,6,11,8,14,10,13,9,16],[1,2,2,4,3,6,4,8,5,7,4,9],["6 AM","7 AM","8 AM","9 AM","10 AM","11 AM","12 PM","1 PM","2 PM","3 PM","4 PM","5 PM"],"Alerts detected","Reviewed")}</div></section>
 <section class="panel"><div class="panel-heading"><div><h2>Passenger vs ticket count</h2><div class="panel-subtitle">Live sample comparison · current fleet</div></div><span class="mini-pill">Last 6 hours</span></div><div class="chart-area">${lineChart([24,31,29,38,35,46,42,51],[23,30,28,37,34,43,40,47],["6 AM","7 AM","8 AM","9 AM","10 AM","11 AM","12 PM","1 PM"],"Passengers","Tickets")}</div></section></div>
 <div class="dashboard-grid"><section class="panel ${settings.fleetOverview?"":"fleet-hidden"}"><div class="panel-heading"><div><h2>Live fleet overview</h2><div class="panel-subtitle">A snapshot of buses currently on active routes</div></div><button class="btn-text" data-goto="Live Bus Monitoring">View all buses →</button></div>${busTable(buses,true)}</section><section class="panel"><div class="panel-heading"><div><h2>Recent mismatch alerts</h2><div class="panel-subtitle">Requires attention from the control room</div></div><button class="btn-text" data-goto="Mismatch Alerts">All alerts →</button></div><div class="alert-list">${alertItems()}</div><div class="inspection-strip"><div class="inspection-stat"><strong class="stat-green">34</strong><span>Completed</span></div><div class="inspection-stat"><strong>08</strong><span>Pending</span></div><div class="inspection-stat"><strong>18 <small style="font-size:10px">min</small></strong><span>Avg response</span></div></div></section></div>
 <p class="panel-subtitle" style="text-align:right;margin:8px 2px 0">Summary metrics and chart values are illustrative demonstration data.</p>`;
}

function renderLive(){
 return `${title("Live Bus Monitoring","Monitor active buses, route activity, and passenger–ticket variance.",'<button class="btn" data-action="refresh">↻ Refresh</button>')}
 <div class="kpi-grid">${kpi("Active on routes","248","▣","Across 18 routes")}${kpi("Normal status","214","✓","86% of active fleet","teal")}${kpi("Mismatch detected","26","⚑","8 need immediate attention","red")}${kpi("Inspection pending","08","◷","Checkers en route","amber")}</div>
 <div class="toolbar"><input id="busSearch" placeholder="Search bus number or route..." aria-label="Search buses" value="${esc(globalQuery)}" /><select id="busStatusFilter" aria-label="Filter by bus status"><option value="">All statuses</option><option>Normal</option><option>Mismatch Detected</option><option>Inspection Pending</option></select><select id="busRouteFilter" aria-label="Filter by route"><option value="">All routes</option>${routes.map(r=>`<option>${esc(r)}</option>`).join("")}</select><span class="toolbar-spacer"></span><span class="mini-pill">Positions are illustrative · no live GPS</span></div>
 <div class="monitor-layout"><section class="panel"><div class="panel-heading"><div><h2>Fleet activity</h2><div class="panel-subtitle">Select a bus to inspect its sample activity</div></div><span class="mini-pill" id="busResultCount">${buses.length} buses</span></div><div id="liveBusTable">${busTable(filterBuses(),false)}</div></section><section class="panel"><div class="panel-heading"><div><h2>Route map</h2><div class="panel-subtitle">Schematic view · sample bus markers</div></div><span class="mini-pill">Maharashtra</span></div><div class="map-card"><div class="map-grid"></div><div class="map-river"></div><i class="map-road road-one"></i><i class="map-road road-two"></i><span class="map-label mumbai">Mumbai</span><span class="map-label pune">Pune</span><span class="map-label nashik">Nashik</span><span class="map-label kolhapur">Kolhapur</span><button class="map-marker m1 warn" data-action="bus-detail" data-id="${esc(buses[0].id)}" aria-label="Open bus ${esc(buses[0].id)}"><span>1</span></button><button class="map-marker m2" data-action="bus-detail" data-id="${esc(buses[1].id)}" aria-label="Open bus ${esc(buses[1].id)}"><span>2</span></button><button class="map-marker m3 warn" data-action="bus-detail" data-id="${esc(buses[2].id)}" aria-label="Open bus ${esc(buses[2].id)}"><span>3</span></button><button class="map-marker m4" data-action="bus-detail" data-id="${esc(buses[5].id)}" aria-label="Open bus ${esc(buses[5].id)}"><span>4</span></button><div class="map-caption">Visual mockup · markers do not indicate real bus locations</div></div><div class="detail-list"><div><span>Visible routes</span><strong>6 corridors</strong></div><div><span>Fleet capacity in sample</span><strong>52 seats per bus</strong></div></div></section></div>`;
}
function filterBuses(){
 const q=($("#busSearch")?.value??globalQuery).toLowerCase(), st=$("#busStatusFilter")?.value??"",rt=$("#busRouteFilter")?.value??"";
 return buses.filter(b=>(!q||`${b.id} ${b.route} ${b.stop}`.toLowerCase().includes(q))&&(!st||b.status===st)&&(!rt||b.route===rt));
}

function renderAlerts(){
 const severity=$("#severityFilter")?.value??"",state=$("#alertStatusFilter")?.value??"",route=$("#alertRouteFilter")?.value??"",q=$("#alertSearch")?.value.toLowerCase()??"";
 const data=alerts.filter(a=>(!severity||a.severity===severity)&&(!state||a.status===state)&&(!route||a.route===route)&&(!q||`${a.id} ${a.bus} ${a.route}`.toLowerCase().includes(q)));
 return `${title("Mismatch Alerts","Review passenger–ticket variance alerts and coordinate targeted inspections.")}
 <div class="kpi-grid">${kpi("Total alerts","46","⚑","Today across all routes","red")}${kpi("High severity","08","↑","4 awaiting assignment","red")}${kpi("Under review","12","◷","Checker verification underway","amber")}${kpi("Resolved today","26","✓","57% resolution rate","teal")}</div>
 <div class="toolbar"><input id="alertSearch" placeholder="Search alert or bus..." value="${esc(q)}" aria-label="Search alerts"/><select id="severityFilter" aria-label="Filter severity"><option value="">All severities</option>${["High","Medium","Low"].map(x=>`<option ${severity===x?"selected":""}>${x}</option>`).join("")}</select><select id="alertStatusFilter" aria-label="Filter alert status"><option value="">All statuses</option>${["New","Under Review","Resolved"].map(x=>`<option ${state===x?"selected":""}>${x}</option>`).join("")}</select><select id="alertRouteFilter" aria-label="Filter alert route"><option value="">All routes</option>${routes.map(x=>`<option ${route===x?"selected":""}>${esc(x)}</option>`).join("")}</select><input type="date" aria-label="Filter alerts by date" title="Demo date filter"/></div>
 <div class="data-card"><table class="generic-table"><thead><tr><th>Alert ID</th><th>Bus number</th><th>Route</th><th>Passengers</th><th>Tickets</th><th>Mismatch</th><th>Detection time</th><th>Severity</th><th>Status</th><th>Actions</th></tr></thead><tbody>${data.length?data.map(a=>`<tr><td class="bus-id">${esc(a.id)}</td><td>${esc(a.bus)}</td><td>${esc(a.route)}</td><td>${a.passengers}</td><td>${a.tickets}</td><td class="number-bad">+${a.mismatch}</td><td>${esc(a.time)}</td><td>${badge(a.severity)}</td><td>${badge(a.status)}</td><td><div class="row-actions"><button class="btn-text" data-action="alert-detail" data-id="${esc(a.id)}">Details</button><button class="btn-text" data-action="alert-menu" data-id="${esc(a.id)}">More</button></div></td></tr>`).join(""):`<tr><td colspan="10"><div class="empty-state"><strong>No matching alerts</strong>Change or clear the filters to see alerts.</div></td></tr>`}</tbody></table></div><p class="panel-subtitle" style="margin:10px 2px">Showing ${data.length} of ${alerts.length} sample alert records.</p>`;
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
 return `${title("Passenger Analytics","Explore sample boarding patterns, ticket coverage, and route occupancy.",'<select class="select-small" id="analyticsRange" aria-label="Analytics date range"><option>Today</option><option>Last 7 days</option><option>Last 30 days</option></select>')}
 <div class="toolbar"><select id="analyticsRoute" aria-label="Filter analytics by route"><option value="">All routes</option>${routes.map(r=>`<option>${esc(r)}</option>`).join("")}</select><input type="date" aria-label="Analytics start date"/><span style="color:#9aa5b2;font-size:9px">to</span><input type="date" aria-label="Analytics end date"/><span class="toolbar-spacer"></span><span class="mini-pill">Illustrative sample period · Today</span></div>
 <div class="summary-grid" style="margin-bottom:14px">${[['Boardings recorded','1,842'],['Ticket coverage','97.5%'],['Average occupancy','76%'],['Highest mismatch route','Pune – Mumbai']].map(([l,v])=>`<div class="panel summary-card"><div class="metric">${v}</div><div class="metric-label">${l}</div></div>`).join("")}</div>
 <div class="dashboard-grid"><section class="panel"><div class="panel-heading"><div><h2>Passenger boarding trends</h2><div class="panel-subtitle">Boardings compared with ticket records · hourly sample</div></div></div><div class="chart-area">${lineChart([18,25,31,38,47,61,54,66,72,81,76,93],[17,24,30,37,45,58,53,63,70,78,73,89],["6","7","8","9","10","11","12","1","2","3","4","5"],"Passengers","Tickets")}</div></section><section class="panel"><div class="panel-heading"><div><h2>Mismatch frequency by route</h2><div class="panel-subtitle">Sample alert count by active corridor</div></div></div><div class="simple-bars">${[["Mumbai",84],["Nashik",57],["Kolhapur",72],["Satara",38],["Solapur",61],["Other",45]].map(([l,v],i)=>`<div class="bar-col"><div class="bar ${i%2?"teal":""}" style="height:${v}%"></div><span class="bar-label">${l}</span></div>`).join("")}</div></section></div>
 <div class="dashboard-grid"><section class="panel"><div class="panel-heading"><div><h2>Passenger vs ticket comparison</h2><div class="panel-subtitle">Current sample count by bus</div></div></div><div id="analyticsBusTable">${busTable(buses,false)}</div></section><section class="panel"><div class="panel-heading"><div><h2>Occupancy distribution</h2><div class="panel-subtitle">Share of buses by occupied seat range</div></div></div>${[["0–50%",31],["51–75%",43],["76–90%",57],["91–100%",22]].map(([l,n])=>`<div class="settings-row"><div style="width:74px;font-size:9px;color:#718096">${l}</div><div class="progress" style="height:7px;flex:1"><i style="width:${n}%;background:#4a80e2"></i></div><strong style="font-size:9px">${n}%</strong></div>`).join("")}</section></div>`;
}

function renderDispatch(){
 return `${title("Checker Dispatch","Coordinate sample checker assignments for flagged buses.",'<button class="btn btn-primary" data-action="assign-checker">＋ New assignment</button>')}
 <div class="summary-grid" style="margin-bottom:14px">${[['Checkers on shift','12'],['Available now','04'],['On inspection','08'],['Average response','18 min']].map(([l,v])=>`<div class="panel summary-card"><div class="metric">${v}</div><div class="metric-label">${l}</div></div>`).join("")}</div>
 <div class="dashboard-grid"><section class="panel"><div class="panel-heading"><div><h2>Checker availability</h2><div class="panel-subtitle">Sample shift roster · control room</div></div><span class="mini-pill">${checkers.length} shown</span></div><div class="data-card"><table class="generic-table"><thead><tr><th>Checker</th><th>Checker ID</th><th>Availability</th><th>Assigned bus</th><th>Location</th><th>Task</th></tr></thead><tbody>${checkers.map(c=>`<tr><td class="bus-id">${esc(c.name)}</td><td>${esc(c.id)}</td><td>${badge(c.availability)}</td><td>${esc(c.bus)}</td><td>${esc(c.location)}</td><td>${esc(c.task)}</td></tr>`).join("")}</tbody></table></div></section><section class="panel"><div class="panel-heading"><div><h2>Quick assignment</h2><div class="panel-subtitle">Local demo action only; no notifications are sent.</div></div></div><form id="assignmentForm" class="form-grid"><div class="form-group full"><label for="assignBus">Flagged bus</label><select class="form-control" id="assignBus" required>${buses.filter(b=>b.mismatch>0).map(b=>`<option value="${esc(b.id)}">${esc(b.id)} · ${esc(b.route)}</option>`).join("")}</select></div><div class="form-group"><label for="assignChecker">Available checker</label><select class="form-control" id="assignChecker" required>${checkers.filter(c=>c.availability==="Available").map(c=>`<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")}</select></div><div class="form-group"><label for="assignStop">Inspection stop</label><select class="form-control" id="assignStop" required><option>Lonavala Bus Stand</option><option>Karad Bus Stand</option><option>Indapur Bypass</option><option>Khopoli Depot</option><option>Sangamner Bus Stand</option></select></div><div class="form-group full"><button class="btn btn-primary" type="submit">Confirm assignment</button></div></form></section></div>
 <div class="section-title-row"><h2>Active inspection assignments</h2><span class="mini-pill">${inspections.filter(i=>i.outcome==="Inspection Pending").length} pending</span></div><div class="data-card"><table class="generic-table"><thead><tr><th>Inspection ID</th><th>Bus</th><th>Route</th><th>Checker</th><th>Location</th><th>Task status</th><th>Time</th></tr></thead><tbody>${inspections.map(i=>`<tr><td class="bus-id">${esc(i.id)}</td><td>${esc(i.bus)}</td><td>${esc(i.route)}</td><td>${esc(i.checker)}</td><td>${esc(i.location)}</td><td>${badge(i.outcome)}</td><td>${esc(i.time)}</td></tr>`).join("")}</tbody></table></div>`;
}

function renderHistory(){
 return `${title("Inspection History","Review checker visits and outcomes from this demonstration log.")}
 <div class="toolbar"><input id="historySearch" placeholder="Search inspection, bus, checker..." aria-label="Search inspections"/><select id="historyStatus" aria-label="Filter inspection outcome"><option value="">All outcomes</option><option>Mismatch Confirmed</option><option>No Mismatch Found</option><option>Inspection Pending</option></select><select id="historyRoute" aria-label="Filter inspection route"><option value="">All routes</option>${routes.map(r=>`<option>${esc(r)}</option>`).join("")}</select><input type="date" aria-label="Filter by inspection date"/></div><div class="data-card" id="historyTable"></div>`;
}
function historyRows(){
 const q=($("#historySearch")?.value??"").toLowerCase(),st=$("#historyStatus")?.value??"",rt=$("#historyRoute")?.value??"";
 const data=inspections.filter(i=>(!q||`${i.id} ${i.bus} ${i.checker} ${i.location}`.toLowerCase().includes(q))&&(!st||i.outcome===st)&&(!rt||i.route===rt));
 $("#historyTable").innerHTML=`<table class="generic-table"><thead><tr><th>Inspection ID</th><th>Bus number</th><th>Route</th><th>Assigned checker</th><th>Inspection location</th><th>Mismatch detected</th><th>Outcome</th><th>Date &amp; time</th><th>Details</th></tr></thead><tbody>${data.length?data.map(i=>`<tr><td class="bus-id">${esc(i.id)}</td><td>${esc(i.bus)}</td><td>${esc(i.route)}</td><td>${esc(i.checker)}</td><td>${esc(i.location)}</td><td>${esc(i.mismatch)}</td><td>${badge(i.outcome)}</td><td>${esc(i.time)}</td><td><button class="btn-text" data-action="inspection-detail" data-id="${esc(i.id)}">View</button></td></tr>`).join(""):`<tr><td colspan="9"><div class="empty-state"><strong>No matching inspections</strong>Adjust your filters.</div></td></tr>`}</tbody></table>`;
}

function renderReports(){
 return `${title("Reports & Analytics","A high-level summary of sample alert and inspection performance.",'<button class="btn btn-primary" data-action="export-report">⇩ Export CSV</button>')}
 <div class="toolbar"><label style="font-size:9px;color:#7b8a9d">From</label><input type="date" id="reportFrom" aria-label="Report start date"/><label style="font-size:9px;color:#7b8a9d">To</label><input type="date" id="reportTo" aria-label="Report end date"/><select aria-label="Report route"><option>All routes</option>${routes.map(r=>`<option>${esc(r)}</option>`).join("")}</select><span class="toolbar-spacer"></span><span class="mini-pill">Local sample report</span></div>
 <div class="summary-grid" style="margin-bottom:14px">${[['Total mismatch alerts','46'],['Confirmed mismatches','31'],['Inspections completed','34'],['Resolution rate','67%']].map(([l,v])=>`<div class="panel summary-card"><div class="metric">${v}</div><div class="metric-label">${l}</div></div>`).join("")}</div>
 <div class="dashboard-grid"><section class="panel"><div class="panel-heading"><div><h2>Daily alert and inspection trend</h2><div class="panel-subtitle">Daily sample counts · current week</div></div></div><div class="chart-area">${lineChart([16,22,18,31,27,38,46],[11,15,12,22,19,28,34],["Mon","Tue","Wed","Thu","Fri","Sat","Sun"],"Mismatch alerts","Inspections")}</div></section><section class="panel"><div class="panel-heading"><div><h2>Route-wise statistics</h2><div class="panel-subtitle">Sample mismatch volume by corridor</div></div></div><table class="generic-table"><thead><tr><th>Route</th><th>Alerts</th><th>Confirmed</th><th>Rate</th></tr></thead><tbody>${routes.slice(0,5).map((r,i)=>`<tr><td>${esc(r)}</td><td>${[14,9,8,6,5][i]}</td><td>${[10,7,5,4,3][i]}</td><td>${[71,78,63,67,60][i]}%</td></tr>`).join("")}</tbody></table></section></div>
 <div class="panel"><div class="panel-heading"><div><h2>Report notes</h2><div class="panel-subtitle">Export creates a CSV from the visible mock alert data in this browser.</div></div></div><p class="panel-subtitle" style="line-height:1.7">This report is a project demonstration and does not represent official Maharashtra State Transport statistics. Date and route controls are illustrative; exported rows are sourced from the local sample alert list.</p></div>`;
}

function renderSettings(){
 return `${title("Settings","Set local display preferences for this browser session.",'<button class="btn btn-primary" data-action="save-settings">Save preferences</button>')}
 <div class="settings-grid"><section class="panel settings-card"><h2>Admin profile</h2>${settingsRow("Display name","Shown only in this demo control room.")}<div class="form-group"><label for="adminName">Name</label><input class="form-control setting-input" id="adminName" value="${esc(settings.adminName)}" /></div><div class="form-group" style="margin-top:11px"><label for="adminEmail">Email</label><input class="form-control setting-input" id="adminEmail" type="email" value="${esc(settings.adminEmail)}" /></div></section>
 <section class="panel settings-card"><h2>Dashboard preferences</h2>${switchRow("fleetOverview","Show fleet overview","Include fleet status in the overview dashboard.")}${switchRow("compactTables","Compact data tables","Use denser table spacing throughout the app.")}${switchRow("demoLabels","Show demo data labels","Keep visible indicators that sample data is in use.")}</section>
 <section class="panel settings-card"><h2>Alert thresholds</h2><div class="settings-row"><div><strong>Mismatch alert threshold</strong><small>Passenger-ticket difference before flagging.</small></div>${settingsSelect("mismatchThreshold",["1 passenger","2 passengers","3 passengers"])}</div><div class="settings-row"><div><strong>High severity threshold</strong><small>Mark larger mismatches as high priority.</small></div>${settingsSelect("highThreshold",["3 passengers","4 passengers","5 passengers"])}</div></section>
 <section class="panel settings-card"><h2>Notification preferences</h2>${switchRow("highAlerts","High severity alerts","Show an in-app alert for high severity mismatches.")}${switchRow("assignmentUpdates","Checker assignment updates","Show local confirmation after assignments.")}${switchRow("dailySummary","Daily summary","Include daily digest in the demo notifications.")}</section>
 <section class="panel settings-card"><h2>Display settings</h2><div class="settings-row"><div><strong>Interface theme</strong><small>Theme is stored for this browser only.</small></div>${settingsSelect("theme",["Light","System"])}</div>${switchRow("time24","24-hour time","Display timestamps in 24-hour format.")}</section>
 <section class="panel settings-card"><h2>About this environment</h2><div class="settings-row"><div><strong>SMART ST Control Center</strong><small>Frontend-only engineering project demonstration.</small></div><span class="mini-pill">v1.0</span></div><div class="settings-row"><div><strong>Data source</strong><small>Local illustrative sample records. No GPS or backend.</small></div><span class="status status-pending">Demo only</span></div></section></div>`;
}
function settingsRow(label,desc){return `<div class="settings-row"><div><strong>${label}</strong><small>${desc}</small></div></div>`}
function switchRow(key,label,desc){return `<div class="settings-row"><div><strong>${label}</strong><small>${desc}</small></div><label class="switch" aria-label="${esc(label)}"><input type="checkbox" data-setting="${key}" ${settings[key]?"checked":""}/><i></i></label></div>`}
function settingsSelect(key,options){return `<select class="form-control" data-setting="${key}" style="width:112px">${options.map(option=>`<option ${settings[key]===option?"selected":""}>${esc(option)}</option>`).join("")}</select>`}

function render(){
 const content=$("#pageContent");
 const renderers={"Overview Dashboard":renderDashboard,"Live Bus Monitoring":renderLive,"Mismatch Alerts":renderAlerts,"Bus & Route Management":renderManagement,"Passenger Analytics":renderAnalytics,"Checker Dispatch":renderDispatch,"Inspection History":renderHistory,"Reports & Analytics":renderReports,"Settings":renderSettings};
 content.innerHTML=(renderers[currentPage]||renderDashboard)();
 $("#breadcrumbTitle").textContent=currentPage;
 if(currentPage==="Bus & Route Management")managementRows();
 if(currentPage==="Inspection History")historyRows();
 wirePageControls();
 wireSettings();
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
function gotoPage(name){if(!pageNames.includes(name))return;currentPage=name;globalQuery="";$("#globalSearch").value="";document.querySelectorAll(".nav-link").forEach(b=>b.classList.toggle("active",b.dataset.page===name));document.body.classList.remove("sidebar-open");render();window.scrollTo({top:0,behavior:"smooth"});}
function toast(message){const root=$("#toastRoot"),el=document.createElement("div");el.className="toast";el.textContent=message;root.append(el);setTimeout(()=>el.remove(),3200);}
function openModal(headline,sub,body,footer=""){
 $("#modalRoot").innerHTML=`<div class="modal-backdrop" data-close-backdrop><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle"><header class="modal-header"><div><h2 id="modalTitle">${headline}</h2><p>${sub}</p></div><button class="modal-close" aria-label="Close dialog" data-action="close-modal">×</button></header><div class="modal-body">${body}</div>${footer?`<footer class="modal-footer">${footer}</footer>`:""}</section></div>`;
 $(".modal-close").focus();
}
function closeModal(){$("#modalRoot").innerHTML=""}
function showBus(id){const b=buses.find(x=>x.id===id);if(!b)return;selectedBus=b;openModal(`Bus details · ${esc(b.id)}`,"Illustrative bus activity · location and counts are sample data.",`<div class="detail-grid">${[["Route",b.route],["Current stop",b.stop],["Next stop",b.next],["Passenger count",b.passengers],["Ticket count",b.tickets],["Mismatch count",b.mismatch],["Occupancy",`${b.occupancy}%`],["Status",b.status],["Fleet ID",b.fleet],["Depot",b.depot]].map(([k,v])=>`<div class="detail-field"><span>${k}</span><strong>${esc(v)}</strong></div>`).join("")}</div><div class="detail-note">${b.mismatch?`Passenger count is ${b.mismatch} higher than recorded tickets. A checker may verify the sample variance at ${esc(b.next)}.`:"No passenger-ticket mismatch is currently recorded for this sample bus."}</div><div class="detail-list"><div><span>Last update</span><strong>${esc(b.updated)}</strong></div><div><span>Recent event</span><strong>${b.mismatch?"Variance alert generated":"Routine count update"}</strong></div></div>`,`<button class="btn" data-action="close-modal">Close</button>${b.mismatch?`<button class="btn btn-primary" data-action="assign-from-bus" data-id="${esc(b.id)}">Assign checker</button>`:""}`)}
function showAlert(id){const a=alerts.find(x=>x.id===id);if(!a)return;openModal(`Alert details · ${esc(a.id)}`,"Passenger–ticket mismatch · local sample record.",`<div class="detail-grid">${[["Bus number",a.bus],["Route",a.route],["Current stop",a.stop],["Detection time",a.time],["Detected passengers",a.passengers],["Recorded tickets",a.tickets],["Mismatch count",`${a.mismatch} passenger${a.mismatch===1?"":"s"}`],["Severity",a.severity],["Alert status",a.status]].map(([k,v])=>`<div class="detail-field"><span>${k}</span><strong>${esc(v)}</strong></div>`).join("")}</div><div class="detail-note">The sample passenger count (${a.passengers}) is ${a.mismatch} higher than the recorded ticket count (${a.tickets}). This alert is a prompt for a human checker to verify the counts; it is not a finding of fare evasion.</div>`,`<button class="btn" data-action="close-modal">Close</button><button class="btn" data-action="review-alert" data-id="${esc(a.id)}">Mark reviewed</button><button class="btn btn-primary" data-action="assign-from-alert" data-id="${esc(a.id)}">Assign checker</button>`)}
function showInspection(id){const i=inspections.find(x=>x.id===id);if(!i)return;openModal(`Inspection · ${esc(i.id)}`,"Sample checker visit and recorded outcome.",`<div class="detail-grid">${[["Bus",i.bus],["Route",i.route],["Checker",i.checker],["Location",i.location],["Mismatch",i.mismatch],["Outcome",i.outcome],["Date & time",i.time]].map(([k,v])=>`<div class="detail-field"><span>${k}</span><strong>${esc(v)}</strong></div>`).join("")}</div><div class="detail-note">This inspection history is illustrative demonstration data only.</div>`,`<button class="btn" data-action="close-modal">Close</button>`)}

function actionAlertMenu(id){
 const a=alerts.find(x=>x.id===id);if(!a)return;
 openModal(`Update alert · ${esc(a.id)}`,"Choose a local status action for this sample alert.",`<div class="detail-field"><span>Current status</span><strong>${esc(a.status)}</strong></div><div class="detail-note">Status changes are stored only in this page session.</div>`,`<button class="btn" data-action="close-modal">Cancel</button><button class="btn" data-action="review-alert" data-id="${esc(id)}">Mark reviewed</button><button class="btn btn-primary" data-action="resolve-alert" data-id="${esc(id)}">Mark resolved</button>`);
}
function showAssign(busId=""){
 const flagged=buses.filter(b=>b.mismatch>0),available=checkers.filter(c=>c.availability==="Available");
 if(!available.length){toast("No checkers are currently available in the sample roster.");return}
 openModal("Assign checker","Choose a flagged bus, available checker, and inspection stop.",`<form id="modalAssignForm" class="form-grid"><div class="form-group full"><label for="modalAssignBus">Flagged bus</label><select class="form-control" id="modalAssignBus" required>${flagged.map(b=>`<option value="${esc(b.id)}" ${busId===b.id?"selected":""}>${esc(b.id)} · ${esc(b.route)}</option>`).join("")}</select></div><div class="form-group"><label for="modalAssignChecker">Available checker</label><select class="form-control" id="modalAssignChecker" required>${available.map(c=>`<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")}</select></div><div class="form-group"><label for="modalAssignLocation">Inspection stop</label><input class="form-control" id="modalAssignLocation" required value="${busId?esc(buses.find(b=>b.id===busId)?.next||"Bus Stand"):"Bus Stand"}"/></div></form>`,`<button class="btn" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="submit-modal-assignment">Confirm assignment</button>`);
}
function setAlertStatus(id,status){const a=alerts.find(x=>x.id===id);if(a){a.status=status;closeModal();render();toast(`${id} marked ${status.toLowerCase()}.`)}}
function submitAssignment(busId,checkerId,location){
 const b=buses.find(x=>x.id===busId),c=checkers.find(x=>x.id===checkerId);if(!b||!c||!location)return;
 c.availability="On inspection";c.bus=busId;c.location=location;c.task="Mismatch verification";
 const id=`INSP-${6020+inspections.length}`;
 inspections.unshift({id,bus:busId,route:b.route,checker:c.name,location,mismatch:`Pending · ${b.mismatch}`,outcome:"Inspection Pending",time:"Today, just now"});
 const a=alerts.find(x=>x.bus===busId&&x.status!=="Resolved");if(a)a.status="Under Review";
 closeModal();render();toast(`Assignment ${id} created for ${c.name}. Demo only; no notification sent.`);
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
function exportCsv(){
 const records=alerts;const rows=[["Alert ID","Bus number","Route","Detected passengers","Ticket count","Mismatch count","Detection time","Severity","Status"],...records.map(a=>[a.id,a.bus,a.route,a.passengers,a.tickets,a.mismatch,a.time,a.severity,a.status])];
 const csv=rows.map(r=>r.map(v=>`"${String(v).replaceAll('"','""')}"`).join(",")).join("\r\n");
 const link=document.createElement("a");link.href=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));link.download="smart-st-demo-alert-report.csv";link.click();URL.revokeObjectURL(link.href);toast("Sample alert report exported as CSV.");
}
function wirePageControls(){
 $("#busSearch")?.addEventListener("input",()=>{const rows=filterBuses();$("#liveBusTable").innerHTML=busTable(rows);$("#busResultCount").textContent=`${rows.length} buses`});
 ["busStatusFilter","busRouteFilter"].forEach(id=>$("#"+id)?.addEventListener("change",()=>{const rows=filterBuses();$("#liveBusTable").innerHTML=busTable(rows);$("#busResultCount").textContent=`${rows.length} buses`}));
 $("#alertSearch")?.addEventListener("input",e=>{const value=e.target.value,start=e.target.selectionStart,y=window.scrollY;render();const input=$("#alertSearch");input?.focus();input?.setSelectionRange(start,start);window.scrollTo(0,y)});
 ["severityFilter","alertStatusFilter","alertRouteFilter"].forEach(id=>$("#"+id)?.addEventListener("change",()=>render()));
 $("#manageSearch")?.addEventListener("input",managementRows);$("#manageStatus")?.addEventListener("change",managementRows);
 $("#historySearch")?.addEventListener("input",historyRows);["historyStatus","historyRoute"].forEach(id=>$("#"+id)?.addEventListener("change",historyRows));
 $("#assignmentForm")?.addEventListener("submit",e=>{e.preventDefault();submitAssignment($("#assignBus").value,$("#assignChecker").value,$("#assignStop").value)});
 $("#modalAssignForm")?.addEventListener("submit",e=>e.preventDefault());
}

function handleDocumentClick(e){
 const button=e.target.closest("[data-action],[data-page],[data-goto]");
 if(button?.dataset.page){e.preventDefault();gotoPage(button.dataset.page);return}
 if(button?.dataset.goto){gotoPage(button.dataset.goto);return}
 if(e.target.closest("#sidebarToggle")){if(innerWidth<=900)document.body.classList.toggle("sidebar-open");else{sidebarCollapsed=!sidebarCollapsed;document.body.classList.toggle("sidebar-collapsed",sidebarCollapsed)}return}
 if(e.target.closest("#notificationButton")){openModal("Notifications","Sample control-room notifications.",`<div class="alert-list">${alerts.filter(a=>a.status!=="Resolved").slice(0,4).map(a=>`<div class="alert-item"><span class="alert-indicator"></span><div class="alert-main"><strong>${esc(a.id)} · ${esc(a.bus)}</strong><p>${a.mismatch} passenger variance · ${esc(a.time)}</p></div>${badge(a.severity)}</div>`).join("")}</div>`,`<button class="btn btn-primary" data-action="close-modal">Done</button>`);return}
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
 else if(action==="assign-from-bus"||action==="assign-from-alert"){const bid=id;closeModal();gotoPage("Checker Dispatch");showAssign(bid)}
 else if(action==="add-bus")showBusForm();
 else if(action==="edit-bus")showBusForm(id);
 else if(action==="save-bus")saveBus(id);
 else if(action==="submit-modal-assignment"){const form=$("#modalAssignForm");if(form.reportValidity())submitAssignment($("#modalAssignBus").value,$("#modalAssignChecker").value,$("#modalAssignLocation").value.trim())}
 else if(action==="export-report")exportCsv();
 else if(action==="refresh"){render();toast("Sample fleet view refreshed.")}
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
 return ()=>{
  document.removeEventListener("click",handleDocumentClick);
  document.removeEventListener("keydown",handleDocumentKeydown);
  globalSearch.removeEventListener("input",handleGlobalSearch);
  globalSearch.removeEventListener("keydown",handleGlobalSearchKeydown);
  clearInterval(dateInterval);
 };
}
