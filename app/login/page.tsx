'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Mail, Lock, AlertCircle, ArrowRight, ShieldCheck, UserCheck } from 'lucide-react';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent, customCredentials?: { email: string; pass: string }) => {
    if (e) e.preventDefault();
    
    const targetEmail = customCredentials ? customCredentials.email : email;
    const targetPassword = customCredentials ? customCredentials.pass : password;

    if (!targetEmail || !targetPassword) {
      setError('Please enter both email and password.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: targetEmail, password: targetPassword }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Invalid credentials');
      }

      router.push('/');
      router.refresh();
    } catch (err: any) {
      setError(err.message || 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };


  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-slate-50 dark:bg-[#0c0d14] px-4 transition-colors duration-200">
      
      {/* Decorative Orbs */}
      <div className="absolute top-1/4 left-1/4 w-72 h-72 bg-blue-500/5 dark:bg-blue-600/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 w-72 h-72 bg-rose-500/5 dark:bg-rose-600/10 rounded-full blur-3xl pointer-events-none" />

      <div className="w-full max-w-md bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-2xl p-8 shadow-2xl relative z-10 transition-all duration-300">
        
        {/* Brand Header */}
        <div className="flex flex-col items-center mb-8 text-center">
          <div className="w-12 h-12 rounded-xl bg-blue-600 flex items-center justify-center shadow-lg mb-3">
            <Mail className="text-white w-6 h-6" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white uppercase tracking-wider">ArcReach</h1>
          <p className="text-slate-500 dark:text-slate-400 text-xs mt-1 font-medium">Outbound Sequence Automation & CRM Delivery Grid</p>
        </div>

        {error && (
          <div className="mb-5 p-3 rounded-lg bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/20 text-rose-600 dark:text-rose-400 text-xs flex items-center gap-2.5 font-medium animate-in fade-in duration-300">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-widest font-bold">Email Address</label>
            <div className="relative">
              <Mail className="absolute left-3 top-3 w-4 h-4 text-slate-400 dark:text-slate-500" />
              <input
                type="email"
                required
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-xl pl-10 pr-4 py-2.5 text-xs outline-none focus:ring-2 focus:ring-blue-500/35 transition-all font-mono"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-widest font-bold">Password</label>
            <div className="relative">
              <Lock className="absolute left-3 top-3 w-4 h-4 text-slate-400 dark:text-slate-500" />
              <input
                type="password"
                required
                placeholder="••••••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-xl pl-10 pr-4 py-2.5 text-xs outline-none focus:ring-2 focus:ring-blue-500/35 transition-all font-mono"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/55 rounded-xl text-white font-semibold text-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer shadow-md mt-6"
          >
            {loading ? 'Authenticating...' : 'Sign In to Dashboard'}
            <ArrowRight className="w-4 h-4" />
          </button>
        </form>



      </div>
    </div>
  );
}
