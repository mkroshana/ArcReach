'use client';

import { useState, type ComponentType, type InputHTMLAttributes } from 'react';
import { useRouter } from 'next/navigation';
import { Mail, Lock, AlertCircle, ArrowRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { inputClasses } from '@/components/ui/Input';

/** A labelled native field with a leading icon. */
function IconField({ id, label, icon: Icon, ...props }: InputHTMLAttributes<HTMLInputElement> & {
  id: string; label: string; icon: ComponentType<{ size?: number; className?: string }>;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[13px] font-medium text-text-main">{label}</label>
      <div className="relative">
        <Icon size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-muted" />
        <input id={id} className={inputClasses('h-10 pl-9')} {...props} />
      </div>
    </div>
  );
}

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
    <div className="flex min-h-screen w-full items-center justify-center bg-canvas p-4">
      <Card className="w-full max-w-[400px] p-8">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-control bg-primary text-on-primary">
            <Mail size={20} strokeWidth={2.4} />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-text-main">ArcReach</h1>
          <p className="mt-1 text-xs text-text-sub">Outbound Sequence Automation &amp; CRM Delivery Grid</p>
        </div>

        {error && (
          <div role="alert" className="mb-4 flex items-start gap-2 rounded-control border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800 dark:border-rose-900/50 dark:bg-rose-500/10 dark:text-rose-300">
            <AlertCircle size={15} className="mt-px shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-4">
          <IconField
            id="login-email" label="Email Address" icon={Mail} type="email" required autoComplete="username"
            placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)}
          />
          <IconField
            id="login-password" label="Password" icon={Lock} type="password" required autoComplete="current-password"
            placeholder="••••••••••••" value={password} onChange={(e) => setPassword(e.target.value)}
          />
          <Button type="submit" variant="primary" disabled={loading} className="mt-2 h-10 w-full text-sm">
            {loading ? (
              <><Loader2 size={15} className="animate-spin" /> Authenticating…</>
            ) : (
              <>Sign In to Dashboard <ArrowRight size={15} /></>
            )}
          </Button>
        </form>

        <div className="mt-6 border-t border-card-border pt-4 text-center text-[11px] text-text-muted">
          ArcReach Engine • Secure Enterprise Access
        </div>
      </Card>
    </div>
  );
}
