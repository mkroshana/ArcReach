/* eslint-disable react-hooks/set-state-in-effect, react/no-unescaped-entities, react-hooks/exhaustive-deps */
'use client';

import { useState, useEffect } from 'react';
import {
  Users,
  Shield,
  Trash2,
  UserPlus,
  CheckCircle,
  AlertTriangle,
  X,
  Mail,
  Calendar,
  Lock,
  UserCheck
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface DbUser {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'USER';
  createdAt: string;
}

export default function UsersAdminPage() {
  const [users, setUsers] = useState<DbUser[]>([]);
  const [currentSession, setCurrentSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modal State
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState<'ADMIN' | 'USER'>('USER');
  const [submitting, setSubmitting] = useState(false);

  // Success message toast
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const fetchUsers = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/users');
      if (!res.ok) {
        throw new Error(await res.text() || 'Failed to fetch directory users');
      }
      const data = await res.json();
      setUsers(data);
    } catch (err: any) {
      setError(err.message || 'Access Denied. You do not have permissions to access the Admin Console.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
    fetch('/api/session')
      .then(res => res.json())
      .then(data => setCurrentSession(data))
      .catch(() => {});
  }, []);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEmail) return;

    try {
      setSubmitting(true);
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName,
          email: newEmail,
          role: newRole,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        let parsedErr = 'Failed to create user';
        try {
          parsedErr = JSON.parse(errText).error || parsedErr;
        } catch {
          parsedErr = errText || parsedErr;
        }
        throw new Error(parsedErr);
      }

      await fetchUsers(); // Refresh
      setIsAddOpen(false);
      setNewEmail('');
      setNewName('');
      setNewRole('USER');
      showToast('User added');
    } catch (err: any) {
      showToast(err.message || 'Error occurred', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleRole = async (userId: string, currentRole: 'ADMIN' | 'USER') => {
    // Basic protection
    if (userId === 'admin-id-999') {
      showToast('Cannot modify default root administrator privileges.', 'error');
      return;
    }

    const targetRole = currentRole === 'ADMIN' ? 'USER' : 'ADMIN';

    try {
      const res = await fetch('/api/users', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: userId, role: targetRole }),
      });

      if (!res.ok) {
        throw new Error(await res.text() || 'Failed to update credentials.');
      }

      showToast(`User permissions changed to ${targetRole}`);
      await fetchUsers();
    } catch (err: any) {
      showToast(err.message || 'Failed to modify role', 'error');
    }
  };

  const handleDeleteUser = async (userId: string) => {
    if (userId === 'admin-id-999') {
      showToast('Cannot delete root super administrative profile.', 'error');
      return;
    }
    if (currentSession && userId === currentSession.id) {
      showToast('Cannot delete your own active session.', 'error');
      return;
    }

    if (!confirm('Are you absolute sure you want to remove this user from ArcReach? All assigned mailboxes and campaigns will lock.')) {
      return;
    }

    try {
      const res = await fetch(`/api/users?id=${userId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const errObj = await res.json().catch(() => ({}));
        throw new Error(errObj.error || 'Failed to revoke permissions.');
      }

      showToast('User deleted');
      await fetchUsers();
    } catch (err: any) {
      showToast(err.message || 'Failed to delete user', 'error');
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-5xl mx-auto pb-10">

      {/* Toast Overlay */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20 }}
            className={`fixed top-4 right-4 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-xl border backdrop-blur-md min-w-[300px] ${toast.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400'
              : 'bg-rose-500/10 border-rose-500/20 text-rose-600 dark:text-rose-400'
              }`}
          >
            {toast.type === 'success' ? <CheckCircle className="w-5 h-5 flex-shrink-0" /> : <AlertTriangle className="w-5 h-5 flex-shrink-0" />}
            <p className="text-xs font-semibold leading-normal">{toast.message}</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <header className="flex justify-between items-center pb-4 border-b border-slate-200 dark:border-slate-800">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white mb-0.5">Team Directory</h1>
          <p className="text-slate-500 dark:text-slate-400 text-xs">Manage team members and their roles.</p>
        </div>
        <button
          onClick={() => setIsAddOpen(true)}
          className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg font-semibold flex items-center gap-2 transition-colors text-xs shadow-xs"
        >
          <UserPlus className="w-4 h-4" />
          Add User
        </button>
      </header>

      {/* Main Glassmorphism Data Table */}
      {error ? (
        <div className="p-8 bg-rose-500/5 border border-rose-500/20 rounded-xl text-center max-w-lg mx-auto">
          <AlertTriangle className="w-10 h-10 text-rose-500 mx-auto mb-3 animate-pulse" />
          <h3 className="text-slate-900 dark:text-white font-bold text-sm">Privileged Access Required</h3>
          <p className="text-slate-500 text-xs mt-1.5 leading-relaxed">{error}</p>
          <div className="mt-4 p-2.5 bg-slate-100 dark:bg-slate-900 rounded-lg text-[11px] text-slate-500 leading-relaxed max-w-sm mx-auto font-medium">
            <strong>Simulation Note:</strong> Click the <strong>"Toggle to Admin"</strong> button in the left-hand sidebar workspace first to see the secure user database.
          </div>
        </div>
      ) : loading ? (
        <div className="py-20 text-center text-slate-400 dark:text-slate-500 text-xs space-y-3">
          <div className="w-6 h-6 border-2 border-slate-400 dark:border-slate-700 border-t-blue-500 animate-spin rounded-full mx-auto" />
          <p className="font-medium tracking-wide">Querying corporate user directory secure nodes...</p>
        </div>
      ) : (
        <div className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl overflow-hidden shadow-xs">
          <div className="p-4 border-b border-slate-200 dark:border-[#1b1c26] flex items-center justify-between bg-slate-50/40 dark:bg-slate-950/20">
            <h2 className="text-xs font-bold text-slate-800 dark:text-white uppercase tracking-widest">All Users</h2>
            <span className="text-[10px] font-bold text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10 px-2.5 py-0.5 rounded border border-emerald-200 dark:border-emerald-500/15 uppercase tracking-widest font-mono">RBAC Active</span>
          </div>

          <div className="w-full overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-[#1b1c26] text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest bg-slate-50/20 dark:bg-slate-950/10">
                  <th className="px-5 py-3">Name</th>
                  <th className="px-5 py-3">Email</th>
                  <th className="px-5 py-3">Role</th>
                  <th className="px-5 py-3">Joined</th>
                  <th className="px-5 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-[#1b1c26]/60 text-slate-700 dark:text-slate-300">
                {users.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50/50 dark:hover:bg-white/[0.01] transition-all group">
                    <td className="px-5 py-3.5">
                      <div className="font-semibold text-xs text-slate-900 dark:text-white">{item.name || 'Unnamed Employee'}</div>
                      <div className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">UID: {item.id}</div>
                    </td>
                    <td className="px-5 py-3.5 font-mono text-[11px] text-slate-600 dark:text-slate-400">
                      {item.email}
                    </td>
                    <td className="px-5 py-3.5">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold border uppercase tracking-wider ${item.role === 'ADMIN'
                        ? 'bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-500/20'
                        : 'bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-500/20'
                        }`}>
                        {item.role === 'ADMIN' ? <Shield className="w-2.5 h-2.5" /> : <Users className="w-2.5 h-2.5" />}
                        {item.role}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-xs text-slate-500 dark:text-slate-400">
                      {new Date(item.createdAt).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })}
                    </td>
                    <td className="px-5 py-3.5 text-right space-x-2">
                      <button
                        onClick={() => handleToggleRole(item.id, item.role)}
                        disabled={item.id === 'admin-id-999'}
                        className={`text-[10px] font-bold uppercase border px-2.5 py-1 rounded-lg transition-colors inline-flex items-center gap-1 ${item.id === 'admin-id-999'
                          ? 'opacity-30 cursor-not-allowed border-slate-200 dark:border-slate-800 text-slate-400'
                          : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 cursor-pointer text-slate-700 dark:text-slate-300'
                          }`}
                      >
                        {item.role === 'ADMIN' ? 'Demote to User' : 'Promote to Admin'}
                      </button>
                      <button
                        onClick={() => handleDeleteUser(item.id)}
                        disabled={item.id === 'admin-id-999' || item.id === currentSession?.id}
                        className={`p-1.5 rounded-lg border transition-colors inline-flex items-center justify-center ${item.id === 'admin-id-999' || item.id === currentSession?.id
                          ? 'opacity-30 cursor-not-allowed border-slate-200 dark:border-slate-800 text-slate-400'
                          : 'border-rose-200 dark:border-[#961747]/30 text-rose-500 dark:text-rose-500 hover:bg-rose-500/10 cursor-pointer'
                          }`}
                        title={item.id === currentSession?.id ? "Cannot delete yourself" : "Deauthorize Member"}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Frosted Translucent Modal to Add User */}
      <AnimatePresence>
        {isAddOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsAddOpen(false)}
              className="absolute inset-0 bg-slate-950/40 backdrop-blur-xs"
            />

            {/* Modal Body */}
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 15 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 15 }}
              className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1f2130] w-full max-w-md rounded-2xl p-6 shadow-2xl relative z-10 overflow-hidden"
            >
              {/* Abs Accent Orb */}
              <div className="absolute top-0 right-0 w-24 h-24 bg-blue-500/5 rounded-full blur-xl pointer-events-none" />

              <header className="flex justify-between items-center pb-4 border-b border-slate-100 dark:border-[#1c1d29] mb-4">
                <div className="flex items-center gap-2">
                  <UserPlus className="w-5 h-5 text-blue-500" />
                  <h3 className="text-sm font-bold text-slate-900 dark:text-white uppercase tracking-wider">Add User</h3>
                </div>
                <button
                  onClick={() => setIsAddOpen(false)}
                  className="p-1 hover:bg-slate-100 dark:hover:bg-slate-800/50 rounded-lg text-slate-400 dark:text-slate-500 transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </header>

              <form onSubmit={handleCreateUser} className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-widest font-bold">Name</label>
                  <input
                    type="text"
                    required
                    placeholder="E.g., Sandra Bullock"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-3 py-2.5 outline-none text-xs"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-widest font-bold flex items-center gap-1.5">
                    <Mail className="w-3.5 h-3.5" />
                    Email
                  </label>
                  <input
                    type="email"
                    required
                    placeholder="e.g., sandra@arcreach.com"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-3 py-2.5 outline-none text-xs font-mono"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-widest font-bold flex items-center gap-1.5">
                    <Lock className="w-3.5 h-3.5" />
                    Temporary Password
                  </label>
                  <input
                    type="text"
                    disabled
                    value="securemypassword123 (Auto)"
                    className="w-full bg-slate-100/50 dark:bg-slate-900/40 border border-slate-200 dark:border-[#1f2130]/60 text-slate-400 rounded-lg px-3 py-2.5 text-xs font-mono cursor-not-allowed"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-widest font-bold">Role</label>
                  <div className="grid grid-cols-2 gap-3 pt-0.5">
                    <button
                      type="button"
                      onClick={() => setNewRole('USER')}
                      className={`py-2 rounded-lg border text-xs font-semibold uppercase tracking-wider transition-all cursor-pointer ${newRole === 'USER'
                        ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-400'
                        : 'border-slate-200 dark:border-slate-800 text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/40'
                        }`}
                    >
                      User role
                    </button>
                    <button
                      type="button"
                      onClick={() => setNewRole('ADMIN')}
                      className={`py-2 rounded-lg border text-xs font-semibold uppercase tracking-wider transition-all cursor-pointer ${newRole === 'ADMIN'
                        ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500'
                        : 'border-slate-200 dark:border-slate-800 text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/40'
                        }`}
                    >
                      Admin role
                    </button>
                  </div>
                </div>

                <div className="pt-2 flex justify-end gap-3 border-t border-slate-100 dark:border-[#1c1d29] mt-6">
                  <button
                    type="button"
                    onClick={() => setIsAddOpen(false)}
                    className="px-4 py-2 bg-slate-50 hover:bg-slate-100 dark:bg-[#12141d] dark:hover:bg-[#1b1d28] border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/55 rounded-lg text-white font-semibold text-xs transition-colors flex items-center gap-1.5 cursor-pointer shadow-xs"
                  >
                    {submitting ? 'Adding...' : 'Add User'}
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

    </div>
  );
}
