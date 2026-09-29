/* eslint-disable react-hooks/set-state-in-effect */
'use client';

import {
  createContext, useContext, useEffect, useRef, useState, useCallback, useMemo,
} from 'react';
import { Box, LinearProgress, Card, Stack, Typography, CircularProgress, Fade } from '@mui/material';

/**
 * Global activity indicator for the whole app.
 *
 *  - A thin top progress bar reflects ALL in-flight `fetch` activity (auto-wired
 *    by wrapping window.fetch once), so any data load / mutation shows progress
 *    with no per-page code.
 *  - Notable mutations (sends, imports, verifies, …) are auto-labeled from their
 *    URL and listed in a floating panel of background tasks.
 *  - `useTasks().startTask(label)` lets any page register an explicit named task
 *    for long-running work that isn't a single fetch.
 */

interface TaskHandle {
  update: (label: string) => void;
  done: () => void;
}

interface TaskContextValue {
  busy: boolean;
  tasks: { id: number; label: string }[];
  startTask: (label: string) => TaskHandle;
}

const TaskContext = createContext<TaskContextValue | null>(null);

export function useTasks(): TaskContextValue {
  const ctx = useContext(TaskContext);
  if (!ctx) throw new Error('useTasks must be used within <TaskProvider>');
  return ctx;
}

/** Map a request to a human label, or null to track it as anonymous (bar only). */
function labelForRequest(url: string, method: string): string | null {
  const m = method.toUpperCase();
  if (/\/api\/campaigns\/[^/]+\/run/.test(url)) return 'Sending campaign emails';
  if (/\/api\/send-email\/test/.test(url)) return 'Sending test email';
  if (/\/api\/unibox\/reply/.test(url)) return 'Sending reply';
  if (/\/api\/leads\/bulk/.test(url) && m !== 'GET') return 'Processing leads';
  if (/\/api\/leads\/verify/.test(url)) return 'Verifying leads';
  if (/\/api\/leads\/groups/.test(url) && m !== 'GET') return 'Updating lead groups';
  if (/\/api\/templates/.test(url) && m !== 'GET') return 'Saving template';
  if (/\/api\/settings\/test-smtp/.test(url)) return 'Testing SMTP connection';
  return null;
}

export function TaskProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState(0);
  const [tasks, setTasks] = useState<{ id: number; label: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const idRef = useRef(0);
  const nextId = useCallback(() => ++idRef.current, []);

  const addTask = useCallback((label: string) => {
    const id = nextId();
    setPending((p) => p + 1);
    setTasks((t) => [...t, { id, label }]);
    return id;
  }, [nextId]);

  const removeTask = useCallback((id: number) => {
    setPending((p) => Math.max(0, p - 1));
    setTasks((t) => t.filter((x) => x.id !== id));
  }, []);

  const startTask = useCallback((label: string): TaskHandle => {
    const id = addTask(label);
    return {
      update: (l: string) => setTasks((t) => t.map((x) => (x.id === id ? { ...x, label: l } : x))),
      done: () => removeTask(id),
    };
  }, [addTask, removeTask]);

  // Wrap window.fetch once to auto-track all network activity.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const orig = window.fetch;
    if ((orig as any).__arcreachWrapped) return;

    const wrapped: typeof window.fetch = async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : (input?.url ?? String(input));

      // Only track the app's own API calls — skips Next.js RSC/route-prefetch
      // and static asset fetches that would otherwise flicker the bar on hover.
      if (!/\/api\//.test(url)) {
        return orig(input, init);
      }

      // Bump the anonymous pending counter (drives the top bar).
      setPending((p) => p + 1);

      // Notable mutations also get a labeled entry in the task panel.
      const method = init?.method || (typeof input === 'object' && input?.method) || 'GET';
      const label = labelForRequest(url, method);
      let taskId: number | null = null;
      if (label) {
        taskId = nextId();
        setTasks((t) => [...t, { id: taskId as number, label }]);
      }

      try {
        return await orig(input, init);
      } finally {
        setPending((p) => Math.max(0, p - 1));
        if (taskId !== null) setTasks((t) => t.filter((x) => x.id !== taskId));
      }
    };
    (wrapped as any).__arcreachWrapped = true;
    window.fetch = wrapped;
    return () => { window.fetch = orig; };
  }, [nextId]);

  // Linger briefly at zero so the bar completes its animation and rapid
  // back-to-back requests don't flicker it on/off.
  useEffect(() => {
    if (pending > 0) {
      setBusy(true);
      return;
    }
    const t = setTimeout(() => setBusy(false), 300);
    return () => clearTimeout(t);
  }, [pending]);

  // Collapse duplicate labels into one entry with a count.
  const grouped = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of tasks) map.set(t.label, (map.get(t.label) || 0) + 1);
    return Array.from(map.entries()).map(([label, count]) => ({ label, count }));
  }, [tasks]);

  const value = useMemo(() => ({ busy, tasks, startTask }), [busy, tasks, startTask]);

  return (
    <TaskContext.Provider value={value}>
      {/* Top progress bar — reflects all in-flight activity */}
      <Box sx={{ position: 'fixed', top: 0, left: 0, right: 0, height: 3, zIndex: 2000, pointerEvents: 'none' }}>
        <Fade in={busy} timeout={{ enter: 0, exit: 400 }}>
          <LinearProgress sx={{ height: 3, '& .MuiLinearProgress-bar': { transition: 'none' } }} />
        </Fade>
      </Box>

      {/* Background-task panel — labeled long-running operations */}
      <Box
        sx={{
          position: 'fixed', bottom: 16, left: { xs: 16, md: 272 }, zIndex: 1500,
          pointerEvents: 'none', display: 'flex', flexDirection: 'column', gap: 1, maxWidth: 280,
        }}
      >
        {grouped.map(({ label, count }) => (
          <Fade key={label} in timeout={200}>
            <Card sx={{ pointerEvents: 'auto', boxShadow: 4 }}>
              <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', px: 1.5, py: 1 }}>
                <CircularProgress size={14} thickness={5} />
                <Typography variant="caption" sx={{ fontWeight: 600 }} noWrap>
                  {label}{count > 1 ? ` (${count})` : ''}
                </Typography>
              </Stack>
            </Card>
          </Fade>
        ))}
      </Box>

      {children}
    </TaskContext.Provider>
  );
}
