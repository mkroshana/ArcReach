'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Mail, Lock, AlertCircle, ArrowRight } from 'lucide-react';
import {
  Box, Card, CardContent, Stack, Typography, TextField, Button, Alert,
  InputAdornment, CircularProgress,
} from '@mui/material';
import { alpha } from '@mui/material/styles';

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
    <Box sx={{ minHeight: '100vh', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', px: 2, position: 'relative' }}>
      {/* Decorative orbs (theme-aware) */}
      <Box sx={{ position: 'absolute', top: '25%', left: '25%', width: 288, height: 288, borderRadius: '50%', filter: 'blur(96px)', pointerEvents: 'none', bgcolor: (t) => alpha(t.palette.primary.main, 0.1) }} />
      <Box sx={{ position: 'absolute', bottom: '25%', right: '25%', width: 288, height: 288, borderRadius: '50%', filter: 'blur(96px)', pointerEvents: 'none', bgcolor: (t) => alpha(t.palette.error.main, 0.08) }} />

      <Card sx={{ width: '100%', maxWidth: 420, position: 'relative', zIndex: 10, boxShadow: 8 }}>
        <CardContent sx={{ p: 4 }}>
          {/* Brand header */}
          <Stack sx={{ alignItems: 'center', textAlign: 'center', mb: 4 }}>
            <Box sx={{ width: 48, height: 48, borderRadius: '14px', bgcolor: 'primary.main', display: 'grid', placeItems: 'center', boxShadow: 3, mb: 1.5 }}>
              <Mail size={24} color="#fff" />
            </Box>
            <Typography variant="h5" sx={{ fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>ArcReach</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary', mt: 0.5 }}>Outbound Sequence Automation &amp; CRM Delivery Grid</Typography>
          </Stack>

          {error && (
            <Alert severity="error" icon={<AlertCircle size={18} />} sx={{ mb: 2.5, borderRadius: '12px' }}>
              {error}
            </Alert>
          )}

          <form onSubmit={handleLogin}>
            <Stack spacing={2}>
              <TextField
                fullWidth size="small" type="email" required label="Email Address"
                placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)}
                slotProps={{ input: { sx: { fontFamily: 'monospace' }, startAdornment: <InputAdornment position="start"><Mail size={16} /></InputAdornment> } }}
              />
              <TextField
                fullWidth size="small" type="password" required label="Password"
                placeholder="••••••••••••" value={password} onChange={(e) => setPassword(e.target.value)}
                slotProps={{ input: { sx: { fontFamily: 'monospace' }, startAdornment: <InputAdornment position="start"><Lock size={16} /></InputAdornment> } }}
              />
              <Button
                type="submit" variant="contained" size="large" disabled={loading}
                endIcon={loading ? <CircularProgress size={16} color="inherit" /> : <ArrowRight size={16} />}
                sx={{ mt: 1 }}
              >
                {loading ? 'Authenticating…' : 'Sign In to Dashboard'}
              </Button>
            </Stack>
          </form>
        </CardContent>
      </Card>
    </Box>
  );
}
