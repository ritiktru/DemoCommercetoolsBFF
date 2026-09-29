export const loginPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>BFF passwordless login</title>
<style>
body { font-family: system-ui, sans-serif; background: #f4f6fa; color: #202938; margin: 0; padding: 48px 20px; }
main { max-width: 640px; margin: auto; background: white; border-radius: 16px; padding: 32px; }
h1 { font-size: 26px; } p { line-height: 1.6; } button { cursor: pointer; padding: 10px 16px; margin-right: 8px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #f4f6fa; padding: 16px; }
label { display: block; margin: 12px 0; } input { padding: 8px; width: 90px; } button:disabled { cursor: default; }
#actions { margin-top: 24px; }
</style></head><body><main>
<h1>Passwordless login POC</h1>
<p>Sign in with your Gmail or Google Workspace account to create or access your commerce customer.</p>
<div id="google-button"></div>
<p id="status" role="status">Loading sign-in…</p>
<div id="actions"><button id="check">Check session</button><button id="logout">Log out</button><button id="retry">Reload sign-in</button></div>
<hr><h2>Create a customer cart</h2>
<p>Sign in first. Use the currency for your product prices. Each click creates a new empty cart.</p>
<label>Currency <input id="currency" value="EUR" maxlength="3" aria-label="Currency code"></label>
<label>Country (optional) <input id="country" placeholder="e.g. DE" maxlength="2" aria-label="Country code"></label>
<button id="create-cart" disabled>Create cart</button><button id="get-cart" disabled>Fetch created cart</button>
<pre id="result" aria-label="Response"></pre>
</main><script src="/login.js" defer></script>
</body></html>`;

export const loginScript = `
const status = document.getElementById('status');
const result = document.getElementById('result');
const createCartButton = document.getElementById('create-cart');
const getCartButton = document.getElementById('get-cart');
let cartId;
function show(value) { result.textContent = JSON.stringify(value, null, 2); }
async function request(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(body?.error?.message || 'Request failed');
  return body;
}
async function login(response) {
  status.textContent = 'Verifying sign-in…';
  try {
    const body = await request('/api/auth/google', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: response.credential })
    });
    status.textContent = 'Signed in. Your BFF session is active.';
    show(body);
    cartId = undefined;
    getCartButton.disabled = true;
    createCartButton.disabled = false;
    document.getElementById('google-button').replaceChildren();
  } catch (error) {
    status.textContent = error.message + ' Click Reload sign-in to try again.';
  }
}
async function start() {
  try {
    const challenge = await request('/api/auth/google/challenge');
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.onload = () => {
      google.accounts.id.initialize({ client_id: challenge.clientId, nonce: challenge.nonce, callback: login, auto_select: false });
      google.accounts.id.renderButton(document.getElementById('google-button'), { theme: 'outline', size: 'large' });
      status.textContent = 'Ready to sign in.';
    };
    script.onerror = () => { status.textContent = 'Could not load Google sign-in. Check your connection or browser blockers.'; };
    document.head.appendChild(script);
  } catch (error) { status.textContent = error.message; }
}
document.getElementById('check').onclick = async () => {
  try { show(await request('/api/auth/me')); status.textContent = 'Session is active.'; createCartButton.disabled = false; }
  catch (error) { status.textContent = error.message; show({ authenticated: false }); createCartButton.disabled = true; getCartButton.disabled = true; }
};
document.getElementById('logout').onclick = async () => {
  try {
    await request('/api/auth/logout', { method: 'POST' });
    if (window.google) google.accounts.id.disableAutoSelect();
    status.textContent = 'Logged out. Click Reload sign-in to sign in again.';
    show({ authenticated: false });
    cartId = undefined;
    createCartButton.disabled = true;
    getCartButton.disabled = true;
  } catch (error) { status.textContent = error.message; }
};
document.getElementById('retry').onclick = () => location.reload();
createCartButton.onclick = async () => {
  createCartButton.disabled = true;
  status.textContent = 'Creating cart in commercetools…';
  try {
    const country = document.getElementById('country').value.trim().toUpperCase();
    const body = await request('/api/carts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currency: document.getElementById('currency').value.trim().toUpperCase(), ...(country ? { country } : {}) })
    });
    cartId = body.cart.id;
    getCartButton.disabled = false;
    show(body);
    status.textContent = 'Cart created in commercetools and linked to your customer.';
  } catch (error) { status.textContent = error.message; }
  finally { createCartButton.disabled = false; }
};
getCartButton.onclick = async () => {
  if (!cartId) return;
  try { show(await request('/api/carts/' + encodeURIComponent(cartId))); status.textContent = 'Cart fetched from commercetools.'; }
  catch (error) { status.textContent = error.message; }
};
start();
`;
