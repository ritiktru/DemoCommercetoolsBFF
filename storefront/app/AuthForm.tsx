'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api } from './api';
import { useStore } from './StoreProvider';

declare global { interface Window { google?: { accounts: { id: { initialize(options: object): void; renderButton(element: HTMLElement, options: object): void } } } } }

export default function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter();
  const { refreshCustomer } = useStore();
  const [form, setForm] = useState({ email: '', password: '', firstName: '', lastName: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const register = mode === 'register';
  const set = (field: keyof typeof form) => (event: { target: { value: string } }) => setForm({ ...form, [field]: event.target.value });
  const finish = async () => { await refreshCustomer(); router.push('/'); };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const { firstName, lastName, ...credentials } = form;
    try {
      await api(`/api/auth/${mode}`, { method: 'POST', body: JSON.stringify(register ? { ...credentials, ...(firstName && { firstName }), ...(lastName && { lastName }) } : credentials) });
      await finish();
    } catch (err) { setError((err as Error).message); setBusy(false); }
  }

  async function google() {
    setError('');
    try {
      const challenge = await api('/api/auth/google/challenge');
      if (!window.google) await new Promise<void>((resolve, reject) => { const script = document.createElement('script'); script.src = 'https://accounts.google.com/gsi/client'; script.onload = () => resolve(); script.onerror = () => reject(new Error('Google sign-in failed to load')); document.head.appendChild(script); });
      const target = document.getElementById('google-signin'); if (!target || !window.google) return;
      target.replaceChildren();
      window.google.accounts.id.initialize({ client_id: challenge.clientId, nonce: challenge.nonce, callback: async ({ credential }: { credential: string }) => {
        try { await api('/api/auth/google', { method: 'POST', body: JSON.stringify({ idToken: credential }) }); await finish(); }
        catch (err) { setError((err as Error).message); }
      } });
      window.google.accounts.id.renderButton(target, { theme: 'outline', size: 'large' });
    } catch (err) { setError((err as Error).message); }
  }

  return <main><form className="loginPanel authPage" onSubmit={submit}>
    <h1>{register ? 'Create your account' : 'Sign in'}</h1>
    {register && <><label>First name<input value={form.firstName} onChange={set('firstName')} autoComplete="given-name" /></label><label>Last name<input value={form.lastName} onChange={set('lastName')} autoComplete="family-name" /></label></>}
    <label>Email<input type="email" required autoComplete="email" value={form.email} onChange={set('email')} /></label>
    <label>Password<input type="password" required minLength={register ? 8 : 1} autoComplete={register ? 'new-password' : 'current-password'} value={form.password} onChange={set('password')} />{register && <small>At least 8 characters.</small>}</label>
    {!register && <Link href="/forgot-password">Forgot password?</Link>}
    {error && <p className="error" role="alert">{error}</p>}
    <button disabled={busy} type="submit">{register ? 'Create account' : 'Sign in'}</button>
    {!register && <><button type="button" className="ghostButton" onClick={google}>Continue with Google</button><div id="google-signin" /></>}
    <p>{register ? <>Already have an account? <Link href="/login">Sign in</Link></> : <>New here? <Link href="/signup">Create an account</Link></>} · <Link href="/">Back to shop</Link></p>
  </form></main>;
}
