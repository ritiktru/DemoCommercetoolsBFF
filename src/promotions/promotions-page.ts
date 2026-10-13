export const promotionsPage = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Commerce Promotions</title>
  <style>
    :root{font-family:Inter,system-ui,sans-serif;color:#153d31;background:#f7f3eb}*{box-sizing:border-box}body{margin:0}.page{max-width:1100px;margin:auto;padding:48px 24px}h1{font-family:Georgia,serif;font-size:48px;margin:8px 0}.eyebrow{color:#078963;font-weight:800;letter-spacing:.15em}.panel{background:white;border:1px solid #ddd7cc;border-radius:18px;padding:24px;margin-top:28px;box-shadow:0 10px 30px #153d310d}.grid{display:grid;grid-template-columns:2fr 1fr 1fr;gap:16px}label{display:grid;gap:7px;font-weight:700}input,select{font:inherit;padding:13px;border:1px solid #bcb7ae;border-radius:10px}button{font:inherit;font-weight:800;color:white;background:#078963;border:0;border-radius:999px;padding:14px 24px;cursor:pointer}button:disabled{opacity:.55}table{width:100%;border-collapse:collapse;margin-top:16px}th,td{text-align:left;padding:12px;border-bottom:1px solid #e8e3da}.status{min-height:24px;margin-top:14px;color:#526b63}.active{color:#078963;font-weight:800}.inactive{color:#9a3c31;font-weight:800}.remove{background:#a33a2f;padding:8px 14px;font-size:14px}@media(max-width:750px){.grid{grid-template-columns:1fr}h1{font-size:38px}table{font-size:14px}}
  </style>
</head>
<body><main class="page">
  <span class="eyebrow">COMMERCE POC</span><h1>Product promotions</h1>
  <p>Create a commercetools Product Discount for one published SKU. Product prices in Merchant Center remain unchanged; the discount is applied by price calculation.</p>
  <section class="panel"><form id="form">
    <div class="grid">
      <label>SKU<input id="sku" required maxlength="256" placeholder="680705-EA"></label>
      <label>Discount type<select id="type"><option value="percentage">Percentage (%)</option><option value="fixed">Fixed amount (CAD)</option></select></label>
      <label>Discount<input id="discount" required type="number" min="0.01" max="100" step="0.01" placeholder="10"></label>
    </div>
    <label style="margin:16px 0">Promotion name<input id="name" required maxlength="120" placeholder="10% off Huggies"></label>
    <button id="submit">Create active promotion</button><div id="status" class="status" role="status"></div>
  </form></section>
  <section class="panel"><h2>Existing product discounts</h2><button id="refresh">Refresh</button>
    <table><thead><tr><th>Name</th><th>Predicate</th><th>Discount</th><th>Status</th><th>Action</th></tr></thead><tbody id="rows"></tbody></table>
  </section>
</main><script src="/promotions.js"></script></body></html>`;

export const promotionsScript = String.raw`
const status = document.getElementById('status');
const rows = document.getElementById('rows');
const discount = document.getElementById('discount');
const type = document.getElementById('type');
async function request(path, options) {
  const response = await fetch(path, {...options, headers:{...(options?.body?{'Content-Type':'application/json'}:{}),...options?.headers}});
  const body = await response.json().catch(()=>null);
  if (!response.ok) throw new Error(body?.error?.message || 'Request failed');
  return body;
}
function text(value){const node=document.createTextNode(String(value ?? ''));return node;}
async function load(){
  rows.replaceChildren();
  try {
    const data=await request('/api/promotions');
    for(const item of data.promotions){
      const tr=document.createElement('tr');
      const label=item.discount.type==='percentage'?item.discount.value+'%':'CA$'+item.discount.value.toFixed(2);
      for(const value of [item.name,item.predicate,label]){const td=document.createElement('td');td.append(text(value));tr.append(td)}
      const state=document.createElement('td');state.className=item.active?'active':'inactive';state.append(text(item.active?'Active':'Inactive'));tr.append(state);
      const action=document.createElement('td');const remove=document.createElement('button');remove.className='remove';remove.type='button';remove.textContent='Remove';remove.addEventListener('click',()=>removePromotion(item.id,item.name,remove));action.append(remove);tr.append(action);rows.append(tr);
    }
    if(!data.promotions.length){const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=5;td.append(text('No product discounts found.'));tr.append(td);rows.append(tr)}
  } catch(error){status.textContent=error.message}
}
type.addEventListener('change',()=>{discount.max=type.value==='percentage'?'100':'100000'});
async function removePromotion(id,name,button){
  if(!window.confirm('Remove product discount "'+name+'"?')) return;
  button.disabled=true;status.textContent='Removing promotion…';
  try{await request('/api/promotions/'+encodeURIComponent(id),{method:'DELETE'});status.textContent='Promotion removed successfully.';await load()}
  catch(error){status.textContent=error.message;button.disabled=false}
}
document.getElementById('refresh').addEventListener('click',load);
document.getElementById('form').addEventListener('submit',async event=>{
  event.preventDefault();const button=document.getElementById('submit');button.disabled=true;status.textContent='Creating promotion…';
  try{await request('/api/promotions',{method:'POST',body:JSON.stringify({sku:document.getElementById('sku').value,name:document.getElementById('name').value,discountType:type.value,discount:Number(discount.value)})});status.textContent='Promotion created successfully.';event.target.reset();await load()}
  catch(error){status.textContent=error.message}finally{button.disabled=false}
});
load();`;
