const cfg=window.KCEM_WEB_CONFIG||{};
const $=id=>document.getElementById(id);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const won=n=>`${Number(n||0).toLocaleString("ko-KR")}원`;
const state={pin:"",adminToken:"",adminUser:null,page:"daily",dailyRows:[],activeRecord:null,pendingAction:null,poll:null};

async function request(path,options={}){
  const headers={apikey:cfg.anonKey,...(options.headers||{})};
  if(options.admin && state.adminToken) headers.Authorization=`Bearer ${state.adminToken}`;
  const r=await fetch(`${cfg.supabaseUrl}${path}`,{...options,headers});
  const text=await r.text();
  if(!r.ok) throw new Error(text||`HTTP ${r.status}`);
  return text?JSON.parse(text):null;
}
async function publicSales(from,to){
  return await request('/rest/v1/rpc/kcem_public_sales',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_pin:state.pin,p_date_from:from,p_date_to:to})})||[];
}
function totals(rows){const cash=rows.filter(r=>['현금','계좌','시루'].includes(r.payment_method)).reduce((a,r)=>a+Number(r.amount||0),0);const card=rows.filter(r=>r.payment_method==='카드').reduce((a,r)=>a+Number(r.amount||0),0);return {cash,card,total:cash+card};}
function renderKpis(el,t){el.innerHTML=[["현금",t.cash],["카드",t.card],["총매출",t.total]].map(x=>`<div class="kpi"><div class="label">${x[0]}</div><div class="value">${won(x[1])}</div></div>`).join('');}

async function unlock(){
  const pin=$('viewerPin').value.trim(); if(!pin)return;
  $('pinMessage').textContent='확인 중...'; state.pin=pin;
  try{
    const today=new Date().toISOString().slice(0,10); await publicSales(today,today);
    sessionStorage.setItem('kcemViewerPin',pin); $('pinView').classList.add('hidden');$('appView').classList.remove('hidden');
    const now=new Date(); $('dailyDate').value=today;$('monthPicker').value=today.slice(0,7);$('yearInput').value=today.slice(0,4);
    await renderDaily(); renderMonth(); renderYear(); startPolling();
  }catch(e){state.pin='';$('pinMessage').textContent='PIN이 올바르지 않거나 조회 설정이 완료되지 않았습니다.';}
}
function lock(){sessionStorage.removeItem('kcemViewerPin');sessionStorage.removeItem('kcemAdminToken');sessionStorage.removeItem('kcemAdminUser');location.reload();}
function switchPage(page){state.page=page;document.querySelectorAll('.page').forEach(x=>x.classList.add('hidden'));$(`${page}Page`).classList.remove('hidden');document.querySelectorAll('.nav').forEach(x=>x.classList.toggle('active',x.dataset.page===page));}

