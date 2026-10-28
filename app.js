import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { getDatabase, ref, get, set } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js';
const firebaseConfig={apiKey:'AIzaSyD5lPwyOJKy08uqNF0udYVDKqnGuj9xnzY',authDomain:'ruang-bajet.firebaseapp.com',databaseURL:'https://ruang-bajet-default-rtdb.asia-southeast1.firebasedatabase.app',projectId:'ruang-bajet',storageBucket:'ruang-bajet.firebasestorage.app',messagingSenderId:'372842407002',appId:'1:372842407002:web:b0302b4f0c97e4b0f46463',measurementId:'G-E2G6FRVTEN'};
const firebaseApp=initializeApp(firebaseConfig);const auth=getAuth(firebaseApp);const db=getDatabase(firebaseApp);let remoteUser=null;
const initial={income:1100,expenses:[['Rumah sewa Cheras','Rumah',83,false,1],['Rumah Sewa Pasir Gudang','Rumah',210,false,1],['Atome','BNPL',6.6,false,5],['Shopee BNPL','BNPL',44,false,10],['Hotlink','Internet',73,false,15],['U Mobile','Internet',28,false,18],['YouTube Premium','Internet',13,false,20],['iCloud','Internet',12,false,22],['Claude AI','AI',100,false,25]],commute:{distance:13,days:22,efficiency:15,fuelPrice:2.05,roundTrip:true},target:200};
let data=JSON.parse(localStorage.getItem('ruang-bajet')||'null')||structuredClone(initial);let editing=-1;let filter='Semua';
const money=n=>new Intl.NumberFormat('ms-MY',{style:'currency',currency:'MYR'}).format(Number(n)||0);const $=id=>document.getElementById(id);const save=async()=>{localStorage.setItem('ruang-bajet',JSON.stringify(data));if(remoteUser){try{await set(ref(db,`users/${remoteUser.uid}`),data);$('saved-status').textContent='Disimpan ke Firebase';}catch(err){console.warn(err);$('saved-status').textContent='Disimpan lokal (Firebase gagal)'}}else $('saved-status').textContent='Disimpan secara lokal';setTimeout(()=>$('saved-status').textContent=remoteUser?'Disimpan ke Firebase':'Disimpan secara lokal',1800)};
function render(){let total=data.expenses.reduce((s,e)=>s+Number(e[2]),0),bal=data.income-total; $('balance').textContent=money(bal);$('income-display').textContent=money(data.income);$('expenses-display').textContent=money(total);$('target-display').textContent=money(data.target);$('balance-note').textContent=`${data.income?(bal/data.income*100).toFixed(1):0}% daripada pendapatan`;$('balance-bar').style.width=`${Math.max(0,Math.min(100,bal/data.income*100))}%`;$('target-note').textContent=`${money(bal-data.target)} selepas simpanan`;$('expense-count').textContent=`${data.expenses.length} item aktif`;$('target-percent').textContent=`${bal?Math.round(data.target/bal*100):0}%`;
  $('income-input').value=data.income;$('savings-target').value=data.target;['distance','days','efficiency','fuel-price'].forEach((id,i)=>$(id).value=Object.values(data.commute)[i]);$('round-trip').checked=data.commute.roundTrip;let km=data.commute.distance*(data.commute.roundTrip?2:1),daily=km/data.commute.efficiency*data.commute.fuelPrice,totalFuel=daily*data.commute.days;$('commute-daily').textContent=money(daily);$('commute-total').textContent=money(totalFuel);
  const cats=['Semua',...new Set(data.expenses.map(e=>e[1]))];$('category-summary').innerHTML=cats.map(c=>`<button class="category-pill ${c===filter?'active':''}" data-cat="${c}">${c} ${c==='Semua'?'':money(data.expenses.filter(e=>e[1]===c).reduce((s,e)=>s+Number(e[2]),0))}</button>`).join('');$('category-summary').querySelectorAll('button').forEach(b=>b.onclick=()=>{filter=b.dataset.cat;render()});
  const paidCount=data.expenses.filter(e=>e[3]).length;$('paid-count').textContent=`${paidCount}/${data.expenses.length} dah bayar`;
  $('expense-list').innerHTML=data.expenses.map((e,i)=>filter==='Semua'||e[1]===filter?`<div class="expense-row${e[3]?' paid':''}"><button class="tick-btn" data-tick="${i}" title="${e[3]?'Tandakan belum bayar':'Tandakan dah bayar'}">${e[3]?'✓':''}</button><span class="expense-name">${e[0]}</span><span class="expense-category">${e[1]}</span><span class="expense-amount">${money(e[2])}</span><span class="row-actions"><button title="Edit" data-edit="${i}">✎</button><button title="Padam" data-delete="${i}">×</button></span></div>`:'').join('');document.querySelectorAll('[data-tick]').forEach(b=>b.onclick=()=>{data.expenses[+b.dataset.tick][3]=!data.expenses[+b.dataset.tick][3];save();render()});document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>openModal(+b.dataset.edit));document.querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>{data.expenses.splice(+b.dataset.delete,1);save();render()});renderTimeline();}
