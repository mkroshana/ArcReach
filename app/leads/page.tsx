/* eslint-disable react-hooks/set-state-in-effect */
'use client';

import { 
  UploadCloud, 
  FileType, 
  CheckCircle2, 
  AlertCircle, 
  Search, 
  Download, 
  Globe, 
  Trash2, 
  Plus,
  X,
  RefreshCw,
  Eye,
  MousePointerClick,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Mail,
  MessageSquare,
  Clock,
  Calendar,
  Folder,
  Copy,
  Archive,
  FolderPlus,
  Ban,
  MailX,
  Hourglass,
  MailQuestionMark
} from 'lucide-react';
import { useState, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { TableSkeleton } from '@/components/Skeleton';
import { decodeMimeHeader } from '@/lib/mime';
import { emailBodyToText } from '@/lib/emailText';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import {
  toCsv,
  downloadCsv,
  decodeCsvBytes,
  readCsvTable,
  matchCsvColumns,
  csvColumnLabels,
  planCsvImport,
  CsvParseError,
  type CsvEncoding,
  type CsvColumnMapping,
  type CsvImportPlan
} from '@/lib/csv';
import { parseLeadEmail } from '@/lib/leadEmail';
import {
  LEAD_IMPORT_BATCH_SIZE,
  LEAD_IMPORT_OUTCOMES,
  emptyLeadImportCounts,
  describeLeadImport,
  type LeadImportTotals
} from '@/lib/leadImport';
import { SUPPRESSION_LABELS } from '@/lib/suppression';
import { DOMAIN_CHECK_BATCH_SIZE, type DomainCheckCounts } from '@/lib/domainCheck';
import { selectedInView, clampPage, groupMembers } from '@/lib/leadView';
import type { SuppressionReason } from '@prisma/client';

/** A lead's suppression-list entry, as /api/leads returns it on each lead. */
type SuppressionInfo = { reason: SuppressionReason; source: string; createdAt: string };

/** What recorded a suppression-list entry, in words. */
const SUPPRESSION_SOURCES: Record<string, string> = {
  'unsubscribe-link': 'unsubscribe link',
  'delivery-webhook': 'ACS delivery report',
  'send-engine': 'send failure',
  verification: 'verification',
  backfill: 'lead status before the list existed',
};

/** When and why an address went on the suppression list. */
function describeSuppression(entry: SuppressionInfo): string {
  const cause = SUPPRESSION_LABELS[entry.reason]?.cause ?? entry.reason;
  const source = SUPPRESSION_SOURCES[entry.source] ?? entry.source;
  return `On the suppression list since ${new Date(entry.createdAt).toLocaleDateString()} because ${cause} (${source}).`;
}

/**
 * The lead's Unsubscribed, Bounced or Invalid chip label, or null. The
 * suppression list decides it, whatever the lead's CRM status says; a Bounced
 * or Unsubscribed status with no list entry still shows.
 */
function suppressionLabel(lead: any): string | null {
  if (lead.suppression) return SUPPRESSION_LABELS[lead.suppression.reason as SuppressionReason]?.chip ?? 'Suppressed';
  return lead.status === 'Bounced' || lead.status === 'Unsubscribed' ? lead.status : null;
}

function SuppressionChip({ lead }: { lead: any }) {
  const label = suppressionLabel(lead);
  const title = lead.suppression ? describeSuppression(lead.suppression) : undefined;
  if (label === 'Bounced') {
    return (
      <span title={title} className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-[10px] font-bold border uppercase tracking-wider bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400 border-red-200 dark:border-red-900/30">
        <Ban className="w-3.5 h-3.5" />
        Bounced
      </span>
    );
  }
  if (label === 'Unsubscribed') {
    return (
      <span title={title} className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-[10px] font-bold border uppercase tracking-wider bg-orange-50 dark:bg-orange-950/30 text-orange-700 dark:text-orange-400 border-orange-200 dark:border-orange-900/30">
        <MailX className="w-3.5 h-3.5" />
        Unsubscribed
      </span>
    );
  }
  if (label) {
    return (
      <span title={title} className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-[10px] font-bold border uppercase tracking-wider bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-900/30">
        <AlertCircle className="w-3.5 h-3.5" />
        {label}
      </span>
    );
  }
  return <span className="text-[10px] text-slate-400 dark:text-slate-500">Active</span>;
}

/** What a Re-activate did, for its toast. */
function describeReactivation(result: { reactivated: number; unsubscribed: number; suppressed: number; notSuppressed: number }): string {
  const leadCount = (n: number) => `${n} ${n === 1 ? 'lead' : 'leads'}`;
  const done = result.reactivated > 0
    ? `${leadCount(result.reactivated)} moved back to Unverified. Run Check Domain MX to check ${result.reactivated === 1 ? 'it' : 'them'} again.`
    : 'No leads were re-activated.';
  const skipped = [
    result.unsubscribed > 0 ? `${result.unsubscribed} unsubscribed` : '',
    result.suppressed > 0 ? `${result.suppressed} still on the suppression list` : '',
    result.notSuppressed > 0 ? `${result.notSuppressed} not suppressed` : '',
  ].filter(Boolean);
  return skipped.length > 0 ? `${done} Skipped ${skipped.join(', ')}.` : done;
}

/** What a domain MX check found, by validation status, for its toast. */
function describeDomainCheck(counts: DomainCheckCounts): string {
  const found = [
    counts.valid > 0 ? `${counts.valid} Valid (the domain has MX records, or an A record in their place; mailboxes are not checked)` : '',
    counts.risky > 0 ? `${counts.risky} Risky (the DNS lookup failed or found no MX or A record; run the check again to retry them)` : '',
    counts.invalid > 0 ? `${counts.invalid} Invalid (the domain does not exist or the address is malformed)` : '',
  ].filter(Boolean);
  return found.length > 0 ? `${found.join(', ')}.` : 'No leads were checked.';
}

/** Invalid emails the CSV mapping step quotes; any beyond this are only counted. */
const MAX_QUOTED_EMAILS = 3;
/** Longest invalid email cell the mapping step quotes in full. */
const MAX_QUOTED_EMAIL_LENGTH = 60;

/** The rows a CSV import will skip before sending anything, or '' when it skips none. */
function describeCsvSkips(plan: CsvImportPlan): string {
  const rows = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const quoted = plan.invalid.slice(0, MAX_QUOTED_EMAILS).map(value =>
    `"${value.length > MAX_QUOTED_EMAIL_LENGTH ? `${value.slice(0, MAX_QUOTED_EMAIL_LENGTH - 3)}...` : value}"`);
  const more = plan.invalid.length - quoted.length;
  const parts = [
    plan.invalid.length > 0
      ? `${rows(plan.invalid.length, 'row has', 'rows have')} an email that is not one valid address (${quoted.join(', ')}${more > 0 ? ` and ${more} more` : ''})`
      : '',
    plan.blank > 0 ? `${rows(plan.blank, 'row has', 'rows have')} no email` : '',
    plan.duplicate > 0 ? `${rows(plan.duplicate, 'row repeats', 'rows repeat')} an earlier row's address` : '',
  ].filter(Boolean);
  return parts.length > 0 ? `${parts.join(', ')}.` : '';
}

export default function LeadsPage() {
  const [leads, setLeads] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const { toast: showToast } = useToast();
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    onConfirm: () => void;
    isDestructive?: boolean;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // Search and Filter states
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('All');
  const [currentPage, setCurrentPage] = useState(1);
  
  // Domain MX check progress: leads checked so far, by result, out of the leads sent
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyProgress, setVerifyProgress] = useState<DomainCheckCounts & { checked: number; total: number } | null>(null);

  // New Lead form state
  const [showAddLead, setShowAddLead] = useState(false);
  const [newLead, setNewLead] = useState({ name: '', email: '', company: '', jobTitle: '' });

  // Outbox email timeline states
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [leadDetails, setLeadDetails] = useState<any | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [expandedEmailId, setExpandedEmailId] = useState<string | null>(null);

  // Lead Groups and Archiving states
  const [activeTab, setActiveTab] = useState<'leads' | 'groups' | 'overlaps' | 'archived' | 'suppressed'>('leads');
  const [groups, setGroups] = useState<any[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [newGroup, setNewGroup] = useState({ name: '', description: '' });
  
  const [selectedGroupForImport, setSelectedGroupForImport] = useState('');
  const [newGroupNameForImport, setNewGroupNameForImport] = useState('');
  const [selectedGroupForAdd, setSelectedGroupForAdd] = useState('');
  const [selectedGroupIdForView, setSelectedGroupIdForView] = useState<string | null>(null);
  const [selectedGroupsForCrossCheck, setSelectedGroupsForCrossCheck] = useState<string[]>([]);

  // CSV Column Mapping states
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<string[][]>([]);
  const [csvFileName, setCsvFileName] = useState<string>('');
  const [csvEncoding, setCsvEncoding] = useState<CsvEncoding>('utf-8');
  const [csvUnreadableRows, setCsvUnreadableRows] = useState<number>(0);
  const [showMapping, setShowMapping] = useState<boolean>(false);
  // Column index for each field, -1 when unmapped (headers can repeat or be blank)
  const [mappings, setMappings] = useState<CsvColumnMapping>({
    email: -1,
    name: -1,
    company: -1,
    jobTitle: -1
  });
  const [importProgress, setImportProgress] = useState<string>('');
  // What the last import did when part of it failed; the file stays loaded so it can be imported again
  const [importFailure, setImportFailure] = useState<string | null>(null);
  // The rows the import will send and skip under the current Email mapping
  const csvPlan = useMemo(() => planCsvImport(csvRows, mappings), [csvRows, mappings]);

  // Bulk Actions & disposal states
  const [selectedLeadIds, setSelectedLeadIds] = useState<string[]>([]);
  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState<boolean>(false);
  const [deleteAllConfirmText, setDeleteAllConfirmText] = useState<string>('');
  const [groupToDelete, setGroupToDelete] = useState<any | null>(null);
  const [leadDisposalAction, setLeadDisposalAction] = useState<'KEEP' | 'DELETE' | 'MOVE'>('KEEP');
  const [disposalTargetGroupId, setDisposalTargetGroupId] = useState<string>('');
  // Lead deletion is admin-only on the server; its controls stay hidden until the session says ADMIN.
  const [isAdmin, setIsAdmin] = useState(false);

  const fetchLeadDetails = async (id: string) => {
    try {
      setLoadingDetails(true);
      setExpandedEmailId(null);
      const res = await fetch(`/api/leads?id=${id}`);
      if (res.ok) {
        const data = await res.json();
        setLeadDetails(data);
      }
    } catch (err) {
      console.error('Failed to load lead details:', err);
    } finally {
      setLoadingDetails(false);
    }
  };

  const getTimeline = () => {
    if (!leadDetails) return [];
    
    const dispatches = (leadDetails.dispatches || []).map((d: any) => ({
      id: d.id,
      type: 'dispatch',
      date: new Date(d.sentAt),
      subject: d.subject || 'No Subject',
      body: d.body || '',
      // Only sequence sends carry a stepOrder, so a step with no campaign means the campaign was deleted.
      campaign: d.campaign?.name || (d.stepOrder ? 'Deleted Campaign' : 'Manual Outreach'),
      events: d.events || [],
      status: d.status,
      deliveredAt: d.deliveredAt,
      stepOrder: d.stepOrder
    }));

    const replies = (leadDetails.replies || []).map((r: any) => ({
      id: r.id,
      type: 'reply',
      date: new Date(r.receivedAt),
      subject: decodeMimeHeader(r.subject) || 'Re: Outreach',
      body: r.body || '',
      campaign: r.campaign?.name || 'Manual Outreach',
      events: []
    }));

    return [...dispatches, ...replies].sort((a, b) => b.date.getTime() - a.date.getTime());
  };



  const fetchGroups = async () => {
    try {
      setLoadingGroups(true);
      const res = await fetch('/api/leads/groups');
      if (res.ok) {
        const data = await res.json();
        setGroups(data);
      }
    } catch (err) {
      console.error('Failed to load groups:', err);
    } finally {
      setLoadingGroups(false);
    }
  };

  const fetchLeads = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/leads');
      if (res.ok) {
        const data = await res.json();
        setLeads(data);
      }
    } catch (error) {
      console.error('Failed to load leads:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLeads();
    fetchGroups();
    fetch('/api/session')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setIsAdmin(data?.role === 'ADMIN'))
      .catch(() => {});
  }, []);

  const handleBulkVerify = async () => {
    if (isVerifying) return;
    
    const targets = selectedLeads.length > 0
      ? selectedLeads.filter(l => l.validationStatus === 'Unverified' || l.validationStatus === 'Risky')
      : leads.filter(l => l.validationStatus === 'Unverified' || l.validationStatus === 'Risky');

    if (targets.length === 0) {
      showToast(selectedLeads.length > 0 ? 'None of the selected leads is Unverified or Risky.' : 'No leads are Unverified or Risky.');
      return;
    }

    // One request per batch, one after another, so each stays well inside the request timeout
    const ids = targets.map(l => l.id);
    const progress = { checked: 0, total: ids.length, valid: 0, risky: 0, invalid: 0 };
    setIsVerifying(true);
    setVerifyProgress({ ...progress });
    let failure: string | null = null;

    try {
      for (let i = 0; i < ids.length; i += DOMAIN_CHECK_BATCH_SIZE) {
        const res = await fetch('/api/leads/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: ids.slice(i, i + DOMAIN_CHECK_BATCH_SIZE) })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          failure = data.error || `the server answered ${res.status}`;
          break;
        }
        progress.checked += data.checked;
        progress.valid += data.counts.valid;
        progress.risky += data.counts.risky;
        progress.invalid += data.counts.invalid;
        setVerifyProgress({ ...progress });
      }
    } catch (err) {
      failure = 'the request failed';
      console.error(err);
    } finally {
      setIsVerifying(false);
      setVerifyProgress(null);
    }

    if (failure) {
      showToast(`Domain MX check stopped after ${progress.checked} of ${progress.total} leads because ${failure}. ${describeDomainCheck(progress)}`, 'error');
    } else {
      showToast(`Domain MX check finished for ${progress.checked} of ${progress.total} leads: ${describeDomainCheck(progress)}`, progress.risky > 0 ? 'warning' : 'success');
    }
    if (progress.checked > 0) await fetchLeads();
  };

  const handleDeleteLead = (id: string) => {
    setConfirmDialog({
      isOpen: true,
      title: 'Delete Lead',
      message: 'Are you sure you want to delete this lead? This action cannot be undone.',
      confirmLabel: 'Delete',
      isDestructive: true,
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          const res = await fetch(`/api/leads?id=${id}`, {
            method: 'DELETE'
          });
          if (res.ok) {
            setLeads(leads.filter(l => l.id !== id));
            showToast('Lead record deleted successfully.');
          } else {
            showToast('Failed to delete lead.');
          }
        } catch (error) {
          showToast('Error occurred deleting lead.');
          console.error(error);
        }
      }
    });
  };

  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newGroup.name.trim()) return;
    try {
      const res = await fetch('/api/leads/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newGroup.name.trim(), description: newGroup.description })
      });
      if (res.ok) {
        const created = await res.json();
        setGroups([...groups, { ...created, _count: { leads: 0 } }]);
        setNewGroup({ name: '', description: '' });
        setShowCreateGroup(false);
        showToast('Lead group created successfully.');
      } else {
        const err = await res.json();
        showToast(err.error || 'Failed to create group.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error creating group.');
    }
  };

  const handleDeleteGroup = (group: any) => {
    setGroupToDelete(group);
    setLeadDisposalAction('KEEP');
    setDisposalTargetGroupId('');
  };

  const handleExecuteDeleteGroup = async () => {
    if (!groupToDelete) return;
    
    if (leadDisposalAction === 'MOVE' && !disposalTargetGroupId) {
      showToast('Please select a target group to move prospects to.');
      return;
    }

    try {
      let url = `/api/leads/groups?id=${groupToDelete.id}&leadAction=${leadDisposalAction}`;
      if (leadDisposalAction === 'MOVE') {
        url += `&targetGroupId=${disposalTargetGroupId}`;
      }

      const res = await fetch(url, {
        method: 'DELETE'
      });

      if (res.ok) {
        // Reflect deletion locally
        setGroups(groups.filter(g => g.id !== groupToDelete.id));

        if (leadDisposalAction === 'DELETE') {
          // Find leads associated with this group
          const leadsToDelete = leads
            .filter(l => (l.groups || []).some((g: any) => g.groupId === groupToDelete.id))
            .map(l => l.id);
          setLeads(leads.filter(l => !leadsToDelete.includes(l.id)));
        } else if (leadDisposalAction === 'MOVE') {
          // Update local leads' memberships
          const updatedLeads = leads.map(l => {
            const hasMembership = (l.groups || []).some((g: any) => g.groupId === groupToDelete.id);
            if (hasMembership) {
              const targetGroup = groups.find(g => g.id === disposalTargetGroupId);
              const otherMemberships = (l.groups || []).filter((g: any) => g.groupId !== groupToDelete.id);
              const alreadyHasTarget = otherMemberships.some((g: any) => g.groupId === disposalTargetGroupId);
              
              if (!alreadyHasTarget && targetGroup) {
                otherMemberships.push({
                  groupId: disposalTargetGroupId,
                  group: { id: disposalTargetGroupId, name: targetGroup.name }
                });
              }
              return { ...l, groups: otherMemberships };
            }
            return l;
          });
          setLeads(updatedLeads);
        } else {
          // KEEP: just remove association
          const updatedLeads = leads.map(l => ({
            ...l,
            groups: (l.groups || []).filter((g: any) => g.groupId !== groupToDelete.id)
          }));
          setLeads(updatedLeads);
        }

        setGroupToDelete(null);
        setLeadDisposalAction('KEEP');
        setDisposalTargetGroupId('');
        await fetchGroups(); // refresh group counts
        showToast('Lead group deleted successfully.');
      } else {
        const err = await res.json();
        showToast(err.error || 'Failed to delete lead group.', 'error');
      }
    } catch (err) {
      console.error(err);
      showToast('Error deleting lead group.');
    }
  };

  const handleBulkDeleteLeads = () => {
    // Only the selected leads this tab, search and filter show, as counted in the bulk bar
    const ids = selectedLeads.map(l => l.id);
    if (ids.length === 0) return;
    setConfirmDialog({
      isOpen: true,
      title: 'Delete Selected Leads',
      message: `Are you sure you want to delete the ${ids.length} selected leads? This action cannot be undone.`,
      confirmLabel: 'Delete',
      isDestructive: true,
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          const res = await fetch('/api/leads', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids })
          });

          if (res.ok) {
            setLeads(leads.filter(l => !ids.includes(l.id)));
            setSelectedLeadIds([]);
            showToast('Selected leads deleted successfully.');
          } else {
            const err = await res.json().catch(() => ({}));
            showToast(err.error || 'Failed to delete selected leads.', 'error');
          }
        } catch (err) {
          console.error(err);
          showToast('Error deleting selected leads.');
        }
      }
    });
  };

  const handleBulkReactivateLeads = () => {
    const ids = selectedLeads.map(l => l.id);
    if (ids.length === 0) return;
    setConfirmDialog({
      isOpen: true,
      title: 'Re-activate Leads',
      message: `Re-activate the ${ids.length} selected leads? Bounced and invalid leads go back to Unverified so they can be verified again; ` +
        'none is set Valid and no campaign sequence is restarted. Unsubscribed leads are skipped, and so are addresses on the suppression list ' +
        'after a hard bounce or failed verification: only an admin can remove those, one at a time from the lead\'s details.',
      confirmLabel: 'Re-activate',
      isDestructive: false,
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          setLoading(true);
          const res = await fetch('/api/leads/reactivate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids })
          });

          if (res.ok) {
            const result = await res.json();
            setSelectedLeadIds([]);
            await fetchLeads();
            showToast(describeReactivation(result), result.reactivated > 0 ? 'success' : 'warning');
          } else {
            const err = await res.json().catch(() => ({}));
            showToast(err.error || 'Failed to re-activate selected leads.', 'error');
          }
        } catch (err) {
          console.error(err);
          showToast('Error re-activating selected leads.');
        } finally {
          setLoading(false);
        }
      }
    });
  };

  // Admin only, one address at a time, after showing why it was suppressed
  const handleRemoveSuppression = (lead: any) => {
    const entry: SuppressionInfo | null = lead.suppression;
    if (!entry) return;
    const optOut = entry.reason === 'Unsubscribed' || entry.reason === 'Complaint';
    setConfirmDialog({
      isOpen: true,
      title: 'Remove From Suppression List',
      message: `Remove ${lead.email} from the suppression list? ${describeSuppression(entry)} ` +
        (optOut
          ? 'The lead goes back to Neutral, and campaigns targeting it can enroll and email it again. Only do this if the recipient has asked to hear from you again.'
          : 'The lead goes back to Neutral and Unverified so it can be verified again, and campaigns targeting it can enroll and email it again.') +
        ' Paused and failed campaign sequences stay as they are.',
      confirmLabel: 'Remove',
      isDestructive: true,
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          const res = await fetch('/api/leads/suppression', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: lead.email })
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok) {
            if (data.lead) {
              setLeads(prev => prev.map(l => l.id === data.lead.id ? data.lead : l));
              setLeadDetails((prev: any) => prev && prev.id === data.lead.id ? { ...prev, ...data.lead } : prev);
            }
            showToast(`${lead.email} removed from the suppression list.`);
          } else {
            showToast(data.error || 'Failed to remove the address from the suppression list.', 'error');
          }
        } catch (err) {
          console.error(err);
          showToast('Error removing the address from the suppression list.', 'error');
        }
      }
    });
  };

  const handleBulkArchiveLeads = async (archiveState: boolean) => {
    const ids = selectedLeads.map(l => l.id);
    if (ids.length === 0) return;
    try {
      const res = await fetch('/api/leads', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, isArchived: archiveState })
      });

      if (res.ok) {
        const updatedLeads = leads.map(l => {
          if (ids.includes(l.id)) {
            return { ...l, isArchived: archiveState };
          }
          return l;
        });
        setLeads(updatedLeads);
        setSelectedLeadIds([]);
        showToast(archiveState ? 'Selected leads archived.' : 'Selected leads unarchived.');
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || 'Failed to update selected leads.', 'error');
      }
    } catch (err) {
      console.error(err);
      showToast('Error updating selected leads.');
    }
  };

  const handleDeleteAllLeads = async () => {
    if (deleteAllConfirmText !== 'DELETE') {
      showToast('Please type DELETE to confirm.');
      return;
    }
    try {
      const res = await fetch('/api/leads?all=true', {
        method: 'DELETE'
      });
      if (res.ok) {
        setLeads([]);
        setSelectedLeadIds([]);
        setShowDeleteAllConfirm(false);
        setDeleteAllConfirmText('');
        showToast('All CRM leads deleted successfully.');
      } else {
        showToast('Failed to wipe database.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error deleting all leads.');
    }
  };

  const handleArchiveGroupLeads = (groupId: string, archiveState: boolean) => {
    const groupName = groups.find(g => g.id === groupId)?.name || 'this group';
    setConfirmDialog({
      isOpen: true,
      title: archiveState ? 'Archive Group Leads' : 'Unarchive Group Leads',
      message: `Are you sure you want to ${archiveState ? 'archive' : 'unarchive'} all leads associated with ${groupName}?`,
      confirmLabel: archiveState ? 'Archive' : 'Unarchive',
      isDestructive: archiveState,
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          const res = await fetch('/api/leads', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupId, isArchived: archiveState })
          });

          if (res.ok) {
            // Find which lead IDs are members of this group
            const groupMemberships = leads
              .filter(l => (l.groups || []).some((g: any) => g.groupId === groupId))
              .map(l => l.id);
            
            const updatedLeads = leads.map(l => {
              if (groupMemberships.includes(l.id)) {
                return { ...l, isArchived: archiveState };
              }
              return l;
            });
            setLeads(updatedLeads);
            showToast(`All leads in group ${archiveState ? 'archived' : 'unarchived'} successfully.`);
          } else {
            showToast('Failed to archive group leads.');
          }
        } catch (err) {
          console.error(err);
          showToast('Error archiving group leads.');
        }
      }
    });
  };

  const handleRemoveFromGroup = async (leadId: string, groupId: string) => {
    try {
      const res = await fetch(`/api/leads/groups/memberships?groupId=${groupId}&leadId=${leadId}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        const updatedLeads = leads.map(l => {
          if (l.id === leadId) {
            return {
              ...l,
              groups: (l.groups || []).filter((g: any) => g.groupId !== groupId)
            };
          }
          return l;
        });
        setLeads(updatedLeads);
        await fetchGroups();
        showToast('Lead removed from group.');
      } else {
        showToast('Failed to remove lead from group.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error removing lead from group.');
    }
  };

  const handleAddCustomLead = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLead.email) return;
    // The Name input's required check lets a name of only spaces through
    if (!newLead.name.trim()) {
      showToast('Name is required.', 'error');
      return;
    }
    // The server makes the same check; the browser's email input lets some malformed addresses through
    if (!parseLeadEmail(newLead.email)) {
      showToast('Enter one valid email address, like name@example.com.', 'error');
      return;
    }

    try {
      // A blank company or job title is stored empty, so templates use their own fallback for it
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newLead.name.trim(),
          email: newLead.email,
          company: newLead.company.trim() || null,
          jobTitle: newLead.jobTitle.trim() || null,
          status: 'Neutral',
          validationStatus: 'Unverified',
          groupIds: selectedGroupForAdd ? [selectedGroupForAdd] : []
        })
      });

      if (res.ok) {
        const created = await res.json();
        setLeads([created, ...leads]);
        setNewLead({ name: '', email: '', company: '', jobTitle: '' });
        setSelectedGroupForAdd('');
        setShowAddLead(false);
        await fetchGroups(); // refresh groups for counts
        if (created.suppression) {
          showToast('Prospect added to CRM. Its address is on the suppression list, so it will not be emailed.', 'warning');
        } else {
          showToast('Prospect added to CRM.');
        }
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || 'Failed to create lead.', 'error');
      }
    } catch (error) {
      showToast('Error saving lead.');
      console.error(error);
    }
  };

  const handleExportCSV = () => {
    const exportLeads = selectedLeads.length > 0 ? selectedLeads : filteredLeads;

    if (exportLeads.length === 0) {
      showToast('No leads to export.');
      return;
    }

    const columns = [
      { key: 'name', label: 'Name' },
      { key: 'email', label: 'Email' },
      { key: 'company', label: 'Company' },
      { key: 'jobTitle', label: 'Job Title' },
      { key: 'status', label: 'Status' },
      { key: 'validationStatus', label: 'Validation Status' },
      { key: 'groups', label: 'Groups' },
      { key: 'createdAt', label: 'Created At' }
    ];

    const rows = exportLeads.map(lead => ({
      name: lead.name || '',
      email: lead.email,
      company: lead.company || '',
      jobTitle: lead.jobTitle || '',
      status: lead.status,
      validationStatus: lead.validationStatus,
      groups: (lead.groups || []).map((g: any) => g.group?.name).filter(Boolean).join(';'),
      createdAt: lead.createdAt || ''
    }));

    const csvContent = toCsv(rows, columns);
    const dateStr = new Date().toISOString().split('T')[0];
    downloadCsv(`leads-${dateStr}.csv`, csvContent);
    showToast(`Successfully exported ${exportLeads.length} leads to CSV.`);
  };

  const processCSVFile = async (file: File) => {
    try {
      // UTF-8 when the bytes are valid UTF-8, else windows-1252 (Excel's "CSV (Comma delimited)")
      const { text, encoding } = decodeCsvBytes(new Uint8Array(await file.arrayBuffer()));
      const { headers, rows } = readCsvTable(text);
      if (rows.length === 0) {
        showToast('Invalid CSV format. Header row and data required.');
        return;
      }

      setCsvHeaders(headers);
      setCsvRows(rows);
      setCsvFileName(file.name);
      setCsvEncoding(encoding);
      setCsvUnreadableRows(rows.filter(row => row.some(cell => cell.includes('\uFFFD'))).length);
      setMappings(matchCsvColumns(headers));
      setImportFailure(null);
      setShowMapping(true);
      showToast('CSV parsed. Please map your columns.');
    } catch (err) {
      showToast(err instanceof CsvParseError ? `Could not read the CSV file: ${err.message}.` : 'Error parsing CSV file.', 'error');
      console.error(err);
    }
  };

  const csvColumnOptions = csvColumnLabels(csvHeaders);
  const toColumnIndex = (value: string) => (value === '' ? -1 : Number(value));

  const handleExecuteImport = async () => {
    if (mappings.email === -1) {
      showToast('You must select a column for the Email field.');
      return;
    }

    // Rows with no email, one that is not a valid address or an address an earlier row has are never sent
    const plan = csvPlan;
    if (plan.leads.length === 0) {
      showToast(`Nothing to import: ${describeCsvSkips(plan)}`, 'error');
      return;
    }

    setLoading(true);
    setImportFailure(null);

    // A group that cannot be created stops the import, so no lead is imported without the group asked for
    let targetGroupId = selectedGroupForImport;
    const newGroupName = newGroupNameForImport.trim();
    if (newGroupName) {
      setImportProgress('Creating group...');
      let groupError: string | null = null;
      try {
        const groupRes = await fetch('/api/leads/groups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newGroupName })
        });
        if (groupRes.ok) {
          const newG = await groupRes.json();
          targetGroupId = newG.id;
          // Picked from the list from now on, so importing again uses this group instead of creating it twice
          setSelectedGroupForImport(newG.id);
          setNewGroupNameForImport('');
          await fetchGroups();
        } else {
          const err = await groupRes.json().catch(() => ({}));
          groupError = err.error || `The server answered ${groupRes.status}.`;
        }
      } catch (err) {
        console.error('Failed to create group during CSV import:', err);
        groupError = 'The request failed.';
      }
      if (groupError) {
        showToast(`Could not create the group "${newGroupName}": ${groupError} Nothing was imported.`, 'error');
        setImportProgress('');
        setLoading(false);
        return;
      }
    }

    const groupIds = targetGroupId ? [targetGroupId] : [];

    // Every row lands in exactly one count: the server's outcome for the rows it took, else skipped here or failed
    const totals: LeadImportTotals = {
      ...emptyLeadImportCounts(),
      invalid: plan.invalid.length,
      duplicate: plan.duplicate,
      blank: plan.blank,
      failed: 0
    };
    let firstFailure: string | undefined;

    for (let i = 0; i < plan.leads.length; i += LEAD_IMPORT_BATCH_SIZE) {
      const batch = plan.leads.slice(i, i + LEAD_IMPORT_BATCH_SIZE);
      setImportProgress(`Importing leads ${i + 1} to ${i + batch.length} of ${plan.leads.length}...`);

      let failure: string | null = null;
      try {
        const res = await fetch('/api/leads/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ leads: batch, groupIds })
        });

        if (res.ok) {
          const result = await res.json();
          for (const outcome of LEAD_IMPORT_OUTCOMES) totals[outcome] += result.counts?.[outcome] || 0;
        } else {
          const err = await res.json().catch(() => ({}));
          failure = err.error || `the server answered ${res.status}`;
        }
      } catch (err) {
        console.error(`Error importing batch starting at index ${i}:`, err);
        failure = 'the request failed';
      }
      // The server imports a batch in one transaction, so a batch it answered with an error imported none of its rows
      if (failure) {
        totals.failed += batch.length;
        firstFailure ??= failure;
      }
    }

    const summary = describeLeadImport(totals, firstFailure, groupIds.length > 0);
    if (totals.failed > 0) {
      // Keep the file and mapping so the import can be run again; rows imported this time come back as already in the CRM
      setImportFailure(summary);
    } else {
      setSelectedGroupForImport('');
      setNewGroupNameForImport('');
      setCsvHeaders([]);
      setCsvRows([]);
      setCsvFileName('');
      setShowMapping(false);
    }
    setImportProgress('');

    await fetchGroups(); // refresh group counts
    const added = totals.created + totals.suppressed;
    const skipped = totals.suppressed + totals.invalid + totals.blank + totals.duplicate > 0;
    showToast(summary, totals.failed > 0 ? 'error' : skipped || added === 0 ? 'warning' : 'success');
    fetchLeads();
  };

  const handleCancelImport = () => {
    setImportFailure(null);
    setCsvHeaders([]);
    setCsvRows([]);
    setCsvFileName('');
    setShowMapping(false);
    setSelectedGroupForImport('');
    setNewGroupNameForImport('');
  };

  const handleDropUpload = async (e: any) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      await processCSVFile(files[0]);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      await processCSVFile(files[0]);
    }
  };

  const getOverlappingLeads = () => {
    return leads.filter(lead => {
      if (lead.isArchived) return false;
      const memberGroupIds = (lead.groups || []).map((g: any) => g.groupId);
      if (selectedGroupsForCrossCheck.length > 0) {
        const intersection = memberGroupIds.filter((id: string) => selectedGroupsForCrossCheck.includes(id));
        return intersection.length > 1;
      } else {
        return memberGroupIds.length > 1;
      }
    });
  };

  const filteredLeads = leads.filter(lead => {
    if (activeTab === 'archived') {
      if (!lead.isArchived) return false;
    } else {
      if (lead.isArchived) return false;
    }

    if (activeTab === 'suppressed') {
      const isSuppressed = !!lead.suppression || lead.status === 'Bounced' || lead.status === 'Unsubscribed' || lead.validationStatus === 'Invalid';
      if (!isSuppressed) return false;
    }

    const nameStr = lead.name || '';
    const emailStr = lead.email || '';
    const companyStr = lead.company || '';
    const matchesSearch = nameStr.toLowerCase().includes(search.toLowerCase()) || 
                          emailStr.toLowerCase().includes(search.toLowerCase()) ||
                          companyStr.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = filterStatus === 'All' 
      || (filterStatus === 'Bounced' && suppressionLabel(lead) === 'Bounced')
      || (filterStatus === 'Unsubscribed' && suppressionLabel(lead) === 'Unsubscribed')
      || (!['Bounced', 'Unsubscribed'].includes(filterStatus) && lead.validationStatus === filterStatus);
    return matchesSearch && matchesStatus;
  });

  // Bulk actions, the bulk bar and Export reach only the selected leads this tab, search and filter show;
  // the other tabs have no checkboxes, so nothing is selected there
  const selectedLeads = activeTab === 'leads' || activeTab === 'archived' || activeTab === 'suppressed'
    ? selectedInView(filteredLeads, selectedLeadIds)
    : [];

  // The group drill-down lists members by membership, whatever the Leads tab's search and status filter say
  const viewedGroupMembers = selectedGroupIdForView ? groupMembers(leads, selectedGroupIdForView) : [];

  useEffect(() => {
    setCurrentPage(1);
  }, [search, filterStatus, activeTab, selectedGroupIdForView]);

  const itemsPerPage = 10;
  const totalPages = Math.ceil(filteredLeads.length / itemsPerPage);

  // A delete or archive that empties the last page moves back to the new last page
  useEffect(() => {
    setCurrentPage(page => clampPage(page, totalPages));
  }, [totalPages]);

  const paginatedLeads = filteredLeads.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);
  const totalLeads = filteredLeads.length;
  const startIndex = totalLeads === 0 ? 0 : (currentPage - 1) * itemsPerPage + 1;
  const endIndex = Math.min(currentPage * itemsPerPage, totalLeads);

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-5xl mx-auto">
      {/* Header */}
      <header className="flex justify-between items-start md:items-center flex-col md:flex-row gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white mb-0.5">Leads Directory</h1>
          <p className="text-slate-500 dark:text-slate-400 text-xs">Import contacts, check their email domains for mail servers, and organize your prospect lists.</p>
        </div>
        <div className="flex gap-2.5">
          <button 
            onClick={fetchLeads}
            className="p-2 text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xs"
            title="Refresh Leads Catalog"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading && !isVerifying ? 'animate-spin' : ''}`} />
          </button>
          <button 
            onClick={() => setShowAddLead(!showAddLead)}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-800 dark:text-white px-3.5 py-1.8 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-xs"
          >
            <Plus className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
            Add Single Lead
          </button>
          
          <button 
            onClick={handleBulkVerify}
            disabled={isVerifying || loading}
            className="bg-blue-600 hover:bg-blue-500 disabled:bg-blue-700 text-white px-4 py-2 rounded-lg font-semibold flex items-center gap-2 transition-colors text-xs shadow-sm"
          >
            <Globe className="w-3.5 h-3.5" />
            {isVerifying && verifyProgress ? `Checking ${verifyProgress.checked} of ${verifyProgress.total}` : 'Check Domain MX'}
          </button>
          
          {isAdmin && (
            <button
              onClick={() => {
                setDeleteAllConfirmText('');
                setShowDeleteAllConfirm(true);
              }}
              disabled={loading || leads.length === 0}
              className="bg-rose-600 hover:bg-rose-500 disabled:bg-rose-800/40 text-white px-3.5 py-1.8 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-sm cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete All Leads
            </button>
          )}
        </div>
      </header>

      {/* Domain MX check progress: real counts from the batches finished so far */}
      {isVerifying && verifyProgress && (
        <div className="bg-blue-50 dark:bg-blue-950/25 border border-blue-100 dark:border-blue-500/10 p-4 rounded-xl flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Globe className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
            <div>
              <p className="text-xs font-bold text-slate-800 dark:text-white uppercase tracking-wider">Checking Domain MX Records</p>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 font-medium">Looks up each email domain&apos;s MX records, or its A record when it has none. Mailboxes are not checked.</p>
            </div>
          </div>
          <div className="w-full md:w-64 font-sans text-[11px] font-bold space-y-1">
            <p className="text-blue-600 dark:text-blue-400">Checked {verifyProgress.checked} of {verifyProgress.total} leads</p>
            <p className="text-slate-500 dark:text-slate-400">{verifyProgress.valid} Valid, {verifyProgress.risky} Risky, {verifyProgress.invalid} Invalid</p>
          </div>
        </div>
      )}

      {/* Add Lead dialog */}
      {showAddLead && (
        <form onSubmit={handleAddCustomLead} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 rounded-xl space-y-4 animate-in slide-in-from-top-3 duration-200 shadow-xs">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-500 dark:text-slate-400">Add Lead Record</h3>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            <input 
              type="text" 
              placeholder="Name (e.g. John Doe) *"
              value={newLead.name}
              required
              onChange={e => setNewLead({...newLead, name: e.target.value})}
              className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 p-2.5 rounded-lg text-xs placeholder:text-slate-400 text-slate-800 dark:text-white outline-none focus:ring-2 focus:ring-blue-500/40"
            />
            <input 
              type="email" 
              placeholder="Outreach Email *"
              value={newLead.email}
              required
              onChange={e => setNewLead({...newLead, email: e.target.value})}
              className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 p-2.5 rounded-lg text-xs placeholder:text-slate-400 text-slate-800 dark:text-white outline-none focus:ring-2 focus:ring-blue-500/40"
            />
            <input 
              type="text" 
              placeholder="Brand Company Name"
              value={newLead.company}
              onChange={e => setNewLead({...newLead, company: e.target.value})}
              className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 p-2.5 rounded-lg text-xs placeholder:text-slate-400 text-slate-800 dark:text-white outline-none focus:ring-2 focus:ring-blue-500/40"
            />
            <input 
              type="text" 
              placeholder="Job Title (e.g. CEO)"
              value={newLead.jobTitle}
              onChange={e => setNewLead({...newLead, jobTitle: e.target.value})}
              className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 p-2.5 rounded-lg text-xs placeholder:text-slate-400 text-slate-800 dark:text-white outline-none focus:ring-2 focus:ring-blue-500/40"
            />
            <select
              value={selectedGroupForAdd}
              onChange={e => setSelectedGroupForAdd(e.target.value)}
              className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 p-2.5 rounded-lg text-xs text-slate-800 dark:text-white outline-none focus:ring-2 focus:ring-blue-500/40 cursor-pointer"
            >
              <option value="">-- No Group Assignment --</option>
              {groups.map(g => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-2 justify-end">
            <button 
              type="button" 
              onClick={() => setShowAddLead(false)}
              className="px-3.5 py-1.5 text-xs text-slate-400 hover:text-slate-900 dark:hover:text-white font-medium"
            >
              Cancel
            </button>
            <button 
              type="submit" 
              className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-1.8 rounded-lg text-xs font-semibold"
            >
              Save Record
            </button>
          </div>
        </form>
      )}

      {/* CSV Import container */}
      <input 
        type="file" 
        ref={fileInputRef} 
        onChange={handleFileChange} 
        accept=".csv" 
        className="hidden" 
      />
      {showMapping ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 rounded-xl space-y-6 animate-in slide-in-from-top-3 duration-250 shadow-xs">
          <div className="flex justify-between items-start border-b border-slate-100 dark:border-slate-800/80 pb-4">
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white uppercase tracking-wider flex items-center gap-2">
                <FileType className="w-4.5 h-4.5 text-blue-600 dark:text-blue-400" />
                Map CSV Columns — {csvFileName}
              </h3>
              <p className="text-slate-500 dark:text-slate-400 text-xs mt-1 font-medium">
                {csvRows.length} prospects found. Match your CSV header columns to the corresponding CRM prospect fields.
              </p>
              {csvEncoding !== 'utf-8' && (
                <p className="text-slate-500 dark:text-slate-400 text-xs mt-1 font-medium">
                  {csvEncoding === 'windows-1252'
                    ? 'Read as Windows-1252 because the file is not UTF-8.'
                    : 'Read as UTF-16.'}{' '}
                  Check that accented names look right in the previews.
                </p>
              )}
              {csvUnreadableRows > 0 && (
                <p className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400 text-xs mt-1 font-medium">
                  <AlertCircle className="w-3.5 h-3.5 mt-px shrink-0" />
                  <span>
                    {csvUnreadableRows} {csvUnreadableRows === 1 ? 'row contains' : 'rows contain'} characters that could not be read (shown as {'\uFFFD'}).
                    They will be imported and emailed as shown, so fix them in the file and import it again.
                  </span>
                </p>
              )}
              {mappings.email !== -1 && describeCsvSkips(csvPlan) && (
                <p className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400 text-xs mt-1 font-medium">
                  <AlertCircle className="w-3.5 h-3.5 mt-px shrink-0" />
                  <span>{describeCsvSkips(csvPlan)} These rows will be skipped.</span>
                </p>
              )}
              {importFailure && (
                <p className="flex items-start gap-1.5 text-rose-700 dark:text-rose-400 text-xs mt-1 font-medium">
                  <AlertCircle className="w-3.5 h-3.5 mt-px shrink-0" />
                  <span>{importFailure}</span>
                </p>
              )}
            </div>
            <button
              onClick={handleCancelImport}
              className="text-slate-400 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 p-1 rounded-lg"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-4">
              <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-slate-500">Field Matching</h4>
              
              {/* Email Mapping (Required) */}
              <div className="space-y-1.5">
                <label className="block text-xs font-bold text-slate-800 dark:text-slate-300">
                  Email Address <span className="text-rose-500">*</span>
                </label>
                <select
                  value={mappings.email === -1 ? '' : mappings.email}
                  onChange={e => setMappings({ ...mappings, email: toColumnIndex(e.target.value) })}
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-2.5 text-xs text-slate-800 dark:text-white cursor-pointer outline-none focus:ring-2 focus:ring-blue-500/40"
                >
                  <option value="" disabled>-- Select Column --</option>
                  {csvColumnOptions.map((label, i) => (
                    <option key={i} value={i}>{label}</option>
                  ))}
                </select>
                {mappings.email !== -1 && csvRows.length > 0 && (
                  <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200/50 dark:border-slate-800/40 mt-1">
                    Preview: {csvRows[0][mappings.email] || <em className="text-slate-400">Empty</em>}
                  </div>
                )}
              </div>

              {/* Name Mapping (Optional) */}
              <div className="space-y-1.5">
                <label className="block text-xs font-bold text-slate-800 dark:text-slate-300">
                  Full Name
                </label>
                <select
                  value={mappings.name === -1 ? '' : mappings.name}
                  onChange={e => setMappings({ ...mappings, name: toColumnIndex(e.target.value) })}
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-2.5 text-xs text-slate-800 dark:text-white cursor-pointer outline-none focus:ring-2 focus:ring-blue-500/40"
                >
                  <option value="">{"[Don't Map - Leave Empty]"}</option>
                  {csvColumnOptions.map((label, i) => (
                    <option key={i} value={i}>{label}</option>
                  ))}
                </select>
                {mappings.name !== -1 && csvRows.length > 0 && (
                  <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200/50 dark:border-slate-800/40 mt-1">
                    Preview: {csvRows[0][mappings.name] || <em className="text-slate-400">Empty</em>}
                  </div>
                )}
              </div>

              {/* Company Mapping (Optional) */}
              <div className="space-y-1.5">
                <label className="block text-xs font-bold text-slate-800 dark:text-slate-300">
                  Company Name
                </label>
                <select
                  value={mappings.company === -1 ? '' : mappings.company}
                  onChange={e => setMappings({ ...mappings, company: toColumnIndex(e.target.value) })}
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-2.5 text-xs text-slate-800 dark:text-white cursor-pointer outline-none focus:ring-2 focus:ring-blue-500/40"
                >
                  <option value="">{"[Don't Map - Leave Empty]"}</option>
                  {csvColumnOptions.map((label, i) => (
                    <option key={i} value={i}>{label}</option>
                  ))}
                </select>
                {mappings.company !== -1 && csvRows.length > 0 && (
                  <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200/50 dark:border-slate-800/40 mt-1">
                    Preview: {csvRows[0][mappings.company] || <em className="text-slate-400">Empty</em>}
                  </div>
                )}
              </div>

              {/* Job Title Mapping (Optional) */}
              <div className="space-y-1.5">
                <label className="block text-xs font-bold text-slate-800 dark:text-slate-300">
                  Job Title
                </label>
                <select
                  value={mappings.jobTitle === -1 ? '' : mappings.jobTitle}
                  onChange={e => setMappings({ ...mappings, jobTitle: toColumnIndex(e.target.value) })}
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-2.5 text-xs text-slate-800 dark:text-white cursor-pointer outline-none focus:ring-2 focus:ring-blue-500/40"
                >
                  <option value="">{"[Don't Map - Leave Empty]"}</option>
                  {csvColumnOptions.map((label, i) => (
                    <option key={i} value={i}>{label}</option>
                  ))}
                </select>
                {mappings.jobTitle !== -1 && csvRows.length > 0 && (
                  <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200/50 dark:border-slate-800/40 mt-1">
                    Preview: {csvRows[0][mappings.jobTitle] || <em className="text-slate-400">Empty</em>}
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-5 flex flex-col justify-between">
              <div className="space-y-4">
                <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-slate-500">Destination Settings</h4>
                <div className="space-y-3 bg-slate-50/50 dark:bg-[#12141c]/50 p-4 rounded-xl border border-slate-200/50 dark:border-slate-800/40">
                  <div>
                    <label className="block text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">Add Imported to Group</label>
                    <select
                      value={selectedGroupForImport}
                      onChange={e => {
                        setSelectedGroupForImport(e.target.value);
                        setNewGroupNameForImport('');
                      }}
                      className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-2 text-xs text-slate-800 dark:text-white cursor-pointer"
                    >
                      <option value="">-- No Group (General CRM) --</option>
                      {groups.map(g => (
                        <option key={g.id} value={g.id}>{g.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">Or Create New Group</label>
                    <input
                      type="text"
                      placeholder="e.g. Cold Leads June"
                      value={newGroupNameForImport}
                      onChange={e => {
                        setNewGroupNameForImport(e.target.value);
                        setSelectedGroupForImport('');
                      }}
                      className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-2 text-xs text-slate-800 dark:text-white placeholder:text-slate-400"
                    />
                  </div>
                </div>
              </div>

              <div className="flex gap-3 justify-end pt-4 border-t border-slate-100 dark:border-slate-800/60">
                <button
                  onClick={handleCancelImport}
                  disabled={loading}
                  className="px-4 py-2 text-xs text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white font-semibold transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleExecuteImport}
                  disabled={mappings.email === -1 || loading}
                  className="bg-blue-600 hover:bg-blue-500 disabled:bg-slate-200 dark:disabled:bg-slate-800 text-white disabled:text-slate-400 dark:disabled:text-slate-600 px-5 py-2 rounded-lg text-xs font-semibold shadow-sm transition-colors cursor-pointer flex items-center gap-2"
                >
                  {loading && <RefreshCw className="w-3 h-3 animate-spin" />}
                  {loading ? (importProgress || 'Importing...') : 'Confirm & Import'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div 
          className={`relative overflow-hidden rounded-xl border border-dashed transition-all duration-200 ${
            isDragging 
              ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/20' 
              : 'border-slate-400 dark:border-slate-800 bg-white dark:bg-slate-900 hover:bg-slate-50/50 dark:hover:bg-slate-800/45'
          } p-8 flex flex-col items-center justify-center cursor-pointer shadow-xs`}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDropUpload}
          onClick={() => fileInputRef.current?.click()}
        >
          <div className="w-10 h-10 mb-3 rounded-lg bg-slate-50 dark:bg-slate-950 flex items-center justify-center border border-slate-200 dark:border-slate-800">
            <UploadCloud className="w-4.5 h-4.5 text-blue-600 dark:text-blue-400" />
          </div>
          <h3 className="text-sm font-semibold text-slate-800 dark:text-white uppercase tracking-widest mb-1">Import bulk list CSV</h3>
          <p className="text-slate-500 dark:text-slate-400 text-center max-w-md text-xs mb-3 font-medium">
            Drag and drop contacts list, or click to select and import custom CSV spreadsheets.
          </p>
          <button className="bg-white dark:bg-slate-950 hover:bg-slate-50 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors shadow-xs mb-2">
            Browse Files (.csv)
          </button>

          <div className="mt-4 flex flex-col sm:flex-row gap-3 w-full max-w-md bg-slate-50/50 dark:bg-[#12141c]/50 p-4 rounded-xl border border-slate-200/50 dark:border-slate-800/40" onClick={(e) => e.stopPropagation()}>
            <div className="flex-1 col-span-1">
              <label className="block text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">Add Imported to Group</label>
              <select
                value={selectedGroupForImport}
                onChange={e => {
                  setSelectedGroupForImport(e.target.value);
                  setNewGroupNameForImport('');
                }}
                className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-2 text-xs text-slate-800 dark:text-white cursor-pointer"
              >
                <option value="">-- No Group (General CRM) --</option>
                {groups.map(g => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </div>
            <div className="flex-1 col-span-1">
              <label className="block text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">Or Create New Group</label>
              <input
                type="text"
                placeholder="e.g. Cold Leads June"
                value={newGroupNameForImport}
                onChange={e => {
                  setNewGroupNameForImport(e.target.value);
                  setSelectedGroupForImport('');
                }}
                className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-2 text-xs text-slate-800 dark:text-white placeholder:text-slate-400"
              />
            </div>
          </div>
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="flex border-b border-slate-200 dark:border-slate-800 gap-4 mt-2">
        {[
          { id: 'leads', name: 'Leads Directory', icon: FileType },
          { id: 'groups', name: 'Lead Groups', icon: Folder },
          { id: 'overlaps', name: 'Cross-Check & Overlaps', icon: Copy },
          { id: 'suppressed', name: 'Suppressed Leads', icon: MailX },
          { id: 'archived', name: 'Archived Leads', icon: Archive }
        ].map(tab => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => {
                setActiveTab(tab.id as any);
                setSelectedGroupIdForView(null);
                // Each tab has its own bulk actions, so a selection never carries over
                setSelectedLeadIds([]);
              }}
              className={`pb-3 text-xs font-bold uppercase tracking-wider border-b-2 flex items-center gap-2 transition-all cursor-pointer ${
                activeTab === tab.id
                  ? 'border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400'
                  : 'border-transparent text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-400'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {tab.name}
            </button>
          );
        })}
      </div>

      {/* Main CRM Board Area */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-xs mt-2 animate-in fade-in duration-300">
        
        {/* Render for LEADS, ARCHIVED or SUPPRESSED Tab */}
        {(activeTab === 'leads' || activeTab === 'archived' || activeTab === 'suppressed') && (
          <>
            {/* Table Filter Top Bar */}
            <div className="p-4 border-b border-slate-200 dark:border-slate-800/60 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-slate-50/50 dark:bg-slate-900/50">
              <div className="flex flex-col md:flex-row gap-2.5 w-full md:w-auto">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
                  <input 
                    type="text" 
                    placeholder="Search leads..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg pl-9 pr-4 py-1.8 text-xs text-slate-800 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 outline-none w-full md:w-52 focus:ring-2 focus:ring-blue-500/40 shadow-xs"
                  />
                </div>
                
                <div className="flex items-center gap-1 p-1 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xs">
                  {['All', 'Valid', 'Risky', 'Invalid', 'Unverified', 'Bounced', 'Unsubscribed'].map(statusOption => (
                    <button
                      key={statusOption}
                      onClick={() => setFilterStatus(statusOption)}
                      className={`px-3 py-1 rounded-md text-[10px] font-bold transition-all uppercase tracking-wider cursor-pointer ${
                        filterStatus === statusOption 
                          ? statusOption === 'Bounced' ? 'bg-red-600 text-white shadow-xs'
                          : statusOption === 'Unsubscribed' ? 'bg-orange-600 text-white shadow-xs'
                          : 'bg-blue-600 dark:bg-blue-600 text-white shadow-xs' 
                          : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                      }`}
                    >
                      {statusOption}
                    </button>
                  ))}
                </div>
              </div>
              
              <button 
                onClick={handleExportCSV}
                className="flex items-center gap-1.5 bg-white hover:bg-slate-50 dark:bg-slate-950 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800 text-xs px-3.5 py-2 rounded-lg font-bold text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors shadow-xs cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                {selectedLeads.length > 0 ? `Export selected (${selectedLeads.length})` : 'Export CSV'}
              </button>
            </div>

            {/* Lead Rows list */}
            {loading && !isVerifying ? (
              <div className="p-6">
                <TableSkeleton rows={7} cols={6} />
              </div>
            ) : (
              <>
                <div className="w-full overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800/80 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest bg-slate-50/20 dark:bg-slate-950/10">
                      <th className="px-5 py-3 w-10">
                        <input
                          type="checkbox"
                          checked={paginatedLeads.length > 0 && paginatedLeads.every(l => selectedLeadIds.includes(l.id))}
                          onChange={(e) => {
                            if (e.target.checked) {
                              const newSelections = Array.from(new Set([...selectedLeadIds, ...paginatedLeads.map(l => l.id)]));
                              setSelectedLeadIds(newSelections);
                            } else {
                              const paginatedIds = paginatedLeads.map(l => l.id);
                              setSelectedLeadIds(selectedLeadIds.filter(id => !paginatedIds.includes(id)));
                            }
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500/40 cursor-pointer"
                        />
                      </th>
                      <th className="px-5 py-3">Name</th>
                      <th className="px-5 py-3">Email</th>
                      <th className="px-5 py-3">Company</th>
                      <th className="px-5 py-3">Deliverability</th>
                      <th className="px-5 py-3">Lead Status</th>
                      {(activeTab === 'leads' || activeTab === 'suppressed') && <th className="px-5 py-3">Groups</th>}
                      <th className="px-5 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800/50 text-slate-700 dark:text-slate-400">
                    {paginatedLeads.map((lead) => (
                      <tr 
                        key={lead.id} 
                        onClick={() => {
                          setSelectedLeadId(lead.id);
                          fetchLeadDetails(lead.id);
                        }}
                        className={`hover:bg-slate-50/50 dark:hover:bg-slate-800/20 transition-all group cursor-pointer ${
                          selectedLeadIds.includes(lead.id) ? 'bg-blue-50/20 dark:bg-blue-950/10' : ''
                        }`}
                      >
                        <td className="px-5 py-3.5 w-10" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selectedLeadIds.includes(lead.id)}
                            onChange={() => {
                              if (selectedLeadIds.includes(lead.id)) {
                                setSelectedLeadIds(selectedLeadIds.filter(id => id !== lead.id));
                              } else {
                                setSelectedLeadIds([...selectedLeadIds, lead.id]);
                              }
                            }}
                            className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500/40 cursor-pointer"
                          />
                        </td>
                        <td className="px-5 py-3.5">
                          <div className="font-semibold text-xs text-slate-900 dark:text-white">{lead.name || 'N/A'}</div>
                          {lead.jobTitle && <div className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5 font-medium">{lead.jobTitle}</div>}
                        </td>
                        <td className="px-5 py-3.5 text-xs text-slate-500 dark:text-slate-400 font-mono flex items-center gap-2">
                          <FileType className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
                          {lead.email}
                        </td>
                        <td className="px-5 py-3.5 text-xs text-slate-600 dark:text-slate-400 font-medium">{lead.company || 'N/A'}</td>
                        <td className="px-5 py-3.5">
                          <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-[10px] font-bold border uppercase tracking-wider
                            ${lead.validationStatus === 'Valid' ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900/30' : ''}
                            ${lead.validationStatus === 'Invalid' ? 'bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-900/30' : ''}
                            ${lead.validationStatus === 'Risky' ? 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-900/30' : ''}
                            ${lead.validationStatus === 'Unverified' ? 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800' : ''}
                          `}>
                            {lead.validationStatus === 'Valid' && <CheckCircle2 className="w-3.5 h-3.5" />}
                            {lead.validationStatus === 'Invalid' && <AlertCircle className="w-3.5 h-3.5" />}
                            {lead.validationStatus === 'Risky' && <AlertCircle className="w-3.5 h-3.5" />}
                            {lead.validationStatus === 'Unverified' && <span className="w-1.5 h-1.5 rounded-full bg-slate-400 dark:bg-slate-500 animate-pulse"></span>}
                            {lead.validationStatus}
                          </span>
                        </td>
                        <td className="px-5 py-3.5">
                          <SuppressionChip lead={lead} />
                        </td>
                        {(activeTab === 'leads' || activeTab === 'suppressed') && (
                          <td className="px-5 py-3.5">
                            <div className="flex flex-wrap gap-1 max-w-[150px]">
                              {(lead.groups || []).map((g: any) => (
                                <span key={g.groupId} className="px-1.5 py-0.5 rounded text-[8px] font-bold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-800 uppercase tracking-wider">
                                  {g.group?.name}
                                </span>
                              ))}
                              {(!lead.groups || lead.groups.length === 0) && (
                                <span className="text-[10px] text-slate-400 dark:text-slate-500 italic">No Group</span>
                              )}
                            </div>
                          </td>
                        )}
                        <td className="px-5 py-3.5 text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1">
                            <button 
                              onClick={async (e) => {
                                e.stopPropagation();
                                try {
                                  const res = await fetch('/api/leads', {
                                    method: 'PUT',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ id: lead.id, isArchived: !lead.isArchived })
                                  });
                                  if (res.ok) {
                                    const updatedLead = await res.json();
                                    setLeads(leads.map(l => l.id === lead.id ? updatedLead : l));
                                    showToast(updatedLead.isArchived ? 'Prospect archived.' : 'Prospect unarchived.');
                                  }
                                } catch (err) {
                                  console.error(err);
                                }
                              }}
                              className={`p-1.5 rounded transition-colors ${
                                lead.isArchived 
                                  ? 'hover:bg-blue-500/10 text-blue-500' 
                                  : 'hover:bg-amber-500/10 text-slate-400 hover:text-amber-500'
                              }`}
                              title={lead.isArchived ? "Restore Prospect" : "Archive Prospect"}
                            >
                              <Archive className="w-3.5 h-3.5" />
                            </button>
                            {isAdmin && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDeleteLead(lead.id);
                                }}
                                className="p-1.5 hover:bg-rose-500/10 text-slate-400 hover:text-rose-600 rounded transition-colors"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {filteredLeads.length === 0 && (
                      <tr>
                        <td colSpan={(activeTab === 'leads' || activeTab === 'suppressed') ? 7 : 6} className="text-center py-10 text-slate-400 dark:text-slate-500 text-xs">
                          No lead records match your search filters.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination Controls */}
              {totalLeads > 0 && (
                <div className="px-5 py-4 border-t border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row justify-between items-center gap-4 bg-slate-50/20 dark:bg-slate-950/10">
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    Showing <span className="font-semibold text-slate-700 dark:text-white">{startIndex}</span> to{' '}
                    <span className="font-semibold text-slate-700 dark:text-white">{endIndex}</span> of{' '}
                    <span className="font-semibold text-slate-700 dark:text-white">{totalLeads}</span> leads
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      disabled={currentPage === 1}
                      onClick={() => setCurrentPage(1)}
                      className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
                      title="First Page"
                    >
                      <ChevronsLeft className="w-3.5 h-3.5" />
                    </button>
                    <button
                      disabled={currentPage === 1}
                      onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                      className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
                      title="Previous Page"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                    </button>
                    
                    {/* Page numbers */}
                    {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                      let pageNum = currentPage;
                      if (currentPage <= 3) {
                        pageNum = i + 1;
                      } else if (currentPage >= totalPages - 2) {
                        pageNum = totalPages - 4 + i;
                      } else {
                        pageNum = currentPage - 2 + i;
                      }
                      if (pageNum < 1 || pageNum > totalPages) return null;
                      return (
                        <button
                          key={pageNum}
                          onClick={() => setCurrentPage(pageNum)}
                          className={`px-3 py-1 rounded-md text-xs font-semibold border transition-all cursor-pointer ${
                            currentPage === pageNum
                              ? 'bg-blue-600 border-blue-600 text-white shadow-xs'
                              : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
                          }`}
                        >
                          {pageNum}
                        </button>
                      );
                    })}

                    <button
                      disabled={currentPage === totalPages}
                      onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                      className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
                      title="Next Page"
                    >
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                    <button
                      disabled={currentPage === totalPages}
                      onClick={() => setCurrentPage(totalPages)}
                      className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
                      title="Last Page"
                    >
                      <ChevronsRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
          </>
        )}

        {/* Render for LEAD GROUPS Tab */}
        {activeTab === 'groups' && (
          <div className="animate-in fade-in duration-300">
            {selectedGroupIdForView ? (
              /* Group Drill-down details */
              <div className="p-5 space-y-4">
                <div className="flex justify-between items-center bg-slate-50/50 dark:bg-[#12141e]/50 border border-slate-200 dark:border-slate-800 p-4 rounded-xl">
                  <div>
                    <h4 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider flex items-center gap-2">
                      <Folder className="w-4.5 h-4.5 text-blue-600 dark:text-blue-400" />
                      {groups.find(g => g.id === selectedGroupIdForView)?.name}
                    </h4>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 font-medium">
                      {groups.find(g => g.id === selectedGroupIdForView)?.description || 'No description provided.'}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleArchiveGroupLeads(selectedGroupIdForView!, true)}
                      className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-amber-500/10 hover:bg-amber-500/20 text-amber-700 dark:text-amber-500 transition-all cursor-pointer shadow-xs"
                    >
                      Archive All Leads
                    </button>
                    <button
                      onClick={() => setSelectedGroupIdForView(null)}
                      className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-white hover:bg-slate-50 dark:bg-slate-950 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 transition-all cursor-pointer shadow-xs"
                    >
                      Back to Groups list
                    </button>
                  </div>
                </div>

                <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-slate-800/80 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest bg-slate-50/20 dark:bg-slate-950/10">
                        <th className="px-5 py-3">Name</th>
                        <th className="px-5 py-3">Email</th>
                        <th className="px-5 py-3">Company</th>
                        <th className="px-5 py-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800/50 text-slate-700 dark:text-slate-300">
                      {viewedGroupMembers.map(lead => (
                        <tr 
                          key={lead.id} 
                          onClick={() => {
                            setSelectedLeadId(lead.id);
                            fetchLeadDetails(lead.id);
                          }}
                          className="hover:bg-slate-50/50 dark:hover:bg-slate-800/20 transition-all group cursor-pointer"
                        >
                          <td className="px-5 py-3.5">
                            <div className="font-semibold text-xs text-slate-900 dark:text-white">{lead.name || 'N/A'}</div>
                            {lead.jobTitle && <div className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5 font-medium">{lead.jobTitle}</div>}
                          </td>
                          <td className="px-5 py-3.5 text-xs text-slate-500 dark:text-slate-400 font-mono flex items-center gap-2">
                            <FileType className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
                            {lead.email}
                          </td>
                          <td className="px-5 py-3.5 text-xs text-slate-600 dark:text-slate-400 font-medium">{lead.company || 'N/A'}</td>
                          <td className="px-5 py-3.5 text-right" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                onClick={() => handleRemoveFromGroup(lead.id, selectedGroupIdForView)}
                                className="px-2 py-1 bg-amber-500/10 hover:bg-amber-500/20 text-amber-700 dark:text-amber-400 rounded text-[10px] font-bold uppercase tracking-wider transition-colors cursor-pointer"
                              >
                                Remove from group
                              </button>
                              {isAdmin && (
                                <button
                                  onClick={() => handleDeleteLead(lead.id)}
                                  className="p-1.5 hover:bg-rose-500/10 text-slate-400 hover:text-rose-600 rounded transition-colors"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                      {viewedGroupMembers.length === 0 && (
                        <tr>
                          <td colSpan={4} className="text-center py-10 text-slate-400 dark:text-slate-500 text-xs">
                            No active prospects associated with this group.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              /* Groups grid overview */
              <div className="p-5 space-y-4">
                <div className="flex justify-between items-center">
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-500 dark:text-slate-400">Manage Segments</h3>
                  <button
                    onClick={() => setShowCreateGroup(!showCreateGroup)}
                    className="bg-white hover:bg-slate-50 dark:bg-slate-950 dark:hover:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-800 dark:text-white px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-xs cursor-pointer"
                  >
                    <FolderPlus className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
                    Create Lead Group
                  </button>
                </div>

                {showCreateGroup && (
                  <form onSubmit={handleCreateGroup} className="bg-slate-50 dark:bg-[#12141e] border border-slate-200 dark:border-[#1e202d] p-4 rounded-xl space-y-4 animate-in slide-in-from-top-2 duration-200">
                    <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-slate-500">New Group Details</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">Group Name *</label>
                        <input
                          type="text"
                          required
                          placeholder="e.g. Q3 Outbound Outreach"
                          value={newGroup.name}
                          onChange={e => setNewGroup({ ...newGroup, name: e.target.value })}
                          className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-2 text-xs text-slate-800 dark:text-white placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-blue-500/40"
                        />
                      </div>
                      <div>
                        <label className="block text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">Description</label>
                        <input
                          type="text"
                          placeholder="e.g. Leads extracted from June marketing campaign"
                          value={newGroup.description}
                          onChange={e => setNewGroup({ ...newGroup, description: e.target.value })}
                          className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-2 text-xs text-slate-800 dark:text-white placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-blue-500/40"
                        />
                      </div>
                    </div>
                    <div className="flex gap-2 justify-end">
                      <button
                        type="button"
                        onClick={() => setShowCreateGroup(false)}
                        className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-900 dark:hover:text-white font-medium cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="bg-blue-600 hover:bg-blue-600 text-white px-4 py-1.5 rounded-lg text-xs font-semibold shadow-sm cursor-pointer"
                      >
                        Save Group
                      </button>
                    </div>
                  </form>
                )}

                {loadingGroups ? (
                  <div className="py-12 text-center text-slate-400 dark:text-slate-500 text-xs">
                    <div className="w-6 h-6 border-2 border-slate-300 dark:border-slate-700 border-t-blue-500 animate-spin rounded-full mx-auto mb-2" />
                    Syncing segments...
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {groups.map(group => (
                      <div key={group.id} className="bg-slate-50 dark:bg-[#12141e] border border-slate-200 dark:border-[#1e202d] rounded-xl p-4 flex flex-col justify-between hover:border-blue-500/50 transition-all shadow-xs">
                        <div>
                          <div className="flex justify-between items-start">
                            <h4 className="text-xs font-bold text-slate-800 dark:text-white uppercase tracking-wider">{group.name}</h4>
                            <span className="bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-500/10 text-blue-700 dark:text-blue-400 px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider">
                              {group._count?.leads || 0} leads
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-2 line-clamp-2 min-h-8">
                            {group.description || 'No description provided.'}
                          </p>
                        </div>
                        <div className="flex gap-2 justify-end mt-4 pt-3 border-t border-slate-200/60 dark:border-slate-800/40">
                          <button
                            onClick={() => setSelectedGroupIdForView(group.id)}
                            className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-white hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 transition-all cursor-pointer shadow-xs"
                          >
                            View Members
                          </button>
                          <button
                            onClick={() => handleArchiveGroupLeads(group.id, true)}
                            className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-amber-500/10 hover:bg-amber-500/20 text-amber-700 dark:text-amber-500 transition-all cursor-pointer"
                          >
                            Archive Leads
                          </button>
                          <button
                            onClick={() => handleDeleteGroup(group)}
                            className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 dark:text-rose-500 transition-all cursor-pointer"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                    {groups.length === 0 && (
                      <div className="col-span-full py-12 text-center text-slate-400 dark:text-slate-500 text-xs">
                        No segments created yet. Create a group to organize prospects.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Render for CROSS-CHECK / OVERLAPS Tab */}
        {activeTab === 'overlaps' && (
          <div className="p-5 space-y-5 animate-in fade-in duration-300">
            <div className="bg-slate-50/50 dark:bg-[#12141e]/50 border border-slate-200 dark:border-slate-800 p-4 rounded-xl space-y-3">
              <div>
                <h4 className="text-xs font-bold text-slate-800 dark:text-white uppercase tracking-wider">Cross-Check & Deduplication Filters</h4>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Select specific groups to check for overlapping leads. If no groups are selected, it compiles duplicates across all segments.</p>
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                {groups.map(group => {
                  const isSelected = selectedGroupsForCrossCheck.includes(group.id);
                  return (
                    <button
                      key={group.id}
                      onClick={() => {
                        if (isSelected) {
                          setSelectedGroupsForCrossCheck(selectedGroupsForCrossCheck.filter(id => id !== group.id));
                        } else {
                          setSelectedGroupsForCrossCheck([...selectedGroupsForCrossCheck, group.id]);
                        }
                      }}
                      className={`px-2.5 py-1 rounded-lg text-[10px] font-bold border uppercase tracking-wider transition-all cursor-pointer ${
                        isSelected
                          ? 'bg-blue-600 border-transparent text-white shadow-xs'
                          : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
                      }`}
                    >
                      {group.name}
                    </button>
                  );
                })}
                {groups.length === 0 && (
                  <span className="text-xs text-slate-400 dark:text-slate-500 italic">No segments created yet.</span>
                )}
              </div>
            </div>

            <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800/80 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest bg-slate-50/20 dark:bg-slate-950/10">
                    <th className="px-5 py-3">Name</th>
                    <th className="px-5 py-3">Email</th>
                    <th className="px-5 py-3">Overlapping Groups</th>
                    <th className="px-5 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/50 text-slate-700 dark:text-slate-400">
                  {getOverlappingLeads().map(lead => (
                    <tr 
                      key={lead.id}
                      onClick={() => {
                        setSelectedLeadId(lead.id);
                        fetchLeadDetails(lead.id);
                      }}
                      className="hover:bg-slate-50/50 dark:hover:bg-slate-800/20 transition-all group cursor-pointer"
                    >
                      <td className="px-5 py-3.5">
                        <div className="font-semibold text-xs text-slate-900 dark:text-white">{lead.name || 'N/A'}</div>
                        {lead.jobTitle && <div className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5 font-medium">{lead.jobTitle}</div>}
                      </td>
                      <td className="px-5 py-3.5 text-xs text-slate-500 dark:text-slate-400 font-mono flex items-center gap-2">
                        <FileType className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
                        {lead.email}
                      </td>
                      <td className="px-5 py-3.5" onClick={(e) => e.stopPropagation()}>
                        <div className="flex flex-wrap gap-1.5 max-w-xs">
                          {(lead.groups || []).map((g: any) => (
                            <span 
                              key={g.groupId}
                              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[8px] font-bold bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-500/10 text-blue-700 dark:text-blue-400 uppercase tracking-wider"
                            >
                              {g.group?.name}
                              <button
                                onClick={() => handleRemoveFromGroup(lead.id, g.groupId)}
                                className="text-[10px] font-bold hover:text-rose-600 dark:hover:text-rose-500 transition-colors border-0 bg-transparent cursor-pointer pl-0.5"
                                title={`Remove from ${g.group?.name}`}
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={async () => {
                              try {
                                const res = await fetch('/api/leads', {
                                  method: 'PUT',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ id: lead.id, isArchived: true })
                                });
                                if (res.ok) {
                                  const updatedLead = await res.json();
                                  setLeads(leads.map(l => l.id === lead.id ? updatedLead : l));
                                  showToast('Prospect archived to resolve overlaps.');
                                }
                              } catch (err) {
                                  console.error(err);
                              }
                            }}
                            className="px-2 py-1 bg-amber-500/10 hover:bg-amber-500/20 text-amber-700 dark:text-amber-500 rounded text-[9px] font-bold uppercase tracking-wider transition-colors cursor-pointer"
                          >
                            Archive Lead
                          </button>
                          {isAdmin && (
                            <button
                              onClick={() => handleDeleteLead(lead.id)}
                              className="p-1.5 hover:bg-rose-500/10 text-slate-400 hover:text-rose-600 rounded transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {getOverlappingLeads().length === 0 && (
                    <tr>
                      <td colSpan={4} className="text-center py-10 text-slate-400 dark:text-slate-500 text-xs">
                        No overlapping prospects found with the current cross-check filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

      </div>



      {/* Slide-over Activity Timeline Drawer */}
      <AnimatePresence>
        {selectedLeadId && (
          <>
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.4 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedLeadId(null)}
              className="fixed inset-0 bg-slate-900/60 z-40 backdrop-blur-xs"
            />

            {/* Panel */}
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed right-0 top-0 bottom-0 w-full max-w-lg bg-white dark:bg-[#0e1017] border-l border-slate-200 dark:border-[#1b1c26] shadow-2xl z-50 flex flex-col font-sans"
            >
              {/* Header */}
              <div className="p-5 border-b border-slate-200 dark:border-slate-800/60 bg-slate-50/50 dark:bg-[#11131c] flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider">Prospect Activity Timeline</h3>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Comprehensive audit trail of sent campaigns and response history.</p>
                </div>
                <button
                  onClick={() => setSelectedLeadId(null)}
                  className="p-1.5 hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-700 dark:hover:text-white rounded-lg transition-colors"
                >
                  <X className="w-4.5 h-4.5" />
                </button>
              </div>

              {/* Content */}
              <div className="flex-1 overflow-y-auto p-5 space-y-6">
                {loadingDetails ? (
                  <div className="py-20 text-center text-slate-400 dark:text-slate-500 text-xs space-y-3">
                    <div className="w-6 h-6 border-2 border-slate-300 dark:border-slate-700 border-t-blue-500 animate-spin rounded-full mx-auto" />
                    <p className="font-medium tracking-wide">Syncing prospect timeline logs...</p>
                  </div>
                ) : leadDetails ? (
                  <>
                    {/* Lead Profile Info Card */}
                    <div className="bg-slate-50 dark:bg-[#12141e] border border-slate-200 dark:border-[#1e202d] rounded-xl p-4 space-y-3.5 animate-in fade-in duration-300">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <h4 className="text-sm font-bold text-slate-800 dark:text-white">{leadDetails.name || 'Anonymous Prospect'}</h4>
                          {leadDetails.jobTitle && (
                            <p className="text-[11px] text-slate-500 dark:text-slate-400 font-medium mt-0.5">{leadDetails.jobTitle}</p>
                          )}
                        </div>
                        <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-[10px] font-bold border uppercase tracking-wider
                          ${leadDetails.validationStatus === 'Valid' ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900/30' : ''}
                          ${leadDetails.validationStatus === 'Invalid' ? 'bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-900/30' : ''}
                          ${leadDetails.validationStatus === 'Risky' ? 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-900/30' : ''}
                          ${leadDetails.validationStatus === 'Unverified' ? 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800' : ''}
                        `}>
                          {leadDetails.validationStatus}
                        </span>
                      </div>

                      <div className="grid grid-cols-2 gap-4 pt-2 border-t border-slate-200/60 dark:border-slate-800/40 text-[11px]">
                        <div>
                          <span className="text-slate-400 dark:text-slate-500 font-medium uppercase tracking-wider text-[9px]">Email Address</span>
                          <p className="font-mono text-slate-700 dark:text-slate-400 mt-0.5 break-all">{leadDetails.email}</p>
                        </div>
                        <div>
                          <span className="text-slate-400 dark:text-slate-500 font-medium uppercase tracking-wider text-[9px]">Company</span>
                          <p className="text-slate-700 dark:text-slate-400 mt-0.5 font-semibold">{leadDetails.company || 'N/A'}</p>
                        </div>
                      </div>

                      {/* Suppression List entry: shown whatever the CRM status says; only an admin removes it */}
                      {leadDetails.suppression && (
                        <div className="pt-2 border-t border-slate-200/60 dark:border-slate-800/40 space-y-2">
                          <div className="flex justify-between items-center gap-3">
                            <span className="text-slate-400 dark:text-slate-500 font-medium uppercase tracking-wider text-[9px]">Suppression List</span>
                            <SuppressionChip lead={leadDetails} />
                          </div>
                          <p className="text-[11px] text-slate-600 dark:text-slate-400 leading-relaxed">
                            {describeSuppression(leadDetails.suppression)} Campaigns never enroll or email this address, whatever the lead&apos;s status.
                          </p>
                          {isAdmin ? (
                            <button
                              onClick={() => handleRemoveSuppression(leadDetails)}
                              className="px-2.5 py-1 text-[10px] font-bold rounded-lg border uppercase tracking-wider transition-all cursor-pointer bg-white hover:bg-rose-50 dark:bg-slate-900 dark:hover:bg-rose-950/30 border-rose-200 dark:border-rose-900/40 text-rose-700 dark:text-rose-400"
                            >
                              Remove From List
                            </button>
                          ) : (
                            <p className="text-[10px] text-slate-400 dark:text-slate-500">Only an admin can remove an address from the suppression list.</p>
                          )}
                        </div>
                      )}

                      {/* Groups Management */}
                      <div className="pt-2 border-t border-slate-200/60 dark:border-slate-800/40">
                        <span className="text-slate-400 dark:text-slate-500 font-medium uppercase tracking-wider text-[9px]">Group Memberships</span>
                        <div className="flex flex-wrap gap-1.5 mt-1.5">
                          {groups.map(group => {
                            const isMember = (leadDetails.groups || []).some((g: any) => g.groupId === group.id);
                            return (
                              <button
                                key={group.id}
                                onClick={async () => {
                                  let nextGroupIds = (leadDetails.groups || []).map((g: any) => g.groupId);
                                  if (isMember) {
                                    nextGroupIds = nextGroupIds.filter((id: string) => id !== group.id);
                                  } else {
                                    nextGroupIds = [...nextGroupIds, group.id];
                                  }
                                  try {
                                    const res = await fetch('/api/leads', {
                                      method: 'PUT',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ id: leadDetails.id, groupIds: nextGroupIds })
                                    });
                                    if (res.ok) {
                                      const updatedLead = await res.json();
                                      // The PUT answer has no dispatches or replies, so the timeline is kept
                                      setLeadDetails((prev: any) => prev && prev.id === updatedLead.id ? { ...prev, ...updatedLead } : prev);
                                      setLeads(leads.map(l => l.id === leadDetails.id ? updatedLead : l));
                                      await fetchGroups();
                                      showToast('Group memberships updated.');
                                    } else {
                                      const err = await res.json().catch(() => ({}));
                                      showToast(err.error || 'Failed to update group memberships.', 'error');
                                    }
                                  } catch (err) {
                                    console.error(err);
                                  }
                                }}
                                className={`px-2 py-0.5 rounded text-[9px] font-bold transition-all border uppercase tracking-wider flex items-center gap-1 cursor-pointer ${
                                  isMember
                                    ? 'bg-blue-50 dark:bg-blue-950/20 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-500/10 shadow-xs'
                                    : 'bg-transparent text-slate-400 dark:text-slate-500 border-slate-200 dark:border-slate-800 hover:text-slate-600 dark:hover:text-slate-300'
                                }`}
                              >
                                {group.name}
                              </button>
                            );
                          })}
                          {groups.length === 0 && (
                            <span className="text-[10px] text-slate-400 dark:text-slate-500 italic">No lead groups created yet.</span>
                          )}
                        </div>
                      </div>

                      {/* Archive Status */}
                      <div className="pt-2 border-t border-slate-200/60 dark:border-slate-800/40 flex justify-between items-center">
                        <span className="text-slate-400 dark:text-slate-500 font-medium uppercase tracking-wider text-[9px]">Archiving Status</span>
                        <button
                          onClick={async () => {
                            try {
                              const res = await fetch('/api/leads', {
                                method: 'PUT',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ id: leadDetails.id, isArchived: !leadDetails.isArchived })
                              });
                              if (res.ok) {
                                const updatedLead = await res.json();
                                // The PUT answer has no dispatches or replies, so the timeline is kept
                                setLeadDetails((prev: any) => prev && prev.id === updatedLead.id ? { ...prev, ...updatedLead } : prev);
                                setLeads(leads.map(l => l.id === leadDetails.id ? updatedLead : l));
                                showToast(updatedLead.isArchived ? 'Prospect archived.' : 'Prospect unarchived.');
                                if (updatedLead.isArchived) {
                                  setSelectedLeadId(null);
                                }
                              } else {
                                const err = await res.json().catch(() => ({}));
                                showToast(err.error || 'Failed to update the lead.', 'error');
                              }
                            } catch (err) {
                              console.error(err);
                            }
                          }}
                          className={`px-2.5 py-1 text-[10px] font-bold rounded-lg border uppercase tracking-wider transition-all cursor-pointer ${
                            leadDetails.isArchived
                              ? 'bg-emerald-600 hover:bg-emerald-500 text-white border-transparent'
                              : 'bg-white hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-800 border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-400'
                          }`}
                        >
                          {leadDetails.isArchived ? 'Restore Prospect' : 'Archive Prospect'}
                        </button>
                      </div>
                    </div>

                    {/* Timeline Events List */}
                    <div className="space-y-4">
                      <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-slate-500">Activity Audit Log</h4>
                      
                      {getTimeline().length === 0 ? (
                        <p className="text-slate-400 dark:text-slate-500 text-xs py-6 text-center">No outbound campaigns or inbound responses recorded for this lead yet.</p>
                      ) : (
                        <div className="relative border-l-2 border-slate-100 dark:border-slate-800 ml-3 pl-5 space-y-5">
                          {getTimeline().map((event: any) => {
                            const isExpanded = expandedEmailId === event.id;
                            const isDispatch = event.type === 'dispatch';
                            
                            // Check events
                            const opens = event.events.filter((ev: any) => ev.eventType === 'open').length;
                            const clicks = event.events.filter((ev: any) => ev.eventType === 'click').length;

                            return (
                              <div key={event.id} className="relative">
                                {/* Dot Indicator */}
                                <span className={`absolute -left-[27px] top-1.5 w-3.5 h-3.5 rounded-full border-2 bg-white dark:bg-[#0e1017] flex items-center justify-center
                                  ${isDispatch 
                                    ? 'border-blue-600 dark:border-blue-500' 
                                    : 'border-emerald-600 dark:border-emerald-500'
                                  }`}
                                >
                                  {isDispatch ? (
                                    <Mail className="w-1.5 h-1.5 text-blue-600 dark:text-blue-500" />
                                  ) : (
                                    <MessageSquare className="w-1.5 h-1.5 text-emerald-600 dark:text-emerald-500" />
                                  )}
                                </span>

                                {/* Event Card */}
                                <div className="bg-slate-50/50 dark:bg-[#12141c]/45 border border-slate-200 dark:border-[#1a1c27] rounded-xl p-3.5 space-y-2 hover:border-slate-300 dark:hover:border-[#2b2e40] transition-colors">
                                  {/* Header */}
                                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-[10px] text-slate-400 dark:text-slate-500">
                                    <span className="font-bold uppercase tracking-wider">
                                      {isDispatch
                                        ? `Sent via ${event.campaign}${event.stepOrder ? ` · Step ${event.stepOrder}` : ''}`
                                        : 'Lead Inbound Reply'
                                      }
                                    </span>
                                    <span className="flex items-center gap-1">
                                      <Clock className="w-3 h-3" />
                                      {event.date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
                                    </span>
                                  </div>

                                  {/* Subject */}
                                  <h5 className="text-xs font-bold text-slate-800 dark:text-white leading-snug">{event.subject}</h5>

                                  {/* Telemetry Tracking Badges */}
                                  {isDispatch && (
                                    <div className="flex flex-wrap gap-2 pt-0.5">
                                      {event.status === 'Failed' ? (
                                        <span className="inline-flex items-center gap-1 bg-rose-50/70 dark:bg-rose-950/20 border border-rose-200/50 dark:border-rose-500/10 text-[9px] font-bold text-rose-600 dark:text-rose-400 px-2 py-0.5 rounded">
                                          <Ban className="w-3 h-3" />
                                          Failed
                                        </span>
                                      ) : event.status === 'Sending' ? (
                                        <span className="inline-flex items-center gap-1 bg-amber-50/70 dark:bg-amber-950/20 border border-amber-200/50 dark:border-amber-500/10 text-[9px] font-bold text-amber-600 dark:text-amber-400 px-2 py-0.5 rounded">
                                          <Hourglass className="w-3 h-3" />
                                          Sending
                                        </span>
                                      ) : event.status === 'Unknown' ? (
                                        <span className="inline-flex items-center gap-1 bg-slate-100 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700/40 text-[9px] font-bold text-slate-500 dark:text-slate-400 px-2 py-0.5 rounded">
                                          <MailQuestionMark className="w-3 h-3" />
                                          Unconfirmed
                                        </span>
                                      ) : event.deliveredAt ? (
                                        <span className="inline-flex items-center gap-1 bg-emerald-50/70 dark:bg-emerald-950/20 border border-emerald-200/50 dark:border-emerald-500/10 text-[9px] font-bold text-emerald-600 dark:text-emerald-400 px-2 py-0.5 rounded">
                                          <CheckCircle2 className="w-3 h-3" />
                                          Delivered
                                        </span>
                                      ) : (
                                        <span className="inline-flex items-center gap-1 bg-slate-100 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700/40 text-[9px] font-bold text-slate-500 dark:text-slate-400 px-2 py-0.5 rounded">
                                          <Mail className="w-3 h-3" />
                                          Sent
                                        </span>
                                      )}
                                      {opens > 0 && (
                                        <span className="inline-flex items-center gap-1 bg-blue-50/70 dark:bg-blue-950/20 border border-blue-200/50 dark:border-blue-500/10 text-[9px] font-bold text-blue-600 dark:text-blue-400 px-2 py-0.5 rounded">
                                          <Eye className="w-3 h-3" />
                                          Opened ({opens})
                                        </span>
                                      )}
                                      {clicks > 0 && (
                                        <span className="inline-flex items-center gap-1 bg-indigo-50/70 dark:bg-indigo-950/20 border border-indigo-200/50 dark:border-indigo-500/10 text-[9px] font-bold text-indigo-600 dark:text-indigo-400 px-2 py-0.5 rounded">
                                          <MousePointerClick className="w-3 h-3" />
                                          Clicked ({clicks})
                                        </span>
                                      )}
                                    </div>
                                  )}

                                  {/* Body Toggle Button */}
                                  <button
                                    onClick={() => setExpandedEmailId(isExpanded ? null : event.id)}
                                    className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-400 cursor-pointer pt-1 border-0 bg-transparent"
                                  >
                                    {isExpanded ? (
                                      <>
                                        Hide email copy
                                        <ChevronUp className="w-3.5 h-3.5" />
                                      </>
                                    ) : (
                                      <>
                                        View email copy
                                        <ChevronDown className="w-3.5 h-3.5" />
                                      </>
                                    )}
                                  </button>

                                  {/* Body copy container — plain text only; bodies are untrusted HTML */}
                                  {isExpanded && (
                                    <div
                                      className="text-xs mt-2.5 p-3 rounded-lg bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-mono whitespace-pre-wrap max-h-56 overflow-y-auto break-words leading-relaxed"
                                    >
                                      {emailBodyToText(event.body)}
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="text-center text-slate-400 py-10 text-xs">Error loading lead data.</p>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Floating Bulk Actions Bar */}
      <AnimatePresence>
        {selectedLeads.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 50, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 50, scale: 0.95 }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 dark:bg-slate-950 border border-slate-800 text-white px-5 py-3 rounded-full shadow-2xl flex items-center gap-4.5 z-45 max-w-lg w-auto"
          >
            <span className="text-xs font-bold text-slate-300 pr-3 border-r border-slate-800">
              {selectedLeads.length} selected
            </span>
            <div className="flex items-center gap-2">
              {activeTab === 'suppressed' ? (
                <button
                  onClick={handleBulkReactivateLeads}
                  className="bg-emerald-600 hover:bg-emerald-500 text-xs font-bold px-3 py-1.5 rounded-full flex items-center gap-1 transition-colors cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Re-activate
                </button>
              ) : (
                <button
                  onClick={handleBulkVerify}
                  disabled={isVerifying}
                  className="bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 text-xs font-bold px-3 py-1.5 rounded-full flex items-center gap-1 transition-colors cursor-pointer"
                >
                  <Globe className="w-3 h-3" />
                  Check Domain MX
                </button>
              )}
              <button
                onClick={() => handleBulkArchiveLeads(activeTab !== 'archived')}
                className="bg-slate-800 hover:bg-slate-700 text-xs font-bold px-3 py-1.5 rounded-full flex items-center gap-1 transition-colors cursor-pointer border border-slate-700"
              >
                <Archive className="w-3 h-3 text-slate-400" />
                {activeTab === 'archived' ? 'Unarchive' : 'Archive'}
              </button>
              {isAdmin && (
                <button
                  onClick={handleBulkDeleteLeads}
                  className="bg-rose-950/60 hover:bg-rose-900 text-xs font-bold px-3 py-1.5 rounded-full flex items-center gap-1 transition-colors cursor-pointer border border-rose-800/40 text-rose-200"
                >
                  <Trash2 className="w-3 h-3" />
                  Delete
                </button>
              )}
            </div>
            <button
              onClick={() => setSelectedLeadIds([])}
              className="text-slate-400 hover:text-white transition-colors text-xs font-semibold pl-1"
            >
              Clear
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Delete All Leads Confirmation Modal */}
      <AnimatePresence>
        {showDeleteAllConfirm && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.5 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowDeleteAllConfirm(false)}
              className="fixed inset-0 bg-black z-50 backdrop-blur-xs"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl p-6 z-55 w-full max-w-md"
            >
              <h3 className="text-base font-bold text-slate-900 dark:text-white mb-2 uppercase tracking-wide flex items-center gap-2">
                <AlertCircle className="w-5 h-5 text-rose-600" />
                DANGER: Delete All Leads
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed mb-4">
                This action will permanently delete all leads, including their activity history, replies, and group memberships. This cannot be undone.
              </p>
              <div className="space-y-3">
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300">
                  Type <span className="font-mono text-rose-500">DELETE</span> to confirm:
                </label>
                <input
                  type="text"
                  placeholder="DELETE"
                  value={deleteAllConfirmText}
                  onChange={(e) => setDeleteAllConfirmText(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-2.5 text-xs text-slate-900 dark:text-white placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-rose-500/40"
                />
              </div>
              <div className="flex gap-3 justify-end mt-6 pt-4 border-t border-slate-100 dark:border-slate-800/80">
                <button
                  onClick={() => setShowDeleteAllConfirm(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-500 hover:text-slate-800 dark:text-slate-400 hover:text-white bg-transparent border-0 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDeleteAllLeads}
                  disabled={deleteAllConfirmText !== 'DELETE'}
                  className="bg-rose-600 hover:bg-rose-500 disabled:bg-rose-950/25 disabled:text-rose-500/50 text-white px-5 py-2 rounded-lg text-xs font-semibold shadow-sm transition-colors cursor-pointer"
                >
                  Confirm Delete All
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Group Deletion Option Modal */}
      <AnimatePresence>
        {groupToDelete && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.5 }}
              exit={{ opacity: 0 }}
              onClick={() => setGroupToDelete(null)}
              className="fixed inset-0 bg-black z-50 backdrop-blur-xs"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl p-6 z-55 w-full max-w-md"
            >
              <h3 className="text-base font-bold text-slate-900 dark:text-white mb-2 uppercase tracking-wide flex items-center gap-2">
                <Folder className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                Delete Group: {groupToDelete.name}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed mb-5">
                Decide what to do with the prospects currently assigned to this group:
              </p>
              
              <div className="space-y-3.5">
                {/* KEEP option */}
                <label className="flex items-start gap-3 p-3 bg-slate-50 dark:bg-slate-950 border border-slate-200/60 dark:border-slate-800 rounded-xl cursor-pointer hover:bg-slate-100/50 dark:hover:bg-slate-900/50 transition-colors">
                  <input
                    type="radio"
                    name="disposalAction"
                    value="KEEP"
                    checked={leadDisposalAction === 'KEEP'}
                    onChange={() => setLeadDisposalAction('KEEP')}
                    className="mt-0.5 text-blue-600 focus:ring-blue-500/40 cursor-pointer"
                  />
                  <div>
                    <span className="block text-xs font-bold text-slate-800 dark:text-white">Keep leads in CRM</span>
                    <span className="block text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">Retains leads in the database and removes them from this group only.</span>
                  </div>
                </label>

                {/* DELETE option (admin only) */}
                {isAdmin && (
                  <label className="flex items-start gap-3 p-3 bg-slate-50 dark:bg-slate-950 border border-slate-200/60 dark:border-slate-800 rounded-xl cursor-pointer hover:bg-slate-100/50 dark:hover:bg-slate-900/50 transition-colors">
                    <input
                      type="radio"
                      name="disposalAction"
                      value="DELETE"
                      checked={leadDisposalAction === 'DELETE'}
                      onChange={() => setLeadDisposalAction('DELETE')}
                      className="mt-0.5 text-rose-600 focus:ring-rose-500/40 cursor-pointer"
                    />
                    <div>
                      <span className="block text-xs font-bold text-rose-600 dark:text-rose-400">Delete associated leads</span>
                      <span className="block text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">Permanently deletes all leads in this group from the CRM database.</span>
                    </div>
                  </label>
                )}

                {/* MOVE option */}
                <label className="flex items-start gap-3 p-3 bg-slate-50 dark:bg-slate-950 border border-slate-200/60 dark:border-slate-800 rounded-xl cursor-pointer hover:bg-slate-100/50 dark:hover:bg-slate-900/50 transition-colors">
                  <input
                    type="radio"
                    name="disposalAction"
                    value="MOVE"
                    checked={leadDisposalAction === 'MOVE'}
                    onChange={() => setLeadDisposalAction('MOVE')}
                    className="mt-0.5 text-blue-600 focus:ring-blue-500/40 cursor-pointer"
                  />
                  <div className="w-full">
                    <span className="block text-xs font-bold text-slate-800 dark:text-white">Move leads to another group</span>
                    <span className="block text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">Transfer all leads to a different existing group.</span>
                    
                    {leadDisposalAction === 'MOVE' && (
                      <div className="mt-2.5" onClick={(e) => e.stopPropagation()}>
                        <select
                          value={disposalTargetGroupId}
                          onChange={(e) => setDisposalTargetGroupId(e.target.value)}
                          className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-2 text-xs text-slate-800 dark:text-white cursor-pointer outline-none"
                        >
                          <option value="">-- Choose Target Group --</option>
                          {groups.filter(g => g.id !== groupToDelete.id).map(g => (
                            <option key={g.id} value={g.id}>{g.name}</option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                </label>
              </div>

              <div className="flex gap-3 justify-end mt-6 pt-4 border-t border-slate-100 dark:border-slate-800/80">
                <button
                  onClick={() => setGroupToDelete(null)}
                  className="px-4 py-2 text-xs font-semibold text-slate-500 hover:text-slate-800 dark:text-slate-400 hover:text-white bg-transparent border-0 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={handleExecuteDeleteGroup}
                  disabled={leadDisposalAction === 'MOVE' && !disposalTargetGroupId}
                  className="bg-blue-600 hover:bg-blue-500 disabled:bg-slate-200 dark:disabled:bg-slate-800 text-white disabled:text-slate-400 dark:disabled:text-slate-600 px-5 py-2 rounded-lg text-xs font-semibold shadow-sm transition-colors cursor-pointer"
                >
                  Confirm Delete Group
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {confirmDialog && (
        <ConfirmDialog
          isOpen={confirmDialog.isOpen}
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmLabel={confirmDialog.confirmLabel}
          cancelLabel={confirmDialog.cancelLabel}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
          isDestructive={confirmDialog.isDestructive}
        />
      )}
    </div>
  );
}
