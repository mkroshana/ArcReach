'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Mail, Lock, AlertCircle, ArrowRight } from 'lucide-react';
import {
  TextField, Alert, InputAdornment, CircularProgress,
} from '@mui/material';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!email || !password) {
      setError('Please enter both email and password.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
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
    <div className="min-h-screen w-full flex items-center justify-center p-4 bg-[#F5F6F9] dark:bg-[#090A0F]">
      {/* Strictly minimalist Shopeers auth card (0 decorative orbs, 0 emojis, 0 glow blobs) */}
      <div className="w-full max-w-[420px] rounded-[24px] border border-[#EBF0F5] dark:border-[#1E222D] bg-white dark:bg-[#11131A] p-8 shadow-xs transition-all">
        {/* Brand Header */}
        <div className="text-center mb-6">
          <div className="w-12 h-12 rounded-2xl bg-blue-600 flex items-center justify-center text-white shadow-md shadow-blue-500/20 mx-auto mb-3">
            <Mail size={22} />
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-900 dark:text-white uppercase">
            ArcReach
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Outbound Sequence Automation &amp; CRM Delivery Grid
          </p>
        </div>

        {error && (
          <Alert severity="error" icon={<AlertCircle size={18} />} sx={{ mb: 3, borderRadius: '14px' }}>
            {error}
          </Alert>
        )}

        <form onSubmit={handleLogin} className="space-y-4">
          <TextField
            fullWidth size="small" type="email" required label="Email Address"
            placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)}
            slotProps={{
              input: {
                sx: { fontFamily: 'monospace' },
                startAdornment: (
                  <InputAdornment position="start">
                    <Mail size={16} className="text-slate-400" />
                  </InputAdornment>
                ),
              },
            }}
          />
          <TextField
            fullWidth size="small" type="password" required label="Password"
            placeholder="••••••••••••" value={password} onChange={(e) => setPassword(e.target.value)}
            slotProps={{
              input: {
                sx: { fontFamily: 'monospace' },
                startAdornment: (
                  <InputAdornment position="start">
                    <Lock size={16} className="text-slate-400" />
                  </InputAdornment>
                ),
              },
            }}
          />
          <button
            type="submit"
            disabled={loading}
            className="w-full mt-2 py-3 px-6 rounded-full bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm shadow-xs flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-60"
          >
            {loading ? (
              <>
                <CircularProgress size={16} color="inherit" />
                <span>Authenticating…</span>
              </>
            ) : (
              <>
                <span>Sign In to Dashboard</span>
                <ArrowRight size={16} />
              </>
            )}
          </button>
        </form>

        <div className="mt-6 pt-4 border-t border-[#EBF0F5] dark:border-[#1E222D] text-center">
          <span className="text-[11px] font-mono text-slate-400 dark:text-slate-500">
            ArcReach Engine • Secure Enterprise Access
          </span>
        </div>
      </div>
    </div>
  );
}
