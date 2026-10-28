/* eslint-disable react-hooks/set-state-in-effect */
'use client';

import { useState, useEffect, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import {
  Users, Shield, Trash2, UserPlus, UserX, UserCheck, Mail, Lock, Eye, EyeOff, Copy, RefreshCw, KeyRound, Loader2,
} from 'lucide-react';
import { Snackbar, Alert, Tooltip as MuiTooltip, Dialog } from '@mui/material';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { passwordPolicyError } from '@/lib/passwordPolicy';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { inputClasses } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { Segmented } from '@/components/ui/Segmented';
import { Table, THead, TH, TR, TD } from '@/components/ui/Table';
import { cn } from '@/lib/utils';

const LABEL = 'mb-1.5 block text-[13px] font-medium text-text-main';
const HINT = 'mt-1 text-[11px] text-text-muted';
const DIALOG_PAPER = { paper: { sx: { borderRadius: '12px', backgroundImage: 'none' } } };

interface DbUser {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'USER';
  createdAt: string;
  disabledAt: string | null;
}

function generatePassword(length = 16): string {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
  const arr = new Uint32Array(length);
  crypto.getRandomValues(arr);
  return Array.from(arr, (n) => charset[n % charset.length]).join('');
}

/** A labelled native text field, the label above it and an optional leading icon. */
function TextInput({ label, icon, className, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; icon?: ReactNode }) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className={LABEL}>
        {label}{props.required && <span className="text-rose-500"> *</span>}
      </label>
      <div className="relative">
        {icon && <span aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-muted">{icon}</span>}
        <input id={id} className={inputClasses(cn('h-9', !!icon && 'pl-9'))} {...props} />
      </div>
    </div>
  );
}