async function renderDaily(){
  const d=$('dailyDate').value;if(!d)return;let rows;
  try{rows=await publicSales(d,d);}catch(e){$('dailyTable').innerHTML=`<p class="message">조회 실패: ${esc(e.message)}</p>`;return;}
  state.dailyRows=rows;renderKpis($('dailyKpis'),totals(rows));
  const body=rows.map((r,i)=>`<tr><td>${esc(String(r.sale_time||'').slice(0,5))}</td><td>${esc(r.payment_method)}</td><td class="num">${won(r.amount)}</td><td>${esc(r.item_name)}</td><td class="num">${Number(r.quantity||1)}</td><td>${esc(r.comment||'')}</td><td><button class="row-action" data-edit="${i}">수정</button></td></tr>`).join('');
  $('dailyTable').innerHTML=`<div class="table-wrap"><table class="table"><thead><tr><th>시간</th><th>결제수단</th><th>금액</th><th>판매품목</th><th>수량</th><th>비고</th><th></th></tr></thead><tbody>${body||'<tr><td colspan="7">등록된 매출이 없습니다.</td></tr>'}</tbody></table></div>`;
  document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>openEdit(rows[Number(b.dataset.edit)]));
}
function monthBounds(value){const [y,m]=value.split('-').map(Number),last=new Date(y,m,0).getDate();return {y,m,from:`${y}-${String(m).padStart(2,'0')}-01`,to:`${y}-${String(m).padStart(2,'0')}-${String(last).padStart(2,'0')}`,last};}
async function renderMonth(){
  const v=$('monthPicker').value;if(!v)return;const b=monthBounds(v);let rows;try{rows=await publicSales(b.from,b.to);}catch(_e){return;}renderKpis($('monthKpis'),totals(rows));
  const by={};rows.forEach(r=>(by[r.sale_date]??=[]).push(r));const start=(new Date(b.y,b.m-1,1).getDay()+6)%7;let html=['월','화','수','목','금','토','일'].map(x=>`<div class="cal-head">${x}</div>`).join('');for(let i=0;i<start;i++)html+='<div class="day empty"></div>';
  for(let d=1;d<=b.last;d++){const ds=`${b.y}-${String(b.m).padStart(2,'0')}-${String(d).padStart(2,'0')}`,rr=by[ds]||[],t=totals(rr);html+=`<div class="day" data-date="${ds}"><div class="date">${d}</div><div class="sales">${won(t.total)}</div><div class="meta">현금 ${won(t.cash)} · 카드 ${won(t.card)} · ${rr.length}건</div></div>`;}
  $('monthCalendar').innerHTML=html;document.querySelectorAll('.day[data-date]').forEach(x=>x.onclick=()=>{$('dailyDate').value=x.dataset.date;switchPage('daily');renderDaily();});
}
async function renderYear(){
  const y=Number($('yearInput').value);if(!y)return;let rows;try{rows=await publicSales(`${y}-01-01`,`${y}-12-31`);}catch(_e){return;}renderKpis($('yearKpis'),totals(rows));
  const months=Array.from({length:12},()=>[]);rows.forEach(r=>{const m=Number(String(r.sale_date).slice(5,7));if(m)months[m-1].push(r);});
  $('yearCards').innerHTML=months.map((rr,i)=>{const t=totals(rr);return `<div class="year-card" data-month="${i+1}"><div class="month">${i+1}월</div><div class="sales">${won(t.total)}</div><div class="meta">현금 ${won(t.cash)} · 카드 ${won(t.card)} · ${rr.length}건</div></div>`}).join('');
  document.querySelectorAll('.year-card').forEach(x=>x.onclick=()=>{$('monthPicker').value=`${y}-${String(x.dataset.month).padStart(2,'0')}`;switchPage('month');renderMonth();});
}