function renderTimeline(){
  const today=new Date();const todayDay=today.getDate();const monthName=today.toLocaleString('ms-MY',{month:'long'});const year=today.getFullYear();
  const withDate=data.expenses.filter(e=>e[4]>0).sort((a,b)=>a[4]-b[4]);
  const noDate=data.expenses.filter(e=>!e[4]);
  function dayStatus(d,paid){
    if(paid)return'paid';
    const diff=d-todayDay;
    if(diff<0)return'overdue';
    if(diff<=3)return'soon';
    if(diff<=7)return'week';
    return'later';
  }
  const labels={paid:'Dah bayar',overdue:'Dah lepas',soon:'Akan tiba',week:'Minggu ini',later:'Kemudian'};
  const rows=withDate.map(e=>{
    const d=e[4];const status=dayStatus(d,e[3]);
    const diff=d-todayDay;
    let badge='';
    if(status==='paid')badge='✓';
    else if(status==='overdue')badge=`${Math.abs(diff)}h lps`;
    else if(status==='soon'&&diff===0)badge='Hari ini';
    else if(status==='soon'&&diff===1)badge='Esok';
    else if(diff>=0)badge=`${diff}h lagi`;
    return`<div class="tl-item tl-${status}"><div class="tl-day"><span class="tl-day-num">${d}</span><span class="tl-month">${monthName.slice(0,3)}</span></div><div class="tl-connector"><div class="tl-dot"></div><div class="tl-line"></div></div><div class="tl-content"><span class="tl-name">${e[0]}</span><span class="tl-cat">${e[1]}</span><span class="tl-amt">${money(e[2])}</span></div><span class="tl-badge tl-badge-${status}">${badge}</span></div>`;
  }).join('');
  const noDateRows=noDate.length?`<div class="tl-nodate"><span class="tl-nodate-label">Tiada tarikh</span>${noDate.map(e=>`<div class="tl-nodate-item"><span>${e[0]}</span><span class="tl-cat">${e[1]}</span><span class="tl-amt">${money(e[2])}</span></div>`).join('')}</div>`:'';
  const tl=$('timeline-list');if(tl)tl.innerHTML=rows+noDateRows;
}
function openModal(i=-1){editing=i;$('modal-title').textContent=i<0?'Item baru':'Edit item';$('expense-name').value=i<0?'':data.expenses[i][0];$('expense-category').value=i<0?'Lain-lain':data.expenses[i][1];$('expense-amount').value=i<0?'':data.expenses[i][2];$('expense-dueday').value=i<0?'':(data.expenses[i][4]||'');$('modal').classList.add('open');$('expense-name').focus()}function closeModal(){$('modal').classList.remove('open')}
$('expense-form').onsubmit=e=>{e.preventDefault();const dd=parseInt($('expense-dueday').value)||null;let row=[$('expense-name').value,$('expense-category').value,Number($('expense-amount').value),editing>=0?data.expenses[editing][3]:false,dd];editing<0?data.expenses.push(row):data.expenses[editing]=row;closeModal();save();render()};$('add-expense').onclick=()=>openModal();$('close-modal').onclick=closeModal;$('cancel-modal').onclick=closeModal;$('modal').onclick=e=>{if(e.target.id==='modal')closeModal()};$('reset-btn').onclick=()=>{if(confirm('Pulihkan angka asal?')){data=structuredClone(initial);filter='Semua';save();render()}};document.querySelectorAll('[data-scroll]').forEach(b=>b.onclick=()=>document.getElementById(b.dataset.scroll).scrollIntoView());$('income-input').oninput=e=>{data.income=Number(e.target.value);save();render()};['distance','days','efficiency','fuel-price'].forEach((id,i)=>$(id).oninput=e=>{data.commute[Object.keys(data.commute)[i]]=Number(e.target.value);save();render()});$('round-trip').onchange=e=>{data.commute.roundTrip=e.target.checked;save();render()};$('savings-target').oninput=e=>{data.target=Number(e.target.value);save();render()};// Set month label for timeline header
(function(){const tl=$('tl-month-label');if(tl){const d=new Date();tl.textContent=d.toLocaleString('ms-MY',{month:'long',year:'numeric'})}})();
render();
async function fetchFromFirebase(){if(!remoteUser)return;const snap=await get(ref(db,`users/${remoteUser.uid}`));if(snap.exists()){data=snap.val();localStorage.setItem('ruang-bajet',JSON.stringify(data));render()}}
signInAnonymously(auth).then(async credential=>{remoteUser=credential.user;const snap=await get(ref(db,`users/${remoteUser.uid}`));if(snap.exists()){data=snap.val();localStorage.setItem('ruang-bajet',JSON.stringify(data));render()}else await set(ref(db,`users/${remoteUser.uid}`),data);$('saved-status').textContent='Disimpan ke Firebase'}).catch(err=>{console.warn('Firebase belum aktif:',err);$('saved-status').textContent='Disimpan secara lokal'});

// Pull-to-refresh
(function(){
  let startY=0,pulling=false,indicator=$('ptr-indicator');
  const THRESHOLD=72;
  document.addEventListener('touchstart',e=>{if(window.scrollY===0)startY=e.touches[0].clientY},{ passive:true });
  document.addEventListener('touchmove',e=>{
    if(startY===0)return;
    const dy=e.touches[0].clientY-startY;
    if(dy>0&&window.scrollY===0){pulling=true;const prog=Math.min(dy/THRESHOLD,1);indicator.style.transform=`translateY(${Math.min(dy*0.45,42)}px)`;indicator.style.opacity=prog;indicator.querySelector('.ptr-arrow').style.transform=`rotate(${prog*180}deg)`}
  },{passive:true});
  document.addEventListener('touchend',async()=>{
    if(!pulling){startY=0;return}
    pulling=false;startY=0;
    if(parseFloat(indicator.style.opacity||0)>=0.9){
      indicator.classList.add('loading');
      $('saved-status').textContent='Memuatkan...';
      try{await fetchFromFirebase();$('saved-status').textContent='Dikemaskini';}catch(e){$('saved-status').textContent='Gagal memuatkan';}
      setTimeout(()=>$('saved-status').textContent=remoteUser?'Disimpan ke Firebase':'Disimpan secara lokal',1500);
    }
    indicator.style.transform='';indicator.style.opacity='0';indicator.classList.remove('loading');
  });
})();
