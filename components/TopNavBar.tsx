'use client';

import React, { useState, useEffect, useRef, useMemo, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import {
  Search,
  Sun,
  Moon,
  Menu,
  X,
  LogOut,
  Settings,
  ShieldCheck,
  User,
  ChevronDown,
  LayoutDashboard,
  Send,
  Users,
  Inbox,
  Mail,
  FileText,
  ArrowRight,
} from 'lucide-react';
import { useTheme } from '@/components/ThemeProvider';
import { profileInitials } from '@/lib/profileInitials';
import { deliveryStatusText } from '@/lib/systemStatus';
import type { UserSession } from '@/lib/session';
import { Tooltip } from '@mui/material';

export interface TopNavBarProps {
  session?: UserSession | null;
  systemStatus?: any | null;
  onMobileMenuToggle?: () => void;
}

interface NavCommandItem {
  id: string;
  title: string;
  description: string;
  href: string;
  icon: React.ElementType;
  adminOnly?: boolean;
}

const COMMAND_NAV_ITEMS: NavCommandItem[] = [
  { id: 'dashboard', title: 'Dashboard', description: 'Overview, deliverability metrics, and active charts', href: '/', icon: LayoutDashboard },
  { id: 'campaigns', title: 'Campaigns', description: 'Automated outbound sequences and active cadences', href: '/campaigns', icon: Send },
  { id: 'leads', title: 'Leads', description: 'Contact lists, lead imports, and CRM prospects', href: '/leads', icon: Users },
  { id: 'unibox', title: 'Unibox', description: 'Unified multi-inbox thread management and replies', href: '/unibox', icon: Inbox },
  { id: 'accounts', title: 'Accounts', description: 'Sender mailboxes, IMAP sync, and daily quotas', href: '/accounts', icon: Mail },
  { id: 'templates', title: 'Templates', description: 'Email copywriting snippets and sequence steps', href: '/templates', icon: FileText },
  { id: 'settings', title: 'Settings', description: 'Profile preferences, time zone, and system settings', href: '/settings', icon: Settings },
  { id: 'admin-users', title: 'Users Admin', description: 'Role assignments, invites, and team permissions', href: '/admin/users', icon: ShieldCheck, adminOnly: true },
];

const DELIVERY_CONFIG: Record<
  string,
  { label: string; dotClass: string; bgClass: string; textClass: string; borderClass: string; pulse: boolean }
> = {
  RUNNING: {
    label: 'Outbox Running',
    dotClass: 'bg-emerald-500',
    bgClass: 'bg-emerald-50 dark:bg-emerald-950/40',
    textClass: 'text-emerald-700 dark:text-emerald-300',
    borderClass: 'border-emerald-200 dark:border-emerald-800/60',
    pulse: true,
  },
  STALLED: {
    label: 'Outbox Stalled',
    dotClass: 'bg-amber-500',
    bgClass: 'bg-amber-50 dark:bg-amber-950/40',
    textClass: 'text-amber-700 dark:text-amber-300',
    borderClass: 'border-amber-200 dark:border-amber-800/60',
    pulse: true,
  },
  FAILING: {
    label: 'Outbox Failing',
    dotClass: 'bg-rose-500',
    bgClass: 'bg-rose-50 dark:bg-rose-950/40',
    textClass: 'text-rose-700 dark:text-rose-300',
    borderClass: 'border-rose-200 dark:border-rose-800/60',
    pulse: false,
  },
  NOT_RUNNING: {
    label: 'Outbox Not Running',
    dotClass: 'bg-rose-500',
    bgClass: 'bg-rose-50 dark:bg-rose-950/40',
    textClass: 'text-rose-700 dark:text-rose-300',
    borderClass: 'border-rose-200 dark:border-rose-800/60',
    pulse: false,
  },
  DISABLED: {
    label: 'Sending Disabled',
    dotClass: 'bg-amber-500',
    bgClass: 'bg-amber-50 dark:bg-amber-950/40',
    textClass: 'text-amber-700 dark:text-amber-300',
    borderClass: 'border-amber-200 dark:border-amber-800/60',
    pulse: false,
  },
};

const emptySubscribe = () => () => {};

export function TopNavBar({ session, systemStatus, onMobileMenuToggle }: TopNavBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { theme, toggleTheme } = useTheme();

  // Hydration-safe client flags using useSyncExternalStore
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false);
  const isMac = useSyncExternalStore(
    emptySubscribe,
    () => typeof navigator !== 'undefined' && /(Mac|iPhone|iPod|iPad)/i.test(navigator.userAgent),
    () => false
  );

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  // Close menus on route change during render
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (pathname !== prevPathname) {
    setPrevPathname(pathname);
    if (searchOpen) setSearchOpen(false);
    if (userMenuOpen) setUserMenuOpen(false);
  }

  const openSearch = () => {
    setSearchQuery('');
    setSelectedIndex(0);
    setSearchOpen(true);
  };

  // Global keyboard shortcut: Cmd+K / Ctrl+K and Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((prev) => {
          if (!prev) {
            setSearchQuery('');
            setSelectedIndex(0);
          }
          return !prev;
        });
      } else if (e.key === 'Escape') {
        setSearchOpen(false);
        setUserMenuOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Auto-focus search input on modal open
  useEffect(() => {
    if (searchOpen) {
      const timer = setTimeout(() => {
        searchInputRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [searchOpen]);

  // Click outside listener for user menu
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    if (userMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [userMenuOpen]);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      const res = await fetch('/api/auth/logout', { method: 'POST' });
      if (res.ok) {
        window.location.href = '/login';
      }
    } catch (e) {
      console.error('Logout failed:', e);
    } finally {
      setLoggingOut(false);
    }
  };

  // Profile avatar initials
  const initials = useMemo(() => {
    if (!session) return '';
    const parts = (session.name || '').trim().split(/\s+/);
    const firstName = parts[0] || '';
    const lastName = parts.length > 1 ? parts[parts.length - 1] : '';
    return profileInitials(firstName, lastName, session.email || '');
  }, [session]);

  // Delivery status configuration
  const deliveryStatusKey = systemStatus?.deliveryStatus;
  const currentDelivery = deliveryStatusKey
    ? DELIVERY_CONFIG[deliveryStatusKey] ?? {
        label: 'Outbox Status Unknown',
        dotClass: 'bg-slate-400',
        bgClass: 'bg-slate-100 dark:bg-slate-800',
        textClass: 'text-slate-600 dark:text-slate-400',
        borderClass: 'border-slate-200 dark:border-slate-700',
        pulse: false,
      }
    : {
        label: !systemStatus ? 'Checking Outbox' : 'Outbox Status Unknown',
        dotClass: 'bg-slate-400',
        bgClass: 'bg-slate-100 dark:bg-slate-800',
        textClass: 'text-slate-600 dark:text-slate-400',
        borderClass: 'border-slate-200 dark:border-slate-700',
        pulse: false,
      };

  const deliveryDetail = systemStatus?.deliveryStatus
    ? deliveryStatusText(systemStatus.deliveryStatus, systemStatus.sendingProblem, systemStatus.workerHeartbeat)
    : !systemStatus
    ? 'Checking delivery engine and worker heartbeat…'
    : 'System status could not be read.';

  // Filter command items
  const availableCommands = useMemo(() => {
    return COMMAND_NAV_ITEMS.filter((item) => {
      if (item.adminOnly && session?.role !== 'ADMIN') return false;
      return true;
    });
  }, [session?.role]);

  const filteredCommands = useMemo(() => {
    if (!searchQuery.trim()) return availableCommands;
    const q = searchQuery.toLowerCase().trim();
    return availableCommands.filter(
      (item) => item.title.toLowerCase().includes(q) || item.description.toLowerCase().includes(q)
    );
  }, [availableCommands, searchQuery]);

  const handleCommandSelect = (href: string) => {
    setSearchOpen(false);
    router.push(href);
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (filteredCommands.length ? (prev + 1) % filteredCommands.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (filteredCommands.length ? (prev - 1 + filteredCommands.length) % filteredCommands.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredCommands[selectedIndex]) {
        handleCommandSelect(filteredCommands[selectedIndex].href);
      }
    }
  };

  return (
    <>
      <header
        role="banner"
        className="sticky top-0 z-40 w-full h-16 bg-white/80 dark:bg-[#11131A]/80 backdrop-blur-md border-b border-[#EBF0F5] dark:border-[#1E222D] transition-colors duration-200 px-4 sm:px-6"
      >
        <div className="h-full flex items-center justify-between gap-3 max-w-7xl mx-auto">
          {/* Left section: Mobile menu toggle + Brand (mobile) + Search pill */}
          <div className="flex items-center gap-3 flex-1 min-w-0">
            {/* Mobile hamburger button */}
            <button
              type="button"
              onClick={onMobileMenuToggle}
              aria-label="Open Navigation"
              className="p-2 -ml-1.5 rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors md:hidden"
            >
              <Menu size={20} />
            </button>

            {/* Mobile Brand indicator */}
            <div className="flex items-center gap-2 md:hidden">
              <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center text-white shadow-xs">
                <Mail size={15} />
              </div>
              <span className="font-bold text-sm tracking-wider text-slate-900 dark:text-white">ARCREACH</span>
            </div>

            {/* Search pill */}
            <button
              type="button"
              onClick={openSearch}
              aria-label="Search navigation and resources"
              className="hidden sm:flex items-center justify-between w-64 md:w-80 px-3.5 py-1.5 rounded-full bg-[#F5F6F9] dark:bg-[#161822] border border-[#EBF0F5] dark:border-[#262B38] text-sm text-slate-500 dark:text-slate-400 hover:border-blue-400 dark:hover:border-blue-500 hover:bg-white dark:hover:bg-[#11131A] transition-all cursor-pointer shadow-2xs group"
            >
              <span className="flex items-center gap-2.5 truncate">
                <Search size={15} className="text-slate-400 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors" />
                <span className="text-xs font-normal">Search anything...</span>
              </span>
              <kbd className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-semibold font-mono rounded bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 shadow-2xs">
                {mounted && isMac ? '⌘K' : 'Ctrl K'}
              </kbd>
            </button>

            {/* Mobile search trigger button */}
            <button
              type="button"
              onClick={openSearch}
              aria-label="Search"
              className="sm:hidden p-2 rounded-full text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <Search size={18} />
            </button>
          </div>

          {/* Right section: Live Delivery Chip + Theme Toggle + User Avatar */}
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            {/* Live Delivery Outbox Chip */}
            <Tooltip title={deliveryDetail} arrow placement="bottom">
              <div
                tabIndex={0}
                role="status"
                aria-label={`Outbox status: ${currentDelivery.label}`}
                className={`hidden md:inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold border transition-all cursor-default select-none shadow-2xs ${currentDelivery.bgClass} ${currentDelivery.textClass} ${currentDelivery.borderClass}`}
              >
                <span className="relative flex h-2 w-2">
                  {currentDelivery.pulse && (
                    <span
                      className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${currentDelivery.dotClass}`}
                    />
                  )}
                  <span className={`relative inline-flex rounded-full h-2 w-2 ${currentDelivery.dotClass}`} />
                </span>
                <span className="font-mono text-[11px] tracking-tight">{currentDelivery.label}</span>
              </div>
            </Tooltip>

            {/* Compact delivery dot on smaller screens */}
            <Tooltip title={deliveryDetail} arrow placement="bottom">
              <div
                tabIndex={0}
                role="status"
                aria-label={`Outbox status: ${currentDelivery.label}`}
                className={`md:hidden p-2 rounded-full border ${currentDelivery.bgClass} ${currentDelivery.borderClass}`}
              >
                <span className="relative flex h-2 w-2">
                  {currentDelivery.pulse && (
                    <span
                      className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${currentDelivery.dotClass}`}
                    />
                  )}
                  <span className={`relative inline-flex rounded-full h-2 w-2 ${currentDelivery.dotClass}`} />
                </span>
              </div>
            </Tooltip>

            {/* Theme Toggle Button */}
            <Tooltip title={mounted ? (theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode') : 'Toggle Theme'} arrow>
              <button
                type="button"
                onClick={toggleTheme}
                aria-label={mounted ? (theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode') : 'Toggle Theme'}
                className="p-2 rounded-full border border-[#EBF0F5] dark:border-[#262B38] bg-white dark:bg-[#11131A] text-slate-600 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 hover:border-blue-300 dark:hover:border-blue-600 transition-colors shadow-2xs"
              >
                {mounted && theme === 'dark' ? (
                  <Sun size={17} className="text-amber-500" />
                ) : (
                  <Moon size={17} className="text-slate-600 dark:text-slate-300" />
                )}
              </button>
            </Tooltip>

            {/* Vertical Divider */}
            <div className="h-6 w-px bg-[#EBF0F5] dark:bg-[#1E222D]" />

            {/* User Profile Avatar with Dropdown */}
            <div className="relative" ref={userMenuRef}>
              <button
                type="button"
                onClick={() => setUserMenuOpen((prev) => !prev)}
                aria-expanded={userMenuOpen}
                aria-haspopup="true"
                aria-label="User Account Menu"
                className="flex items-center gap-2 p-1 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors group"
              >
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-600 to-blue-700 text-white font-bold text-xs flex items-center justify-center shadow-2xs border-2 border-white dark:border-[#1E222D] select-none">
                  {initials ? initials : <User size={15} />}
                </div>

                <div className="hidden lg:flex flex-col text-left mr-1">
                  <span className="text-xs font-bold text-slate-900 dark:text-white leading-tight truncate max-w-[120px]">
                    {session?.name || 'User'}
                  </span>
                  <span className="text-[10px] text-slate-500 dark:text-slate-400 leading-tight">
                    {session?.role || 'USER'}
                  </span>
                </div>

                <ChevronDown
                  size={14}
                  className={`hidden sm:block text-slate-400 transition-transform duration-200 ${
                    userMenuOpen ? 'rotate-180' : ''
                  }`}
                />
              </button>

              {/* Dropdown Menu */}
              {userMenuOpen && (
                <div
                  role="menu"
                  aria-orientation="vertical"
                  className="absolute right-0 mt-2 w-64 rounded-2xl bg-white dark:bg-[#11131A] border border-[#EBF0F5] dark:border-[#1E222D] shadow-xl py-2 z-50 animate-in fade-in zoom-in-95 duration-150"
                >
                  {/* User summary header */}
                  <div className="px-4 py-3 border-b border-[#EBF0F5] dark:border-[#1E222D]">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-bold text-slate-900 dark:text-white truncate">
                        {session?.name || 'User'}
                      </span>
                      <span
                        className={`text-[9px] font-bold font-mono px-1.5 py-0.5 rounded-full ${
                          session?.role === 'ADMIN'
                            ? 'bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300 border border-rose-200 dark:border-rose-900'
                            : 'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300 border border-blue-200 dark:border-blue-900'
                        }`}
                      >
                        {session?.role || 'USER'}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                      {session?.email || 'No email associated'}
                    </p>
                  </div>

                  {/* Navigation Links */}
                  <div className="py-1">
                    <Link
                      href="/settings"
                      role="menuitem"
                      onClick={() => setUserMenuOpen(false)}
                      className="flex items-center gap-2.5 px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/60 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                    >
                      <Settings size={15} />
                      <span>Account Settings</span>
                    </Link>

                    {session?.role === 'ADMIN' && (
                      <Link
                        href="/admin/users"
                        role="menuitem"
                        onClick={() => setUserMenuOpen(false)}
                        className="flex items-center gap-2.5 px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/60 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                      >
                        <ShieldCheck size={15} />
                        <span>Users Administration</span>
                      </Link>
                    )}
                  </div>

                  <div className="border-t border-[#EBF0F5] dark:border-[#1E222D] my-1" />

                  {/* Logout Button */}
                  <div className="px-2 py-1">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={handleLogout}
                      disabled={loggingOut}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium rounded-xl text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors disabled:opacity-50"
                    >
                      <LogOut size={15} />
                      <span>{loggingOut ? 'Signing Out…' : 'Sign Out'}</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Global ⌘K Command Palette Dialog */}
      {searchOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Command search palette"
          className="fixed inset-0 z-50 flex items-start justify-center pt-16 sm:pt-24 px-4 bg-black/40 dark:bg-black/70 backdrop-blur-xs animate-in fade-in duration-150"
          onClick={() => setSearchOpen(false)}
        >
          <div
            className="w-full max-w-xl bg-white dark:bg-[#11131A] rounded-2xl border border-[#EBF0F5] dark:border-[#1E222D] shadow-2xl overflow-hidden animate-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Search Input Bar */}
            <div className="flex items-center gap-3 px-4 py-3.5 border-b border-[#EBF0F5] dark:border-[#1E222D]">
              <Search size={18} className="text-slate-400 shrink-0" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setSelectedIndex(0);
                }}
                onKeyDown={handleSearchKeyDown}
                placeholder="Search anything or jump to route..."
                className="flex-1 bg-transparent border-0 outline-hidden text-sm text-slate-900 dark:text-white placeholder-slate-400"
              />
              <button
                type="button"
                onClick={() => setSearchOpen(false)}
                aria-label="Close command palette"
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            {/* Command Items List */}
            <div className="max-h-80 overflow-y-auto p-2">
              <div className="px-2 py-1.5 text-[10px] font-bold font-mono tracking-wider text-slate-400 uppercase">
                Navigation & Routes
              </div>

              {filteredCommands.length === 0 ? (
                <div className="py-8 text-center text-sm text-slate-400">
                  No matching destinations found for &quot;{searchQuery}&quot;
                </div>
              ) : (
                <div className="space-y-0.5">
                  {filteredCommands.map((item, index) => {
                    const Icon = item.icon;
                    const isSelected = index === selectedIndex;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => handleCommandSelect(item.href)}
                        onMouseEnter={() => setSelectedIndex(index)}
                        className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-left transition-colors cursor-pointer ${
                          isSelected
                            ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400'
                            : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100/70 dark:hover:bg-slate-800/50'
                        }`}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div
                            className={`p-2 rounded-lg ${
                              isSelected
                                ? 'bg-blue-600 text-white'
                                : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
                            }`}
                          >
                            <Icon size={16} />
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs font-semibold truncate">{item.title}</p>
                            <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">{item.description}</p>
                          </div>
                        </div>
                        <ArrowRight size={14} className={`shrink-0 ${isSelected ? 'opacity-100' : 'opacity-0'}`} />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Footer keyboard hints */}
            <div className="flex items-center justify-between px-4 py-2 border-t border-[#EBF0F5] dark:border-[#1E222D] bg-slate-50 dark:bg-[#161822] text-[11px] text-slate-500 dark:text-slate-400 font-mono">
              <span>Use ↑ ↓ to navigate</span>
              <span>↵ to select · ESC to close</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default TopNavBar;
