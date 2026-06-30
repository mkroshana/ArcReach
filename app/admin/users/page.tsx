/* eslint-disable react-hooks/set-state-in-effect, react/no-unescaped-entities, react-hooks/exhaustive-deps */
'use client';

import { useState, useEffect } from 'react';
import {
  Users, Shield, Trash2, UserPlus, AlertTriangle, Mail, Lock, Eye, EyeOff, Copy, RefreshCw, KeyRound,
} from 'lucide-react';
import {
  Box, Card, CardContent, Stack, Typography, Button, IconButton, Chip, TextField,
  Dialog, DialogTitle, DialogContent, DialogActions, Table, TableHead, TableBody, TableRow, TableCell,
  Alert, Snackbar, ToggleButtonGroup, ToggleButton, InputAdornment, Tooltip as MuiTooltip,
  Avatar, CircularProgress,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import { ConfirmDialog } from '@/components/ConfirmDialog';

interface DbUser {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'USER';
  createdAt: string;
}

function generatePassword(length = 16): string {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
  const arr = new Uint32Array(length);
  crypto.getRandomValues(arr);
  return Array.from(arr, (n) => charset[n % charset.length]).join('');
}

function PasswordInput({
  value, onChange, show, setShow, onGenerate, onCopy,
}: {
  value: string;
  onChange: (v: string) => void;
  show: boolean;
  setShow: (v: boolean) => void;
  onGenerate: () => void;
  onCopy: () => void;
}) {
  return (
    <Stack direction="row" spacing={1}>
      <TextField
        fullWidth
        size="small"
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Enter or generate a password"
        slotProps={{
          input: {
            sx: { fontFamily: 'monospace' },
            endAdornment: (
              <InputAdornment position="end">
                <IconButton size="small" onClick={() => setShow(!show)} edge="end">
                  {show ? <EyeOff size={16} /> : <Eye size={16} />}
                </IconButton>
              </InputAdornment>
            ),
          },
        }}
      />
      <MuiTooltip title="Generate strong password">
        <IconButton onClick={onGenerate} sx={{ border: 1, borderColor: 'divider', borderRadius: '12px' }}>
          <RefreshCw size={16} />
        </IconButton>
      </MuiTooltip>
      <MuiTooltip title="Copy password">
        <IconButton onClick={onCopy} sx={{ border: 1, borderColor: 'divider', borderRadius: '12px' }}>
          <Copy size={16} />
        </IconButton>
      </MuiTooltip>
    </Stack>
  );
}

export default function UsersAdminPage() {
  const [users, setUsers] = useState<DbUser[]>([]);
  const [currentSession, setCurrentSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState<'ADMIN' | 'USER'>('USER');
  const [newPassword, setNewPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [resetUser, setResetUser] = useState<DbUser | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [showResetPassword, setShowResetPassword] = useState(true);
  const [resetting, setResetting] = useState(false);

  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [confirmState, setConfirmState] = useState<{ title: string; message: string; confirmLabel: string; onConfirm: () => void } | null>(null);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  const copyToClipboard = async (text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      showToast('Password copied to clipboard');
    } catch {
      showToast('Could not copy to clipboard', 'error');
    }
  };

  const fetchUsers = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/users');
      if (!res.ok) throw new Error((await res.text()) || 'Failed to fetch users');
      setUsers(await res.json());
    } catch (err: any) {
      setError(err.message || 'Access Denied. You do not have permissions to access the Admin Console.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
    fetch('/api/session').then((r) => r.json()).then(setCurrentSession).catch(() => {});
  }, []);

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEmail) return;
    if (!newPassword || newPassword.length < 8) {
      showToast('Set a password of at least 8 characters (use Generate for a strong one).', 'error');
      return;
    }
    try {
      setSubmitting(true);
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName, email: newEmail, role: newRole, password: newPassword }),
      });
      if (!res.ok) {
        const errText = await res.text();
        let parsedErr = 'Failed to create user';
        try { parsedErr = JSON.parse(errText).error || parsedErr; } catch { parsedErr = errText || parsedErr; }
        throw new Error(parsedErr);
      }
      await fetchUsers();
      setIsAddOpen(false);
      setNewEmail(''); setNewName(''); setNewRole('USER'); setNewPassword('');
      showToast('User added');
    } catch (err: any) {
      showToast(err.message || 'Error occurred', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetUser) return;
    if (!resetPassword || resetPassword.length < 8) {
      showToast('Set a password of at least 8 characters (use Generate for a strong one).', 'error');
      return;
    }
    try {
      setResetting(true);
      const res = await fetch('/api/users', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: resetUser.id, password: resetPassword }),
      });
      if (!res.ok) {
        const errObj = await res.json().catch(() => ({}));
        throw new Error(errObj.error || 'Failed to reset password.');
      }
      showToast(`Password reset for ${resetUser.email}`);
      setResetUser(null); setResetPassword('');
    } catch (err: any) {
      showToast(err.message || 'Failed to reset password', 'error');
    } finally {
      setResetting(false);
    }
  };

  const handleToggleRole = async (userId: string, currentRole: 'ADMIN' | 'USER') => {
    if (userId === 'admin-id-999') { showToast('Cannot modify default root administrator privileges.', 'error'); return; }
    const targetRole = currentRole === 'ADMIN' ? 'USER' : 'ADMIN';
    try {
      const res = await fetch('/api/users', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: userId, role: targetRole }),
      });
      if (!res.ok) throw new Error((await res.text()) || 'Failed to update credentials.');
      showToast(`User permissions changed to ${targetRole}`);
      await fetchUsers();
    } catch (err: any) {
      showToast(err.message || 'Failed to modify role', 'error');
    }
  };

  const handleDeleteUser = (userId: string) => {
    if (userId === 'admin-id-999') { showToast('Cannot delete root super administrative profile.', 'error'); return; }
    if (currentSession && userId === currentSession.id) { showToast('Cannot delete your own active session.', 'error'); return; }
    setConfirmState({
      title: 'Remove user?',
      message: 'This removes the user from ArcReach. All assigned mailboxes and campaigns will lock.',
      confirmLabel: 'Remove',
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/users?id=${userId}`, { method: 'DELETE' });
          if (!res.ok) {
            const errObj = await res.json().catch(() => ({}));
            throw new Error(errObj.error || 'Failed to revoke permissions.');
          }
          showToast('User deleted');
          await fetchUsers();
        } catch (err: any) {
          showToast(err.message || 'Failed to delete user', 'error');
        }
      },
    });
  };

  return (
    <Box sx={{ maxWidth: 1100, mx: 'auto', pb: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Snackbar
        open={!!toast}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        autoHideDuration={4000}
        onClose={() => setToast(null)}
      >
        {toast ? <Alert severity={toast.type} variant="filled" sx={{ borderRadius: '12px' }}>{toast.message}</Alert> : undefined}
      </Snackbar>

      {/* Header */}
      <Stack direction={{ xs: 'column', sm: 'row' }} sx={{ justifyContent: 'space-between', alignItems: { xs: 'flex-start', sm: 'center' }, gap: 2, pb: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>Team Directory</Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>Manage team members and their roles.</Typography>
        </Box>
        <Button variant="contained" startIcon={<UserPlus size={16} />} onClick={() => setIsAddOpen(true)}>Add User</Button>
      </Stack>

      {error ? (
        <Card sx={{ maxWidth: 520, mx: 'auto', bgcolor: (t) => alpha(t.palette.error.main, 0.06), borderColor: (t) => alpha(t.palette.error.main, 0.3) }}>
          <CardContent sx={{ textAlign: 'center', py: 4 }}>
            <AlertTriangle size={36} color="#ef4444" style={{ marginBottom: 12 }} />
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Privileged Access Required</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1 }}>{error}</Typography>
          </CardContent>
        </Card>
      ) : loading ? (
        <Stack sx={{ alignItems: 'center', py: 8, gap: 2 }}>
          <CircularProgress size={28} />
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>Loading users…</Typography>
        </Stack>
      ) : (
        <Card>
          <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', p: 2, borderBottom: 1, borderColor: 'divider' }}>
            <Typography variant="overline" sx={{ fontWeight: 700, letterSpacing: '0.1em' }}>All Users</Typography>
            <Chip size="small" label="RBAC ACTIVE" color="success" variant="outlined" sx={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 10 }} />
          </Stack>
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow sx={{ '& th': { fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: 10, color: 'text.secondary' } }}>
                  <TableCell>Name</TableCell>
                  <TableCell>Email</TableCell>
                  <TableCell>Role</TableCell>
                  <TableCell>Joined</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {users.map((item) => {
                  const isRoot = item.id === 'admin-id-999';
                  const isSelf = item.id === currentSession?.id;
                  return (
                    <TableRow key={item.id} hover>
                      <TableCell>
                        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                          <Avatar sx={{ width: 32, height: 32, fontSize: 12, bgcolor: 'action.hover', color: 'text.primary' }}>
                            {(item.name || item.email)[0]?.toUpperCase()}
                          </Avatar>
                          <Box>
                            <Typography variant="body2" sx={{ fontWeight: 700 }}>{item.name || 'Unnamed Employee'}</Typography>
                            <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace' }}>UID: {item.id.slice(0, 13)}…</Typography>
                          </Box>
                        </Stack>
                      </TableCell>
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, color: 'text.secondary' }}>{item.email}</TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          icon={item.role === 'ADMIN' ? <Shield size={12} /> : <Users size={12} />}
                          label={item.role}
                          color={item.role === 'ADMIN' ? 'error' : 'primary'}
                          variant="outlined"
                          sx={{ fontWeight: 700, fontSize: 10 }}
                        />
                      </TableCell>
                      <TableCell sx={{ color: 'text.secondary' }}>
                        {new Date(item.createdAt).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })}
                      </TableCell>
                      <TableCell align="right">
                        <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
                          <Button
                            size="small"
                            variant="outlined"
                            color="inherit"
                            disabled={isRoot}
                            onClick={() => handleToggleRole(item.id, item.role)}
                            sx={{ fontSize: 10, borderColor: 'divider', color: 'text.secondary' }}
                          >
                            {item.role === 'ADMIN' ? 'Demote' : 'Promote'}
                          </Button>
                          <MuiTooltip title="Reset password">
                            <IconButton size="small" sx={{ border: 1, borderColor: 'divider' }} onClick={() => { setResetUser(item); setResetPassword(''); setShowResetPassword(true); }}>
                              <KeyRound size={14} />
                            </IconButton>
                          </MuiTooltip>
                          <MuiTooltip title={isSelf ? 'Cannot delete yourself' : isRoot ? 'Cannot delete root admin' : 'Remove user'}>
                            <span>
                              <IconButton size="small" disabled={isRoot || isSelf} onClick={() => handleDeleteUser(item.id)} sx={{ border: 1, borderColor: (t) => alpha(t.palette.error.main, 0.3), color: 'error.main' }}>
                                <Trash2 size={14} />
                              </IconButton>
                            </span>
                          </MuiTooltip>
                        </Stack>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Box>
        </Card>
      )}

      {/* Add User Dialog */}
      <Dialog open={isAddOpen} onClose={() => setIsAddOpen(false)} maxWidth="sm" fullWidth slotProps={{ paper: { sx: { borderRadius: '20px' } } }}>
        <form onSubmit={handleCreateUser}>
          <DialogTitle>
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
              <UserPlus size={20} color="#2563EB" />
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Add User</Typography>
            </Stack>
          </DialogTitle>
          <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
            <TextField label="Name" required value={newName} onChange={(e) => setNewName(e.target.value)} size="small" />
            <TextField
              label="Email" type="email" required value={newEmail} onChange={(e) => setNewEmail(e.target.value)} size="small"
              slotProps={{ input: { startAdornment: <InputAdornment position="start"><Mail size={16} /></InputAdornment>, sx: { fontFamily: 'monospace' } } }}
            />
            <Box>
              <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary', display: 'flex', alignItems: 'center', gap: 0.75, mb: 1 }}>
                <Lock size={14} /> Password
              </Typography>
              <PasswordInput
                value={newPassword}
                onChange={setNewPassword}
                show={showNewPassword}
                setShow={setShowNewPassword}
                onGenerate={() => { setNewPassword(generatePassword()); setShowNewPassword(true); }}
                onCopy={() => copyToClipboard(newPassword)}
              />
              <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.75 }}>
                Share this with the user securely — they can change it later from Settings.
              </Typography>
            </Box>
            <Box>
              <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary', display: 'block', mb: 1 }}>Role</Typography>
              <ToggleButtonGroup value={newRole} exclusive onChange={(_, v) => v && setNewRole(v)} fullWidth>
                <ToggleButton value="USER">User</ToggleButton>
                <ToggleButton value="ADMIN" sx={{ color: 'error.main', '&.Mui-selected': { bgcolor: (t) => alpha(t.palette.error.main, 0.14), color: 'error.main' } }}>Admin</ToggleButton>
              </ToggleButtonGroup>
            </Box>
          </DialogContent>
          <DialogActions sx={{ p: 2 }}>
            <Button onClick={() => setIsAddOpen(false)} color="inherit">Cancel</Button>
            <Button type="submit" variant="contained" disabled={submitting}>
              {submitting ? 'Adding…' : 'Add User'}
            </Button>
          </DialogActions>
        </form>
      </Dialog>

      {/* Reset Password Dialog */}
      <Dialog open={!!resetUser} onClose={() => setResetUser(null)} maxWidth="sm" fullWidth slotProps={{ paper: { sx: { borderRadius: '20px' } } }}>
        <form onSubmit={handleResetPassword}>
          <DialogTitle>
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
              <KeyRound size={20} color="#2563EB" />
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Reset Password</Typography>
            </Stack>
          </DialogTitle>
          <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              Set a new password for <Box component="strong" sx={{ color: 'text.primary' }}>{resetUser?.email}</Box>.
            </Typography>
            <Box>
              <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary', display: 'flex', alignItems: 'center', gap: 0.75, mb: 1 }}>
                <Lock size={14} /> New Password
              </Typography>
              <PasswordInput
                value={resetPassword}
                onChange={setResetPassword}
                show={showResetPassword}
                setShow={setShowResetPassword}
                onGenerate={() => { setResetPassword(generatePassword()); setShowResetPassword(true); }}
                onCopy={() => copyToClipboard(resetPassword)}
              />
              <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.75 }}>
                Share this with the user securely — they can change it later from Settings.
              </Typography>
            </Box>
          </DialogContent>
          <DialogActions sx={{ p: 2 }}>
            <Button onClick={() => setResetUser(null)} color="inherit">Cancel</Button>
            <Button type="submit" variant="contained" disabled={resetting}>
              {resetting ? 'Resetting…' : 'Reset Password'}
            </Button>
          </DialogActions>
        </form>
      </Dialog>

      <ConfirmDialog
        isOpen={!!confirmState}
        title={confirmState?.title || ''}
        message={confirmState?.message || ''}
        confirmLabel={confirmState?.confirmLabel}
        isDestructive
        onConfirm={() => confirmState?.onConfirm()}
        onCancel={() => setConfirmState(null)}
      />
    </Box>
  );
}