/** Password field with a show/hide toggle, plus Generate and Copy buttons beside it. */
function PasswordInput({
  label, value, onChange, show, setShow, onGenerate, onCopy,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  show: boolean;
  setShow: (v: boolean) => void;
  onGenerate: () => void;
  onCopy: () => void;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={cn(LABEL, 'flex items-center gap-1.5')}>
        <Lock size={14} className="text-text-muted" /> {label}
      </label>
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <input
            id={id}
            type={show ? 'text' : 'password'}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Enter or generate a password"
            autoComplete="new-password"
            className={inputClasses('h-9 pr-9 font-mono text-xs')}
          />
          <button
            type="button"
            aria-label={show ? 'Hide password' : 'Show password'}
            onClick={() => setShow(!show)}
            className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-text-muted transition-colors hover:text-text-main"
          >
            {show ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        <MuiTooltip title="Generate strong password">
          <Button iconOnly aria-label="Generate strong password" onClick={onGenerate} className="size-9">
            <RefreshCw size={14} />
          </Button>
        </MuiTooltip>
        <MuiTooltip title="Copy password">
          <Button iconOnly aria-label="Copy password" onClick={onCopy} className="size-9">
            <Copy size={14} />
          </Button>
        </MuiTooltip>
      </div>
      <p className={HINT}>Share this with the user securely — they can change it later from Settings.</p>
    </div>
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
    const passwordError = passwordPolicyError(newPassword);
    if (passwordError) { showToast(passwordError, 'error'); return; }
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
    const passwordError = passwordPolicyError(resetPassword);
    if (passwordError) { showToast(passwordError, 'error'); return; }
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
      showToast(resetUser.id === currentSession?.id
        ? 'Password reset. Your other sessions were signed out.'
        : `Password reset for ${resetUser.email}. They were signed out everywhere.`);
      setResetUser(null); setResetPassword('');
    } catch (err: any) {
      showToast(err.message || 'Failed to reset password', 'error');
    } finally {
      setResetting(false);
    }
  };

  const handleToggleRole = async (userId: string, currentRole: 'ADMIN' | 'USER') => {
    if (currentSession && userId === currentSession.id) { showToast('You cannot change your own role.', 'error'); return; }
    const targetRole = currentRole === 'ADMIN' ? 'USER' : 'ADMIN';
    try {
      const res = await fetch('/api/users', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: userId, role: targetRole }),
      });
      if (!res.ok) {
        const errObj = await res.json().catch(() => ({}));
        throw new Error(errObj.error || 'Failed to update role.');
      }
      showToast(`Role changed to ${targetRole}. They were signed out and must sign in again.`);
      await fetchUsers();
    } catch (err: any) {
      showToast(err.message || 'Failed to modify role', 'error');
    }
  };

  const setUserDisabled = async (user: DbUser, disabled: boolean) => {
    try {
      const res = await fetch('/api/users', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: user.id, disabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Failed to ${disabled ? 'disable' : 'enable'} user.`);
      }
      if (disabled) {
        const paused = Number(data.pausedCampaigns) || 0;
        const campaigns = paused === 0 ? 'They had no Active campaigns.'
          : `${paused} Active ${paused === 1 ? 'campaign was' : 'campaigns were'} paused.`;
        showToast(`${user.email} is disabled and was signed out. ${campaigns}`);
      } else {
        showToast(`${user.email} is enabled and can sign in again. Their paused campaigns stay paused until activated.`);
      }
      await fetchUsers();
    } catch (err: any) {
      showToast(err.message || `Failed to ${disabled ? 'disable' : 'enable'} user`, 'error');
    }
  };

  const handleDisableUser = (user: DbUser) => {
    if (currentSession && user.id === currentSession.id) { showToast('You cannot disable your own account.', 'error'); return; }
    setConfirmState({
      title: 'Disable User?',
      message: `${user.email} will be signed out everywhere at once and can not sign in until an admin enables the account again. Their Active campaigns will be paused, and campaigns paused by the send engine will no longer resume on their own. Enabling the account again does not resume them; an admin or the owner must activate them. Their mailboxes and Draft campaigns are kept as they are.`,
      confirmLabel: 'Disable User',
      onConfirm: async () => {
        setConfirmState(null);
        await setUserDisabled(user, true);
      },
    });
  };

  const handleDeleteUser = (userId: string) => {
    if (currentSession && userId === currentSession.id) { showToast('Cannot delete your own active session.', 'error'); return; }
    setConfirmState({
      title: 'Delete User?',
      message: `Permanently delete the account for ${users.find((u) => u.id === userId)?.email || 'this user'}? This cannot be undone. Only a user who owns no mailboxes or campaigns can be deleted; to keep their work, disable them instead.`,
      confirmLabel: 'Delete User',
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/users?id=${userId}`, { method: 'DELETE' });
          if (!res.ok) {
            const errObj = await res.json().catch(() => ({}));
            throw new Error(errObj.error || 'Failed to delete user.');
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
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-4 pb-12">
      <Snackbar
        open={!!toast}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        autoHideDuration={4000}
        onClose={() => setToast(null)}
      >
        {toast ? <Alert severity={toast.type} variant="filled" sx={{ borderRadius: '12px' }}>{toast.message}</Alert> : undefined}
      </Snackbar>

      <PageHeader
        title="Team Directory"
        actions={
          <Button variant="primary" onClick={() => setIsAddOpen(true)}>
            <UserPlus size={14} />
            Add User
          </Button>
        }
      />

      {error ? (
        <Notice tone="error" title="Privileged Access Required">{error}</Notice>
      ) : loading ? (
        <div className="flex items-center justify-center gap-2 py-24 text-xs text-text-muted">
          <Loader2 size={14} className="animate-spin" /> Loading users…
        </div>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <tr>
                  <TH>Name</TH>
                  <TH>Email</TH>
                  <TH>Role</TH>
                  <TH>Joined</TH>
                  <TH className="text-right">Actions</TH>
                </tr>
              </THead>
              <tbody>
                {users.map((item) => {
                  const isSelf = item.id === currentSession?.id;
                  return (
                    <TR key={item.id}>
                      <TD>
                        <div className="flex items-center gap-3">
                          <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-text-sub dark:bg-white/5">
                            {(item.name || item.email)[0]?.toUpperCase()}
                          </span>
                          <div className="min-w-0">
                            <div className="font-medium">{item.name || 'Unnamed Employee'}</div>
                            <div className="text-[11px] text-text-muted">UID: {item.id.slice(0, 13)}…</div>
                          </div>
                        </div>
                      </TD>
                      <TD className="text-text-sub">{item.email}</TD>
                      <TD>
                        <div className="flex flex-wrap gap-1.5">
                          <Badge tone={item.role === 'ADMIN' ? 'red' : 'blue'}>
                            {item.role === 'ADMIN' ? <Shield size={12} aria-hidden /> : <Users size={12} aria-hidden />}
                            {item.role}
                          </Badge>
                          {item.disabledAt && (
                            <Badge>
                              <UserX size={12} aria-hidden />
                              Disabled
                            </Badge>
                          )}
                        </div>
                      </TD>
                      <TD className="whitespace-nowrap text-text-sub">
                        {new Date(item.createdAt).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })}
                      </TD>
                      <TD>
                        <div className="flex items-center justify-end gap-1">
                          <Button size="sm" variant="ghost" disabled={isSelf} onClick={() => handleToggleRole(item.id, item.role)}>
                            {item.role === 'ADMIN' ? 'Demote' : 'Promote'}
                          </Button>
                          <MuiTooltip title="Reset password">
                            <Button iconOnly size="sm" variant="ghost" aria-label="Reset password" onClick={() => { setResetUser(item); setResetPassword(''); setShowResetPassword(true); }}>
                              <KeyRound size={14} />
                            </Button>
                          </MuiTooltip>
                          {item.disabledAt ? (
                            <MuiTooltip title="Enable user">
                              <Button iconOnly size="sm" variant="ghost" aria-label="Enable user" onClick={() => setUserDisabled(item, false)}>
                                <UserCheck size={14} />
                              </Button>
                            </MuiTooltip>
                          ) : (
                            <MuiTooltip title={isSelf ? 'Cannot disable yourself' : 'Disable user'}>
                              <span>
                                <Button iconOnly size="sm" variant="ghost" aria-label="Disable user" disabled={isSelf} onClick={() => handleDisableUser(item)}>
                                  <UserX size={14} />
                                </Button>
                              </span>
                            </MuiTooltip>
                          )}
                          <MuiTooltip title={isSelf ? 'Cannot delete yourself' : 'Delete user'}>
                            <span>
                              <Button
                                iconOnly
                                size="sm"
                                variant="ghost"
                                aria-label="Delete user"
                                disabled={isSelf}
                                onClick={() => handleDeleteUser(item.id)}
                                className="text-rose-600 hover:bg-rose-50 hover:text-rose-700 dark:text-rose-400 dark:hover:bg-rose-500/10 dark:hover:text-rose-300"
                              >
                                <Trash2 size={14} />
                              </Button>
                            </span>
                          </MuiTooltip>
                        </div>
                      </TD>
                    </TR>
                  );
                })}
              </tbody>
            </Table>
          </div>
        </Card>
      )}

      {/* Add User Dialog */}
      <Dialog open={isAddOpen} onClose={() => setIsAddOpen(false)} maxWidth="sm" fullWidth slotProps={DIALOG_PAPER}>
        <form onSubmit={handleCreateUser}>
          <h2 className="flex items-center gap-2 px-5 pt-5 pb-4 text-[15px] font-semibold text-text-main">
            <UserPlus size={16} className="text-primary" /> Add User
          </h2>
          <div className="space-y-4 border-y border-card-border px-5 py-4">
            <TextInput label="Name" required autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} />
            <TextInput
              label="Email" type="email" required icon={<Mail size={14} />}
              value={newEmail} onChange={(e) => setNewEmail(e.target.value)}
            />
            <PasswordInput
              label="Password"
              value={newPassword}
              onChange={setNewPassword}
              show={showNewPassword}
              setShow={setShowNewPassword}
              onGenerate={() => { setNewPassword(generatePassword()); setShowNewPassword(true); }}
              onCopy={() => copyToClipboard(newPassword)}
            />
            <div>
              <span className={LABEL}>Role</span>
              <Segmented
                label="Role"
                value={newRole}
                onChange={setNewRole}
                options={[
                  { value: 'USER', label: 'User' },
                  { value: 'ADMIN', label: 'Admin' },
                ]}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 px-5 py-4">
            <Button variant="ghost" onClick={() => setIsAddOpen(false)}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
              {submitting ? 'Adding…' : 'Add User'}
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Reset Password Dialog */}
      <Dialog open={!!resetUser} onClose={() => setResetUser(null)} maxWidth="sm" fullWidth slotProps={DIALOG_PAPER}>
        <form onSubmit={handleResetPassword}>
          <h2 className="flex items-center gap-2 px-5 pt-5 pb-4 text-[15px] font-semibold text-text-main">
            <KeyRound size={16} className="text-primary" /> Reset Password
          </h2>
          <div className="space-y-4 border-y border-card-border px-5 py-4">
            <p className="text-[13px] text-text-sub">
              Set a new password for <strong className="font-semibold text-text-main">{resetUser?.email}</strong>.
            </p>
            <PasswordInput
              label="New Password"
              value={resetPassword}
              onChange={setResetPassword}
              show={showResetPassword}
              setShow={setShowResetPassword}
              onGenerate={() => { setResetPassword(generatePassword()); setShowResetPassword(true); }}
              onCopy={() => copyToClipboard(resetPassword)}
            />
          </div>
          <div className="flex justify-end gap-2 px-5 py-4">
            <Button variant="ghost" onClick={() => setResetUser(null)}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={resetting}>
              {resetting ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
              {resetting ? 'Resetting…' : 'Reset Password'}
            </Button>
          </div>
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
    </div>
  );
}