function openAdmin(after){if(state.adminToken){after();return;}state.pendingAction=after;$('adminModal').classList.remove('hidden');$('adminPassword').value='';$('adminMessage').textContent='';setTimeout(()=>$('adminEmail').focus(),50);}
async function adminLogin(){const email=$('adminEmail').value.trim(),password=$('adminPassword').value;$('adminMessage').textContent='인증 중...';try{const res=await request('/auth/v1/token?grant_type=password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});const token=res.access_token,user=res.user;if(!token||!user?.id)throw new Error('로그인 정보 없음');const old=state.adminToken;state.adminToken=token;const roles=await request(`/rest/v1/kcem_user_roles?select=role&user_id=eq.${encodeURIComponent(user.id)}&role=eq.admin`,{admin:true});if(!roles?.length){state.adminToken=old;throw new Error('KCEM 관리자 권한이 없습니다.');}state.adminUser=user;sessionStorage.setItem('kcemAdminToken',token);sessionStorage.setItem('kcemAdminUser',JSON.stringify(user));$('adminState').textContent='관리자 인증됨';$('adminModal').classList.add('hidden');const fn=state.pendingAction;state.pendingAction=null;if(fn)fn();}catch(e){$('adminMessage').textContent='관리자 인증 실패: '+e.message;}}
function openEdit(record){openAdmin(()=>{state.activeRecord=record;$('editDate').value=record.sale_date;$('editPayment').value=record.payment_method;$('editAmount').value=record.amount;$('editQty').value=record.quantity;$('editItem').value=record.item_name;$('editComment').value=record.comment||'';$('editMessage').textContent='';$('editModal').classList.remove('hidden');});}
async function saveEdit(){const r=state.activeRecord;if(!r)return;const payload={sale_date:$('editDate').value,payment_method:$('editPayment').value,amount:Number($('editAmount').value),quantity:Number($('editQty').value),item_name:$('editItem').value.trim(),comment:$('editComment').value.trim()||null,local_updated_at:new Date().toISOString()};if(!payload.sale_date||!['현금','계좌','시루','카드'].includes(payload.payment_method)||payload.amount<=0||payload.quantity<1||!payload.item_name){$('editMessage').textContent='입력값을 확인해 주세요.';return;}try{await request(`/rest/v1/kcem_sales?transaction_key=eq.${encodeURIComponent(r.transaction_key)}`,{method:'PATCH',admin:true,headers:{'Content-Type':'application/json','Prefer':'return=minimal'},body:JSON.stringify(payload)});$('editModal').classList.add('hidden');await refreshAll();}catch(e){$('editMessage').textContent='수정 실패: '+e.message;}}
async function deleteRecord(){const r=state.activeRecord;if(!r||!confirm('이 거래를 삭제할까요?'))return;try{await request(`/rest/v1/kcem_sales?transaction_key=eq.${encodeURIComponent(r.transaction_key)}`,{method:'DELETE',admin:true,headers:{'Prefer':'return=minimal'}});$('editModal').classList.add('hidden');await refreshAll();}catch(e){$('editMessage').textContent='삭제 실패: '+e.message;}}
async function refreshAll(){await renderDaily();if(state.page==='month')await renderMonth();if(state.page==='year')await renderYear();}
function shiftDay(n){const d=new Date($('dailyDate').value+'T00:00:00');d.setDate(d.getDate()+n);$('dailyDate').value=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;renderDaily();}
function shiftMonth(n){const [y,m]=$('monthPicker').value.split('-').map(Number),d=new Date(y,m-1+n,1);$('monthPicker').value=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;renderMonth();}
function startPolling(){if(state.poll)clearInterval(state.poll);state.poll=setInterval(()=>{if(document.hidden)return;if(state.page==='daily')renderDaily();else if(state.page==='month')renderMonth();else renderYear();},5000);}

document.querySelectorAll('.nav').forEach(x=>x.onclick=()=>{switchPage(x.dataset.page);if(x.dataset.page==='daily')renderDaily();if(x.dataset.page==='month')renderMonth();if(x.dataset.page==='year')renderYear();});
document.querySelectorAll('[data-close]').forEach(x=>x.onclick=()=>$(x.dataset.close).classList.add('hidden'));
$('unlockButton').onclick=unlock;$('viewerPin').onkeydown=e=>{if(e.key==='Enter')unlock();};$('lockButton').onclick=lock;
$('prevDay').onclick=()=>shiftDay(-1);$('nextDay').onclick=()=>shiftDay(1);$('dailyDate').onchange=renderDaily;
$('prevMonth').onclick=()=>shiftMonth(-1);$('nextMonth').onclick=()=>shiftMonth(1);$('monthPicker').onchange=renderMonth;
$('prevYear').onclick=()=>{$('yearInput').value=Number($('yearInput').value)-1;renderYear();};$('nextYear').onclick=()=>{$('yearInput').value=Number($('yearInput').value)+1;renderYear();};$('yearInput').onchange=renderYear;
$('adminLoginButton').onclick=adminLogin;$('adminPassword').onkeydown=e=>{if(e.key==='Enter')adminLogin();};$('saveEditButton').onclick=saveEdit;$('deleteButton').onclick=deleteRecord;

(async()=>{if(!cfg.supabaseUrl||!cfg.anonKey){$('pinMessage').textContent='OOZYSales의 웹 업로드 설정을 저장해 config.js를 먼저 생성해 주세요.';return;}const savedPin=sessionStorage.getItem('kcemViewerPin');const adminToken=sessionStorage.getItem('kcemAdminToken');const adminUser=sessionStorage.getItem('kcemAdminUser');if(adminToken){state.adminToken=adminToken;try{state.adminUser=JSON.parse(adminUser||'{}');$('adminState').textContent='관리자 인증됨';}catch(_e){}}if(savedPin){$('viewerPin').value=savedPin;await unlock();}})();
