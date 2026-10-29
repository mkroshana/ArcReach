/* eslint-disable react-hooks/set-state-in-effect */
'use client';

import { 
  UploadCloud, 
  FileType, 
  CheckCircle2, 
  AlertCircle, 
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
  Archive,
  FolderPlus,
  Ban,
  MailX,
  Hourglass,
  MailQuestionMark,
  Loader2,
  UserPlus,
  ArrowLeft
} from 'lucide-react';
import { useState, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ActionDrawer } from '@/components/ActionDrawer';
import { TableSkeleton } from '@/components/Skeleton';
import { decodeMimeHeader } from '@/lib/mime';
import { emailBodyToText } from '@/lib/emailText';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { loadErrorMessage, readJsonList, readJsonObject } from '@/lib/apiResponse';
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
import { OPT_OUT_REASONS, SUPPRESSION_LABELS } from '@/lib/suppression';
import { DOMAIN_CHECK_BATCH_SIZE, type DomainCheckCounts } from '@/lib/domainCheck';
import {
  LEAD_PAGE_MAX,
  LEAD_PAGE_SIZE,
  LEAD_STATUS_FILTERS,
  leadListParams,
  type LeadListQuery,
  type LeadStatusFilter
} from '@/lib/leadView';
import type { SuppressionReason } from '@prisma/client';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { BodyPortal } from '@/components/ui/BodyPortal';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { inputClasses, SearchInput } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { OverflowMenu } from '@/components/ui/OverflowMenu';
import { PageHeader } from '@/components/ui/PageHeader';
import { Segmented, type SegmentedOption } from '@/components/ui/Segmented';
import { Table, THead, TH, TR, TD } from '@/components/ui/Table';
import { cn } from '@/lib/utils';

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
  if (!label) return <Badge>Active</Badge>;
  const Icon = label === 'Bounced' ? Ban : label === 'Unsubscribed' ? MailX : AlertCircle;
  return (
    <span title={lead.suppression ? describeSuppression(lead.suppression) : undefined}>
      <Badge tone={label === 'Unsubscribed' ? 'amber' : 'red'}>
        <Icon size={12} aria-hidden />
        {label}
      </Badge>
    </span>
  );
}

const VALIDATION_TONE: Record<string, BadgeTone> = { Valid: 'green', Invalid: 'red', Risky: 'amber' };

/** A lead's domain check result: Valid, Risky, Invalid, or Unverified with a dot. */
function ValidationBadge({ status }: { status: string }) {
  return (
    <Badge tone={VALIDATION_TONE[status] ?? 'neutral'} dot={status === 'Unverified'}>
      {status === 'Valid' && <CheckCircle2 size={12} aria-hidden />}
      {(status === 'Invalid' || status === 'Risky') && <AlertCircle size={12} aria-hidden />}
      {status}
    </Badge>
  );
}

type LeadTab = 'leads' | 'groups' | 'overlaps' | 'archived' | 'suppressed';

const LEAD_TABS: SegmentedOption<LeadTab>[] = [
  { value: 'leads', label: 'Leads Directory' },
  { value: 'groups', label: 'Lead Groups' },
  { value: 'overlaps', label: 'Cross-Check & Overlaps' },
  { value: 'suppressed', label: 'Suppressed Leads' },
  { value: 'archived', label: 'Archived Leads' },
];

const STATUS_OPTIONS: SegmentedOption<LeadStatusFilter>[] = LEAD_STATUS_FILTERS.map(status => ({ value: status, label: status }));

const LABEL = 'mb-1.5 block text-[13px] font-medium text-text-main';
const FIELD_LABEL = 'text-[11px] font-medium text-text-muted';
const CHECKBOX = 'size-4 cursor-pointer accent-primary';
const DELETE_ICON = 'hover:text-rose-600 dark:hover:text-rose-400';
const EMPTY_CELL = 'py-12 text-center text-xs text-text-muted';
const WARN_BOX = 'flex items-start gap-2 rounded-control border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-500/10 dark:text-amber-300';
const ERROR_BOX = 'flex items-start gap-2 rounded-control border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800 dark:border-rose-900/50 dark:bg-rose-500/10 dark:text-rose-300';
const MAP_BOX = 'space-y-2 rounded-control border border-card-border p-3';
const PREVIEW_BOX = 'truncate rounded-md bg-slate-50 px-2 py-1.5 text-[11px] text-text-sub dark:bg-white/[0.03]';
const TOGGLE = 'cursor-pointer rounded-control border font-medium transition-colors';
const TOGGLE_ON = 'border-primary bg-primary-subtle text-primary';
const TOGGLE_OFF = 'border-input-border bg-card text-text-sub hover:text-text-main';
const RADIO_ROW = 'flex cursor-pointer items-start gap-3 rounded-control border border-card-border p-3 transition-colors hover:bg-slate-50 has-[:checked]:border-primary has-[:checked]:bg-primary-subtle dark:hover:bg-white/[0.02]';
const MODAL = 'fixed top-1/2 left-1/2 z-55 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-card border border-card-border bg-card p-6 shadow-[var(--float-shadow)] dark:shadow-2xl';

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
    counts.invalid > 0 ? `${counts.invalid} Invalid (the domain does not exist or accepts no mail, or the address is malformed)` : '',
  ].filter(Boolean);
  return found.length > 0 ? `${found.join(', ')}.` : 'No leads were checked.';
}

/** How many leads a domain MX check has checked, of how many once that is known. */
function checkedOf(progress: { checked: number; total: number | null }): string {
  return progress.total === null ? `${progress.checked}` : `${progress.checked} of ${progress.total}`;
}

/** Campaign statuses in the order the confirmation of a full check lists them; any other status follows. */
const CAMPAIGN_STATUS_ORDER = ['Active', 'Paused', 'Draft', 'Stopped', 'Completed'];

/**
 * What a check of every Unverified or Risky lead does, for its confirmation.
 * `validCampaigns` counts the campaigns that enroll Valid leads, by status.
 */
function describeFullDomainCheck(validCampaigns: Record<string, number>): string {
  const rank = (status: string) => (CAMPAIGN_STATUS_ORDER.includes(status) ? CAMPAIGN_STATUS_ORDER.indexOf(status) : CAMPAIGN_STATUS_ORDER.length);
  const statuses = Object.keys(validCampaigns).sort((a, b) => rank(a) - rank(b));
  const total = statuses.reduce((sum, status) => sum + validCampaigns[status], 0);
  const enrolls = total === 0
    ? ''
    : ` Leads that come back Valid are enrolled in the ${total === 1 ? 'campaign that targets' : `${total} campaigns that target`} Valid leads`
      + ` (${statuses.map(status => `${validCampaigns[status]} ${status}`).join(', ')})`
      + `${validCampaigns.Active ? ', and an Active campaign emails them on its schedule' : ''}.`;
  return 'Every Unverified or Risky lead is checked, archived leads included, whatever the search and filters show.'
    + ` The check runs in batches of ${DOMAIN_CHECK_BATCH_SIZE} and stops if this tab is closed; running it again takes the leads still unchecked.`
    + enrolls;
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
  // The page of leads the open table shows, loaded from the server (GET /api/leads)
  const [leads, setLeads] = useState<any[]>([]);
  // Leads the open table's list holds on all its pages, and in the whole CRM
  const [leadTotal, setLeadTotal] = useState(0);
  const [leadCount, setLeadCount] = useState(0);
  // The page could not be loaded, so the table says so instead of showing no matches
  const [listError, setListError] = useState(false);
  // Bumped to load the open table's page again after a change
  const [listVersion, setListVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
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
  
  // Search and Filter states; the search is sent once typing pauses
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState<LeadStatusFilter>('All');
  const [currentPage, setCurrentPage] = useState(1);

  // Domain MX check progress: leads checked so far, by result, out of the leads to check (null until the server says how many)
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyProgress, setVerifyProgress] = useState<DomainCheckCounts & { checked: number; total: number | null } | null>(null);
  // True while the leads a check of every lead would take on are counted for its confirmation
  const [isCountingUnchecked, setIsCountingUnchecked] = useState(false);

  // New Lead form state
  const [showAddLead, setShowAddLead] = useState(false);
  const [newLead, setNewLead] = useState({ name: '', email: '', company: '', jobTitle: '' });

  // Outbox email timeline states
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [leadDetails, setLeadDetails] = useState<any | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [leadDetailsError, setLeadDetailsError] = useState('');
  const [expandedEmailId, setExpandedEmailId] = useState<string | null>(null);

  // Lead Groups and Archiving states
  const [activeTab, setActiveTab] = useState<LeadTab>('leads');
  const [groups, setGroups] = useState<any[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(false);
  // Why the lead groups could not be loaded; group lists and pickers then say so instead of showing none
  const [groupsError, setGroupsError] = useState('');
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
  const [showCsvDrawer, setShowCsvDrawer] = useState<boolean>(false);
  const isCsvDrawerOpen = showCsvDrawer || showMapping;
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

  // Bulk Actions & disposal states. The selected leads' rows as last loaded, kept across the pages of one view
  const [selectedLeads, setSelectedLeads] = useState<any[]>([]);
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
      // Cleared first, so a failed load never leaves the previously opened lead's timeline on screen
      setLeadDetails(null);
      setLeadDetailsError('');
      setLeadDetails(await readJsonObject(await fetch(`/api/leads?id=${id}`), 'This lead'));
    } catch (err) {
      console.error('Failed to load lead details:', err);
      setLeadDetailsError(loadErrorMessage(err, 'This lead'));
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
      setGroups(await readJsonList(await fetch('/api/leads/groups'), 'Lead groups'));
      setGroupsError('');
    } catch (err) {
      console.error('Failed to load groups:', err);
      setGroupsError(loadErrorMessage(err, 'Lead groups'));
    } finally {
      setLoadingGroups(false);
    }
  };

  // Loads the open table's page again, after a change to leads it may show
  const reloadLeads = () => setListVersion(version => version + 1);

  // Deselects a lead after a change that may move it out of the open tab, search or filter
  const deselectLead = (id: string) => setSelectedLeads(prev => prev.filter(l => l.id !== id));

  useEffect(() => {
    fetchGroups();
    fetch('/api/session')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setIsAdmin(data?.role === 'ADMIN'))
      .catch(() => {});
  }, []);

  // Checks the selected Unverified or Risky leads `selected`, or with null every such lead the server finds
  const runDomainCheck = async (selected: string[] | null) => {
    if (isVerifying) return;

    // The selected leads are sent by id; with none selected the server takes every Unverified or Risky lead
    const selection = selected !== null;
    const ids = selected ?? [];

    // One request per batch, one after another, so each stays well inside the request timeout
    const progress: DomainCheckCounts & { checked: number; total: number | null } =
      { checked: 0, total: selection ? ids.length : null, valid: 0, risky: 0, invalid: 0 };
    setIsVerifying(true);
    setVerifyProgress({ ...progress });
    // Why the check stopped, as a sentence: the server's error, or that the request failed
    let failure: string | null = null;
    // The next batch of selected ids, or the address the server's next batch of every lead starts after
    let offset = 0;
    let after: string | null = null;

    try {
      do {
        const res: Response = await fetch('/api/leads/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(selection ? { ids: ids.slice(offset, offset + DOMAIN_CHECK_BATCH_SIZE) } : { all: true, after })
        });
        const data: any = await res.json().catch(() => ({}));
        if (!res.ok) {
          failure = data.error || `The server answered ${res.status}.`;
          break;
        }
        progress.checked += data.checked;
        progress.valid += data.counts.valid;
        progress.risky += data.counts.risky;
        progress.invalid += data.counts.invalid;
        offset += DOMAIN_CHECK_BATCH_SIZE;
        if (!selection) {
          after = data.next;
          progress.total = progress.checked + data.remaining;
        }
        setVerifyProgress({ ...progress });
      } while (selection ? offset < ids.length : after !== null);
    } catch (err) {
      failure = 'The request failed.';
      console.error(err);
    } finally {
      setIsVerifying(false);
      setVerifyProgress(null);
    }

    if (failure) {
      showToast(`Domain MX check stopped after ${checkedOf(progress)} leads. ${failure} ${describeDomainCheck(progress)}`, 'error');
    } else if (!selection && progress.checked === 0) {
      showToast('No leads are Unverified or Risky.');
    } else {
      showToast(`Domain MX check finished for ${checkedOf(progress)} leads: ${describeDomainCheck(progress)}`, progress.risky > 0 ? 'warning' : 'success');
    }
    if (progress.checked > 0) {
      // A checked lead may have left the status filter, and the page cannot tell which ones on other pages did
      if (selection) setSelectedLeads([]);
      reloadLeads();
    }
  };

  const handleBulkVerify = async () => {
    if (isVerifying || isCountingUnchecked) return;

    if (selectedLeads.length > 0) {
      const ids = selectedLeads.filter(l => l.validationStatus === 'Unverified' || l.validationStatus === 'Risky').map(l => l.id);
      if (ids.length === 0) {
        showToast('None of the selected leads is Unverified or Risky.');
        return;
      }
      await runDomainCheck(ids);
      return;
    }

    // A check of every lead is confirmed first: how many leads it takes on, and the campaigns its Valid leads join
    setIsCountingUnchecked(true);
    try {
      const res = await fetch('/api/leads/verify');
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || 'Failed to count the leads to check.', 'error');
      } else if (data.unchecked === 0) {
        showToast('No leads are Unverified or Risky.');
      } else {
        setConfirmDialog({
          isOpen: true,
          title: `Check ${data.unchecked.toLocaleString('en-US')} ${data.unchecked === 1 ? 'Lead' : 'Leads'}`,
          message: describeFullDomainCheck(data.validCampaigns),
          confirmLabel: 'Start Check',
          onConfirm: () => {
            setConfirmDialog(null);
            runDomainCheck(null);
          },
        });
      }
    } catch (err) {
      console.error(err);
      showToast('Failed to count the leads to check.', 'error');
    } finally {
      setIsCountingUnchecked(false);
    }
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
            deselectLead(id);
            reloadLeads();
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
        // Reflect deletion locally; each leads table loads its leads from the server when opened
        setGroups(groups.filter(g => g.id !== groupToDelete.id));
        reloadLeads();

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
    // Only the selected leads this tab, search and filter show (a view change clears the selection), as counted in the bulk bar
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
            setSelectedLeads([]);
            reloadLeads();
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
            setSelectedLeads([]);
            reloadLeads();
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
          ? 'The lead goes back to Neutral, campaigns targeting it can enroll and email it again, and Unibox replies to it are no longer blocked. Only do this if the recipient has asked to hear from you again.'
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
              deselectLead(data.lead.id);
              reloadLeads();
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
        setSelectedLeads([]);
        reloadLeads();
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
        setSelectedLeads([]);
        reloadLeads();
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
            reloadLeads();
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
        reloadLeads();
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
        reloadLeads();
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

  const handleExportCSV = async () => {
    if (exporting || !listQuery) return;
    // The selected leads in the table's address order, else every lead this tab, search and filter show,
    // loaded from the server a page at a time
    let exportLeads = [...selectedLeads].sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
    if (exportLeads.length === 0) {
      setExporting(true);
      try {
        const exported = new Map<string, any>();
        for (let page = 1; ; page++) {
          const res = await fetch(`/api/leads?${leadListParams({ ...listQuery, page, pageSize: LEAD_PAGE_MAX })}`);
          if (!res.ok) {
            showToast('Failed to export leads.', 'error');
            return;
          }
          const data = await res.json();
          for (const lead of data.leads) exported.set(lead.id, lead);
          // The server answers its last page for a page past the end
          if (data.page < page || data.page * LEAD_PAGE_MAX >= data.total) break;
        }
        exportLeads = Array.from(exported.values());
      } catch (err) {
        console.error(err);
        showToast('Failed to export leads.', 'error');
        return;
      } finally {
        setExporting(false);
      }
    }

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
      setShowCsvDrawer(false);
    }
    setImportProgress('');

    await fetchGroups(); // refresh group counts
    const added = totals.created + totals.suppressed;
    const skipped = totals.suppressed + totals.invalid + totals.blank + totals.duplicate > 0;
    showToast(summary, totals.failed > 0 ? 'error' : skipped || added === 0 ? 'warning' : 'success');
    reloadLeads();
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

  const handleCloseCsvDrawer = () => {
    if (loading) return;
    handleCancelImport();
    setShowCsvDrawer(false);
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
    e.target.value = '';
  };

  // The list the open table shows, one page at a time from the server: the Leads, Archived or Suppressed
  // tab under its search and status filter, an opened group's members by membership alone, whatever those
  // say, or the Cross-Check tab's leads in more than one group. The groups grid shows none.
  const listQuery: LeadListQuery | null =
    activeTab === 'groups'
      ? selectedGroupIdForView
        ? { view: 'group', search: '', status: 'All', groupIds: [selectedGroupIdForView], page: currentPage, pageSize: LEAD_PAGE_SIZE }
        : null
      : activeTab === 'overlaps'
        ? { view: 'overlaps', search: '', status: 'All', groupIds: selectedGroupsForCrossCheck, page: currentPage, pageSize: LEAD_PAGE_SIZE }
        : { view: activeTab, search: appliedSearch, status: filterStatus, groupIds: [], page: currentPage, pageSize: LEAD_PAGE_SIZE };
  const listUrl = listQuery ? `/api/leads?${leadListParams(listQuery)}` : null;

  // Searches on the server once typing pauses
  useEffect(() => {
    const timer = setTimeout(() => setAppliedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // A new list starts on its first page
  useEffect(() => {
    setCurrentPage(1);
  }, [appliedSearch, filterStatus, activeTab, selectedGroupIdForView, selectedGroupsForCrossCheck]);

  // A search or filter change clears the selection, as a tab change does: the page holds one page of the
  // new view, so it cannot tell which selected leads on other pages that view still shows
  useEffect(() => {
    setSelectedLeads(prev => (prev.length === 0 ? prev : []));
  }, [appliedSearch, filterStatus]);

  // Loads the open table's page. A newer request aborts an older one, so a slow answer never replaces a newer page.
  useEffect(() => {
    if (!listUrl) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    fetch(listUrl, { signal: controller.signal })
      .then(async res => {
        if (!res.ok) throw new Error(`The server answered ${res.status}.`);
        const data = await res.json();
        if (controller.signal.aborted) return;
        setLeads(data.leads);
        setLeadTotal(data.total);
        setLeadCount(data.leadCount);
        setListError(false);
        // A page past the end, after a delete or archive emptied the last one, is answered with the new last page
        setCurrentPage(data.page);
        // Selected leads on this page keep their latest values for Export and Check Domain MX
        const loaded = new Map<string, any>(data.leads.map((lead: any) => [lead.id, lead]));
        setSelectedLeads(prev => (prev.some(l => loaded.has(l.id)) ? prev.map(l => loaded.get(l.id) ?? l) : prev));
      })
      .catch(err => {
        if (controller.signal.aborted) return;
        console.error('Failed to load leads:', err);
        setLeads([]);
        setLeadTotal(0);
        setListError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [listUrl, listVersion]);

  const totalPages = Math.ceil(leadTotal / LEAD_PAGE_SIZE);
  const startIndex = leadTotal === 0 ? 0 : (currentPage - 1) * LEAD_PAGE_SIZE + 1;
  const endIndex = Math.min(currentPage * LEAD_PAGE_SIZE, leadTotal);
  const isSelected = (id: string) => selectedLeads.some(l => l.id === id);

  // The open table's page buttons: every leads table pages through its list on the server
  const paginationControls = leadTotal > 0 && (
    <div className="flex flex-col items-center justify-between gap-3 border-t border-card-border px-4 py-3 sm:flex-row">
      <div className="text-xs text-text-sub">
        Showing <span className="font-medium text-text-main">{startIndex}</span> to{' '}
        <span className="font-medium text-text-main">{endIndex}</span> of{' '}
        <span className="font-medium text-text-main">{leadTotal}</span> leads
      </div>
      <nav aria-label="Pages" className="flex items-center gap-1">
        <Button size="sm" iconOnly disabled={currentPage === 1} onClick={() => setCurrentPage(1)} aria-label="First page" title="First Page">
          <ChevronsLeft size={14} />
        </Button>
        <Button size="sm" iconOnly disabled={currentPage === 1} onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))} aria-label="Previous page" title="Previous Page">
          <ChevronLeft size={14} />
        </Button>

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
            <Button
              key={pageNum}
              size="sm"
              variant={currentPage === pageNum ? 'primary' : 'ghost'}
              aria-current={currentPage === pageNum ? 'page' : undefined}
              onClick={() => setCurrentPage(pageNum)}
              className="min-w-7 px-2"
            >
              {pageNum}
            </Button>
          );
        })}

        <Button size="sm" iconOnly disabled={currentPage === totalPages} onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))} aria-label="Next page" title="Next Page">
          <ChevronRight size={14} />
        </Button>
        <Button size="sm" iconOnly disabled={currentPage === totalPages} onClick={() => setCurrentPage(totalPages)} aria-label="Last page" title="Last Page">
          <ChevronsRight size={14} />
        </Button>
      </nav>
    </div>
  );
  // What an empty table says: no match, or that its page could not be loaded
  const emptyListMessage = (noMatch: string) => (listError ? 'Leads could not be loaded. Use Refresh to try again.' : noMatch);

  return (
    <div className="flex w-full flex-col gap-4 pb-12">
      <PageHeader
        title="Leads"
        actions={
          <>
            <Button iconOnly onClick={reloadLeads} aria-label="Refresh leads" title="Refresh Leads">
              <RefreshCw size={14} className={cn(loading && !isVerifying && 'animate-spin')} />
            </Button>
            <Button onClick={handleBulkVerify} disabled={isVerifying || isCountingUnchecked || loading}>
              <Globe size={14} />
              {isVerifying && verifyProgress ? `Checking ${checkedOf(verifyProgress)}` : 'Check Domain MX'}
            </Button>
            <Button onClick={() => setShowCsvDrawer(true)}>
              <UploadCloud size={14} />
              Import CSV
            </Button>
            <Button variant="primary" onClick={() => setShowAddLead(true)}>
              <Plus size={14} />
              Add Single Lead
            </Button>
            {/* Admin: Delete All Leads, kept out of the toolbar */}
            {isAdmin && (
              <OverflowMenu
                label="More lead actions"
                items={[
                  {
                    label: 'Delete All Leads',
                    icon: <Trash2 size={14} />,
                    danger: true,
                    disabled: loading || leadCount === 0,
                    onSelect: () => {
                      setDeleteAllConfirmText('');
                      setShowDeleteAllConfirm(true);
                    },
                  },
                ]}
              />
            )}
          </>
        }
      />

      {/* The groups feed the Groups tab and every group picker here, so a failed load is shown above them all */}
      {groupsError && !loadingGroups && (
        <Notice
          tone="error"
          title="Lead Groups Could Not Be Loaded"
          action={
            <Button size="sm" onClick={fetchGroups}>
              <RefreshCw size={14} />
              Retry
            </Button>
          }
        >
          {groupsError} Group lists and group choices on this page may be missing groups until they load.
        </Notice>
      )}

      {/* Domain MX check progress: real counts from the batches finished so far */}
      {isVerifying && verifyProgress && (
        <Notice
          tone="info"
          title="Checking Domain MX Records"
          action={
            <div className="shrink-0 space-y-0.5 text-right text-xs">
              <p className="font-medium text-primary">Checked {checkedOf(verifyProgress)} leads</p>
              <p className="text-text-sub">{verifyProgress.valid} Valid, {verifyProgress.risky} Risky, {verifyProgress.invalid} Invalid</p>
            </div>
          }
        >
          Looks up each email domain&apos;s MX records, or its A record when it has none. Mailboxes are not checked.
        </Notice>
      )}

      {/* Hidden File Input for CSV selection */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept=".csv"
        className="hidden"
      />

      {/* Add Single Lead ActionDrawer */}
      <ActionDrawer
        isOpen={showAddLead}
        onClose={() => setShowAddLead(false)}
        title="Add Single Lead"
        subtitle="Create an individual prospect record directly in your CRM directory."
        icon={UserPlus}
        width="md"
        formId="add-single-lead-form"
        onSubmit={handleAddCustomLead}
        primaryLabel="Save Record"
        cancelLabel="Cancel"
        onCancel={() => setShowAddLead(false)}
      >
        <div className="space-y-4">
          <div>
            <label htmlFor="add-lead-name" className={LABEL}>
              Full Name <span className="text-rose-500">*</span>
            </label>
            <input
              id="add-lead-name"
              type="text"
              required
              placeholder="e.g. John Doe"
              value={newLead.name}
              onChange={(e) => setNewLead({ ...newLead, name: e.target.value })}
              className={inputClasses('h-9')}
            />
          </div>

          <div>
            <label htmlFor="add-lead-email" className={LABEL}>
              Outreach Email <span className="text-rose-500">*</span>
            </label>
            <input
              id="add-lead-email"
              type="email"
              required
              placeholder="e.g. john@company.com"
              value={newLead.email}
              onChange={(e) => setNewLead({ ...newLead, email: e.target.value })}
              className={inputClasses('h-9')}
            />
          </div>

          <div>
            <label htmlFor="add-lead-company" className={LABEL}>
              Company Name
            </label>
            <input
              id="add-lead-company"
              type="text"
              placeholder="e.g. Acme Corp"
              value={newLead.company}
              onChange={(e) => setNewLead({ ...newLead, company: e.target.value })}
              className={inputClasses('h-9')}
            />
          </div>

          <div>
            <label htmlFor="add-lead-title" className={LABEL}>
              Job Title
            </label>
            <input
              id="add-lead-title"
              type="text"
              placeholder="e.g. Head of Growth"
              value={newLead.jobTitle}
              onChange={(e) => setNewLead({ ...newLead, jobTitle: e.target.value })}
              className={inputClasses('h-9')}
            />
          </div>

          <div className="border-t border-card-border pt-4">
            <label htmlFor="add-lead-group" className={LABEL}>
              Assign to Lead Group
            </label>
            <select
              id="add-lead-group"
              value={selectedGroupForAdd}
              onChange={(e) => setSelectedGroupForAdd(e.target.value)}
              className={inputClasses('h-9 cursor-pointer')}
            >
              <option value="">-- No Group Assignment --</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </ActionDrawer>

      {/* CSV Import & Column Mapping ActionDrawer */}
      <ActionDrawer
        isOpen={isCsvDrawerOpen}
        onClose={handleCloseCsvDrawer}
        title={showMapping ? `Map CSV Columns — ${csvFileName}` : 'Import Leads from CSV'}
        subtitle={
          showMapping
            ? `${csvRows.length.toLocaleString()} prospects found in file. Match columns to CRM fields.`
            : 'Upload a CSV spreadsheet to bulk import prospect contacts into your CRM.'
        }
        icon={showMapping ? FileType : UploadCloud}
        width="lg"
        isLoading={loading}
        showCancel={true}
        cancelLabel={showMapping ? 'Reset & Back' : 'Cancel'}
        onCancel={showMapping ? handleCancelImport : handleCloseCsvDrawer}
        primaryLabel={
          loading
            ? (importProgress || 'Importing...')
            : showMapping
            ? `Confirm & Import ${csvPlan.leads.length > 0 ? `(${csvPlan.leads.length})` : ''}`
            : 'Browse CSV File'
        }
        primaryLoading={loading}
        primaryDisabled={showMapping ? mappings.email === -1 || loading || csvPlan.leads.length === 0 : false}
        onPrimary={showMapping ? handleExecuteImport : () => fileInputRef.current?.click()}
      >
        {!showMapping ? (
          /* PHASE 1: Dropzone & Destination Pre-configuration */
          <div className="space-y-5">
            {/* Interactive Dropzone */}
            <div
              className={cn(
                'flex cursor-pointer flex-col items-center justify-center rounded-card border-2 border-dashed p-8 transition-colors',
                isDragging ? 'border-primary bg-primary-subtle' : 'border-input-border hover:bg-slate-50 dark:hover:bg-white/[0.02]',
              )}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDropUpload}
              onClick={() => fileInputRef.current?.click()}
            >
              <div className="mb-3 flex size-10 items-center justify-center rounded-control bg-primary-subtle text-primary">
                <UploadCloud size={20} />
              </div>
              <h3 className="mb-1 text-sm font-semibold text-text-main">Upload Prospect CSV Spreadsheet</h3>
              <p className="mb-4 max-w-sm text-center text-xs text-text-sub">
                Drag and drop your spreadsheet here, or click to browse files from your computer.
              </p>
              <span className={buttonClasses({ size: 'sm' })}>Select .csv File</span>
              <span className="mt-3 text-[11px] text-text-muted">Supports UTF-8, Windows-1252 (Excel), and UTF-16 formats</span>
            </div>

            {/* Destination Settings */}
            <div className="space-y-3 rounded-control border border-card-border p-4">
              <h4 className="text-[13px] font-semibold text-text-main">Destination Group Assignment</h4>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="import-group" className={LABEL}>
                    Add to Existing Group
                  </label>
                  <select
                    id="import-group"
                    value={selectedGroupForImport}
                    onChange={(e) => {
                      setSelectedGroupForImport(e.target.value);
                      setNewGroupNameForImport('');
                    }}
                    className={inputClasses('h-9 cursor-pointer')}
                  >
                    <option value="">-- No Group (General CRM) --</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="import-new-group" className={LABEL}>
                    Or Create New Group
                  </label>
                  <input
                    id="import-new-group"
                    type="text"
                    placeholder="e.g. Q4 Growth Leads"
                    value={newGroupNameForImport}
                    onChange={(e) => {
                      setNewGroupNameForImport(e.target.value);
                      setSelectedGroupForImport('');
                    }}
                    className={inputClasses('h-9')}
                  />
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* PHASE 2: Column Mapping & Batch Progress */
          <div className="space-y-5">
            {/* File Information & Warning Banners */}
            <div className="space-y-2">
              {/* Encoding alert */}
              {csvEncoding !== 'utf-8' && (
                <div className={WARN_BOX}>
                  <AlertCircle size={14} className="mt-px shrink-0" />
                  <span>
                    {csvEncoding === 'windows-1252' ? 'Read as Windows-1252 (Excel CSV).' : 'Read as UTF-16.'}{' '}
                    Check that accented characters display properly in the previews below.
                  </span>
                </div>
              )}

              {/* Unreadable rows alert */}
              {csvUnreadableRows > 0 && (
                <div className={WARN_BOX}>
                  <AlertCircle size={14} className="mt-px shrink-0" />
                  <span>
                    {csvUnreadableRows} {csvUnreadableRows === 1 ? 'row contains' : 'rows contain'} characters that could not be read (shown as {'�'}).
                    They will be imported and emailed as shown, so fix them in the file and import it again.
                  </span>
                </div>
              )}

              {/* Skipped rows explanation */}
              {mappings.email !== -1 && describeCsvSkips(csvPlan) && (
                <div className={WARN_BOX}>
                  <AlertCircle size={14} className="mt-px shrink-0" />
                  <span>{describeCsvSkips(csvPlan)} These rows will be skipped.</span>
                </div>
              )}

              {/* Import Failure banner */}
              {importFailure && (
                <div className={ERROR_BOX}>
                  <AlertCircle size={14} className="mt-px shrink-0" />
                  <span>{importFailure}</span>
                </div>
              )}
            </div>

            {/* Field Matching Grid */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {/* Email Address (Required) */}
              <div className={MAP_BOX}>
                <label htmlFor="map-email" className={LABEL}>
                  Email Address <span className="text-rose-500">*</span>
                </label>
                <select
                  id="map-email"
                  value={mappings.email === -1 ? '' : mappings.email}
                  onChange={(e) => setMappings({ ...mappings, email: toColumnIndex(e.target.value) })}
                  className={inputClasses('h-9 cursor-pointer')}
                >
                  <option value="" disabled>-- Select Email Column --</option>
                  {csvColumnOptions.map((label, i) => (
                    <option key={i} value={i}>{label}</option>
                  ))}
                </select>
                {mappings.email !== -1 && csvRows.length > 0 && (
                  <div className={PREVIEW_BOX}>
                    Preview: {csvRows[0][mappings.email] || <em className="text-text-muted">Empty</em>}
                  </div>
                )}
              </div>

              {/* Full Name (Optional) */}
              <div className={MAP_BOX}>
                <label htmlFor="map-name" className={LABEL}>
                  Full Name
                </label>
                <select
                  id="map-name"
                  value={mappings.name === -1 ? '' : mappings.name}
                  onChange={(e) => setMappings({ ...mappings, name: toColumnIndex(e.target.value) })}
                  className={inputClasses('h-9 cursor-pointer')}
                >
                  <option value="">{"[Don't Map - Leave Empty]"}</option>
                  {csvColumnOptions.map((label, i) => (
                    <option key={i} value={i}>{label}</option>
                  ))}
                </select>
                {mappings.name !== -1 && csvRows.length > 0 && (
                  <div className={PREVIEW_BOX}>
                    Preview: {csvRows[0][mappings.name] || <em className="text-text-muted">Empty</em>}
                  </div>
                )}
              </div>

              {/* Company Name (Optional) */}
              <div className={MAP_BOX}>
                <label htmlFor="map-company" className={LABEL}>
                  Company Name
                </label>
                <select
                  id="map-company"
                  value={mappings.company === -1 ? '' : mappings.company}
                  onChange={(e) => setMappings({ ...mappings, company: toColumnIndex(e.target.value) })}
                  className={inputClasses('h-9 cursor-pointer')}
                >
                  <option value="">{"[Don't Map - Leave Empty]"}</option>
                  {csvColumnOptions.map((label, i) => (
                    <option key={i} value={i}>{label}</option>
                  ))}
                </select>
                {mappings.company !== -1 && csvRows.length > 0 && (
                  <div className={PREVIEW_BOX}>
                    Preview: {csvRows[0][mappings.company] || <em className="text-text-muted">Empty</em>}
                  </div>
                )}
              </div>

              {/* Job Title (Optional) */}
              <div className={MAP_BOX}>
                <label htmlFor="map-title" className={LABEL}>
                  Job Title
                </label>
                <select
                  id="map-title"
                  value={mappings.jobTitle === -1 ? '' : mappings.jobTitle}
                  onChange={(e) => setMappings({ ...mappings, jobTitle: toColumnIndex(e.target.value) })}
                  className={inputClasses('h-9 cursor-pointer')}
                >
                  <option value="">{"[Don't Map - Leave Empty]"}</option>
                  {csvColumnOptions.map((label, i) => (
                    <option key={i} value={i}>{label}</option>
                  ))}
                </select>
                {mappings.jobTitle !== -1 && csvRows.length > 0 && (
                  <div className={PREVIEW_BOX}>
                    Preview: {csvRows[0][mappings.jobTitle] || <em className="text-text-muted">Empty</em>}
                  </div>
                )}
              </div>
            </div>

            {/* Destination Group in Mapping View */}
            <div className={MAP_BOX}>
              <span className={LABEL}>Target Lead Group</span>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <select
                  aria-label="Existing lead group"
                  value={selectedGroupForImport}
                  onChange={(e) => {
                    setSelectedGroupForImport(e.target.value);
                    setNewGroupNameForImport('');
                  }}
                  className={inputClasses('h-9 cursor-pointer')}
                >
                  <option value="">-- No Group (General CRM) --</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
                <input
                  type="text"
                  aria-label="New lead group name"
                  placeholder="Or type new group name"
                  value={newGroupNameForImport}
                  onChange={(e) => {
                    setNewGroupNameForImport(e.target.value);
                    setSelectedGroupForImport('');
                  }}
                  className={inputClasses('h-9')}
                />
              </div>
            </div>

            {/* Real-time Import Progress Bar */}
            {loading && (
              <div className="space-y-2 rounded-control bg-primary-subtle p-3">
                <div className="flex items-center justify-between text-xs font-medium text-primary">
                  <span>Import In Progress</span>
                  <span>{importProgress}</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-primary/20">
                  <div className="h-full w-full animate-pulse rounded-full bg-primary" />
                </div>
              </div>
            )}
          </div>
        )}
      </ActionDrawer>

      {/* Navigation Tabs */}
      <div className="max-w-full overflow-x-auto">
        <Segmented
          label="Lead views"
          options={LEAD_TABS}
          value={activeTab}
          onChange={(tab) => {
            setActiveTab(tab);
            setSelectedGroupIdForView(null);
            // Each tab has its own bulk actions, so a selection never carries over
            setSelectedLeads([]);
          }}
        />
      </div>

      {/* Main CRM Board Area */}
      <Card className="overflow-hidden">

        {/* Render for LEADS, ARCHIVED or SUPPRESSED Tab */}
        {(activeTab === 'leads' || activeTab === 'archived' || activeTab === 'suppressed') && (
          <>
            {/* Table Filter Top Bar */}
            <div className="flex flex-col justify-between gap-3 border-b border-card-border p-4 md:flex-row md:items-center">
              <div className="flex w-full flex-col items-stretch gap-3 sm:flex-row sm:items-center md:w-auto">
                <SearchInput
                  aria-label="Search leads"
                  placeholder="Search leads by name, email, company..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="w-full sm:w-80"
                />
                <div className="max-w-full overflow-x-auto">
                  <Segmented label="Deliverability filter" options={STATUS_OPTIONS} value={filterStatus} onChange={setFilterStatus} />
                </div>
              </div>

              <Button onClick={handleExportCSV} disabled={exporting} className="self-end md:self-auto">
                <Download size={14} />
                {exporting ? 'Exporting...' : selectedLeads.length > 0 ? `Export Selected (${selectedLeads.length})` : 'Export CSV'}
              </Button>
            </div>

            {/* Lead Rows list */}
            {loading && !isVerifying ? (
              <div className="p-6">
                <TableSkeleton rows={7} cols={6} />
              </div>
            ) : (
              <>
                <div className="w-full overflow-x-auto">
                  <Table>
                    <THead>
                      <tr>
                        <TH className="w-10">
                          <input
                            type="checkbox"
                            aria-label="Select every lead on this page"
                            checked={leads.length > 0 && leads.every(l => isSelected(l.id))}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedLeads([...selectedLeads, ...leads.filter(l => !isSelected(l.id))]);
                              } else {
                                const pageIds = leads.map(l => l.id);
                                setSelectedLeads(selectedLeads.filter(l => !pageIds.includes(l.id)));
                              }
                            }}
                            onClick={(e) => e.stopPropagation()}
                            className={CHECKBOX}
                          />
                        </TH>
                        <TH className="min-w-[150px]">Lead Name</TH>
                        <TH className="min-w-[170px]">Email Address</TH>
                        <TH className="min-w-[120px]">Company</TH>
                        <TH className="min-w-[120px]">Deliverability</TH>
                        <TH className="min-w-[110px]">Status</TH>
                        {(activeTab === 'leads' || activeTab === 'suppressed') && <TH className="min-w-[130px]">Groups</TH>}
                        <TH className="w-[80px] text-right">Actions</TH>
                      </tr>
                    </THead>
                    <tbody>
                      {leads.map((lead) => (
                        <TR
                          key={lead.id}
                          onClick={() => {
                            setSelectedLeadId(lead.id);
                            fetchLeadDetails(lead.id);
                          }}
                          className={cn('cursor-pointer', isSelected(lead.id) && 'bg-primary-subtle hover:bg-primary-subtle')}
                        >
                          <TD className="w-10" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              aria-label={`Select ${lead.name || lead.email}`}
                              checked={isSelected(lead.id)}
                              onChange={() => {
                                if (isSelected(lead.id)) {
                                  deselectLead(lead.id);
                                } else {
                                  setSelectedLeads([...selectedLeads, lead]);
                                }
                              }}
                              className={CHECKBOX}
                            />
                          </TD>
                          <TD>
                            <div className="font-medium">{lead.name || 'N/A'}</div>
                            {lead.jobTitle && <div className="mt-0.5 text-xs text-text-muted">{lead.jobTitle}</div>}
                          </TD>
                          <TD className="max-w-[260px] truncate text-text-sub">{lead.email}</TD>
                          <TD className="text-text-sub">{lead.company || 'N/A'}</TD>
                          <TD>
                            <ValidationBadge status={lead.validationStatus} />
                          </TD>
                          <TD>
                            <SuppressionChip lead={lead} />
                          </TD>
                          {(activeTab === 'leads' || activeTab === 'suppressed') && (
                            <TD>
                              <div className="flex max-w-[180px] flex-wrap gap-1">
                                {(lead.groups || []).map((g: any) => (
                                  <Badge key={g.groupId}>{g.group?.name}</Badge>
                                ))}
                                {(!lead.groups || lead.groups.length === 0) && (
                                  <span className="text-xs text-text-muted">No Group</span>
                                )}
                              </div>
                            </TD>
                          )}
                          <TD className="text-right" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center justify-end gap-0.5">
                              <Button
                                size="sm"
                                variant="ghost"
                                iconOnly
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
                                      deselectLead(lead.id);
                                      reloadLeads();
                                      showToast(updatedLead.isArchived ? 'Prospect archived.' : 'Prospect unarchived.');
                                    }
                                  } catch (err) {
                                    console.error(err);
                                  }
                                }}
                                className={cn(lead.isArchived && 'text-primary')}
                                aria-label={lead.isArchived ? 'Restore prospect' : 'Archive prospect'}
                                title={lead.isArchived ? 'Restore Prospect' : 'Archive Prospect'}
                              >
                                <Archive size={14} />
                              </Button>
                              {isAdmin && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  iconOnly
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDeleteLead(lead.id);
                                  }}
                                  className={DELETE_ICON}
                                  aria-label="Delete prospect"
                                  title="Delete Prospect"
                                >
                                  <Trash2 size={14} />
                                </Button>
                              )}
                            </div>
                          </TD>
                        </TR>
                      ))}
                      {leads.length === 0 && (
                        <tr>
                          <td colSpan={(activeTab === 'leads' || activeTab === 'suppressed') ? 8 : 7} className={EMPTY_CELL}>
                            {emptyListMessage('No lead records match your search filters.')}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </Table>
                </div>

                {/* Pagination Controls */}
                {paginationControls}
              </>
            )}
          </>
        )}

        {/* Render for LEAD GROUPS Tab */}
        {activeTab === 'groups' && (
          <div>
            {selectedGroupIdForView ? (
              /* Group Drill-down details */
              <div className="space-y-4 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold text-text-main">
                      {groups.find(g => g.id === selectedGroupIdForView)?.name}
                    </h2>
                    <p className="mt-0.5 text-xs text-text-sub">
                      {groups.find(g => g.id === selectedGroupIdForView)?.description || 'No description provided.'}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setSelectedGroupIdForView(null)}>
                      <ArrowLeft size={14} />
                      Back to Groups
                    </Button>
                    <Button size="sm" onClick={() => handleArchiveGroupLeads(selectedGroupIdForView!, true)}>
                      <Archive size={14} />
                      Archive All Leads
                    </Button>
                  </div>
                </div>

                <div className="overflow-hidden rounded-control border border-card-border">
                  {loading && !isVerifying ? (
                    <div className="p-6">
                      <TableSkeleton rows={5} cols={4} />
                    </div>
                  ) : (
                  <>
                  <div className="w-full overflow-x-auto">
                    <Table>
                      <THead>
                        <tr>
                          <TH>Name</TH>
                          <TH>Email</TH>
                          <TH>Company</TH>
                          <TH className="text-right">Actions</TH>
                        </tr>
                      </THead>
                      <tbody>
                        {leads.map(lead => (
                          <TR
                            key={lead.id}
                            onClick={() => {
                              setSelectedLeadId(lead.id);
                              fetchLeadDetails(lead.id);
                            }}
                            className="cursor-pointer"
                          >
                            <TD>
                              <div className="font-medium">{lead.name || 'N/A'}</div>
                              {lead.jobTitle && <div className="mt-0.5 text-xs text-text-muted">{lead.jobTitle}</div>}
                            </TD>
                            <TD className="text-text-sub">{lead.email}</TD>
                            <TD className="text-text-sub">{lead.company || 'N/A'}</TD>
                            <TD className="text-right" onClick={(e) => e.stopPropagation()}>
                              <div className="flex items-center justify-end gap-1">
                                <Button size="sm" onClick={() => handleRemoveFromGroup(lead.id, selectedGroupIdForView)}>
                                  Remove From Group
                                </Button>
                                {isAdmin && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    iconOnly
                                    onClick={() => handleDeleteLead(lead.id)}
                                    className={DELETE_ICON}
                                    aria-label="Delete prospect"
                                    title="Delete Prospect"
                                  >
                                    <Trash2 size={14} />
                                  </Button>
                                )}
                              </div>
                            </TD>
                          </TR>
                        ))}
                        {leads.length === 0 && (
                          <tr>
                            <td colSpan={4} className={EMPTY_CELL}>
                              {emptyListMessage('No active prospects associated with this group.')}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </Table>
                  </div>
                  {paginationControls}
                  </>
                  )}
                </div>
              </div>
            ) : (
              /* Groups grid overview */
              <div className="space-y-4 p-4">
                <CardHeader
                  title="Manage Segments"
                  action={
                    <Button size="sm" onClick={() => setShowCreateGroup(!showCreateGroup)} aria-expanded={showCreateGroup}>
                      <FolderPlus size={14} />
                      Create Lead Group
                    </Button>
                  }
                />

                {showCreateGroup && (
                  <form onSubmit={handleCreateGroup} className="space-y-3 rounded-control border border-card-border bg-slate-50/60 p-4 dark:bg-white/[0.02]">
                    <h3 className="text-[13px] font-semibold text-text-main">New Group Details</h3>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <div>
                        <label htmlFor="new-group-name" className={LABEL}>Group Name <span className="text-rose-500">*</span></label>
                        <input
                          id="new-group-name"
                          type="text"
                          required
                          placeholder="e.g. Q3 Outbound Outreach"
                          value={newGroup.name}
                          onChange={e => setNewGroup({ ...newGroup, name: e.target.value })}
                          className={inputClasses()}
                        />
                      </div>
                      <div>
                        <label htmlFor="new-group-description" className={LABEL}>Description</label>
                        <input
                          id="new-group-description"
                          type="text"
                          placeholder="e.g. Leads extracted from June marketing campaign"
                          value={newGroup.description}
                          onChange={e => setNewGroup({ ...newGroup, description: e.target.value })}
                          className={inputClasses()}
                        />
                      </div>
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setShowCreateGroup(false)}>
                        Cancel
                      </Button>
                      <Button size="sm" variant="primary" type="submit">
                        Save Group
                      </Button>
                    </div>
                  </form>
                )}

                {loadingGroups ? (
                  <div className="py-12 text-center text-xs text-text-muted">
                    <Loader2 size={20} className="mx-auto mb-2 animate-spin" />
                    Syncing segments...
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                    {groups.map(group => (
                      <div key={group.id} className="flex flex-col justify-between rounded-control border border-card-border p-4 transition-colors hover:border-primary/40">
                        <div>
                          <div className="flex items-start justify-between gap-2">
                            <h3 className="min-w-0 text-[13px] font-semibold break-words text-text-main">{group.name}</h3>
                            <Badge tone="blue">{group._count?.leads || 0} leads</Badge>
                          </div>
                          <p className="mt-1.5 line-clamp-2 min-h-8 text-xs text-text-sub">
                            {group.description || 'No description provided.'}
                          </p>
                        </div>
                        <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-card-border pt-3">
                          <Button size="sm" onClick={() => setSelectedGroupIdForView(group.id)}>
                            View Members
                          </Button>
                          <Button size="sm" onClick={() => handleArchiveGroupLeads(group.id, true)}>
                            Archive Leads
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => handleDeleteGroup(group)}>
                            Delete
                          </Button>
                        </div>
                      </div>
                    ))}
                    {groups.length === 0 && (
                      <div className="col-span-full py-12 text-center text-xs text-text-muted">
                        {groupsError ? 'Lead groups could not be loaded. Use Retry above.' : 'No segments created yet. Create a group to organize prospects.'}
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
          <div className="space-y-4 p-4">
            <div className="space-y-3">
              <div>
                <h2 className="text-sm font-semibold text-text-main">Cross-Check & Deduplication Filters</h2>
                <p className="mt-0.5 text-xs text-text-sub">Select specific groups to check for overlapping leads. If no groups are selected, it compiles duplicates across all segments.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {groups.map(group => {
                  const isSelected = selectedGroupsForCrossCheck.includes(group.id);
                  return (
                    <button
                      key={group.id}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => {
                        if (isSelected) {
                          setSelectedGroupsForCrossCheck(selectedGroupsForCrossCheck.filter(id => id !== group.id));
                        } else {
                          setSelectedGroupsForCrossCheck([...selectedGroupsForCrossCheck, group.id]);
                        }
                      }}
                      className={cn(TOGGLE, 'h-7 px-2.5 text-xs', isSelected ? TOGGLE_ON : TOGGLE_OFF)}
                    >
                      {group.name}
                    </button>
                  );
                })}
                {groups.length === 0 && (
                  <span className="text-xs text-text-muted">{groupsError ? 'Lead groups could not be loaded.' : 'No segments created yet.'}</span>
                )}
              </div>
            </div>

            <div className="overflow-hidden rounded-control border border-card-border">
              {loading && !isVerifying ? (
                <div className="p-6">
                  <TableSkeleton rows={5} cols={4} />
                </div>
              ) : (
              <>
              <div className="w-full overflow-x-auto">
                <Table>
                  <THead>
                    <tr>
                      <TH>Name</TH>
                      <TH>Email</TH>
                      <TH>Overlapping Groups</TH>
                      <TH className="text-right">Actions</TH>
                    </tr>
                  </THead>
                  <tbody>
                    {leads.map(lead => (
                      <TR
                        key={lead.id}
                        onClick={() => {
                          setSelectedLeadId(lead.id);
                          fetchLeadDetails(lead.id);
                        }}
                        className="cursor-pointer"
                      >
                        <TD>
                          <div className="font-medium">{lead.name || 'N/A'}</div>
                          {lead.jobTitle && <div className="mt-0.5 text-xs text-text-muted">{lead.jobTitle}</div>}
                        </TD>
                        <TD className="text-text-sub">{lead.email}</TD>
                        <TD onClick={(e) => e.stopPropagation()}>
                          <div className="flex max-w-xs flex-wrap gap-1.5">
                            {(lead.groups || []).map((g: any) => (
                              <Badge key={g.groupId} tone="blue">
                                {g.group?.name}
                                <button
                                  type="button"
                                  onClick={() => handleRemoveFromGroup(lead.id, g.groupId)}
                                  className="-mr-0.5 cursor-pointer rounded-sm transition-colors hover:text-rose-600 dark:hover:text-rose-400"
                                  aria-label={`Remove from ${g.group?.name}`}
                                  title={`Remove from ${g.group?.name}`}
                                >
                                  <X size={12} />
                                </button>
                              </Badge>
                            ))}
                          </div>
                        </TD>
                        <TD className="text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              size="sm"
                              onClick={async () => {
                                try {
                                  const res = await fetch('/api/leads', {
                                    method: 'PUT',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ id: lead.id, isArchived: true })
                                  });
                                  if (res.ok) {
                                    reloadLeads();
                                    showToast('Prospect archived to resolve overlaps.');
                                  }
                                } catch (err) {
                                    console.error(err);
                                }
                              }}
                            >
                              Archive Lead
                            </Button>
                            {isAdmin && (
                              <Button
                                size="sm"
                                variant="ghost"
                                iconOnly
                                onClick={() => handleDeleteLead(lead.id)}
                                className={DELETE_ICON}
                                aria-label="Delete prospect"
                                title="Delete Prospect"
                              >
                                <Trash2 size={14} />
                              </Button>
                            )}
                          </div>
                        </TD>
                      </TR>
                    ))}
                    {leads.length === 0 && (
                      <tr>
                        <td colSpan={4} className={EMPTY_CELL}>
                          {emptyListMessage('No overlapping prospects found with the current cross-check filters.')}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </Table>
              </div>
              {paginationControls}
              </>
              )}
            </div>
          </div>
        )}

      </Card>

      {/* Slide-over Activity Timeline Drawer, in the body so it sits above the top bar */}
      <BodyPortal>
        <AnimatePresence>
          {selectedLeadId && (
            <>
              {/* Backdrop */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 0.4 }}
                exit={{ opacity: 0 }}
                onClick={() => setSelectedLeadId(null)}
                className="fixed inset-0 z-40 bg-slate-900/60 backdrop-blur-xs"
              />

              {/* Panel */}
              <motion.div
                initial={{ x: '100%' }}
                animate={{ x: 0 }}
                exit={{ x: '100%' }}
                transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                role="dialog"
                aria-modal="true"
                aria-labelledby="lead-timeline-title"
                className="fixed top-0 right-0 bottom-0 z-50 flex w-full max-w-lg flex-col border-l border-card-border bg-card shadow-[var(--float-shadow)] dark:shadow-2xl"
              >
                {/* Header */}
                <div className="flex items-start justify-between gap-3 border-b border-card-border p-5">
                  <div>
                    <h2 id="lead-timeline-title" className="text-[15px] font-semibold text-text-main">Prospect Activity Timeline</h2>
                    <p className="mt-0.5 text-xs text-text-sub">Comprehensive audit trail of sent campaigns and response history.</p>
                  </div>
                  <Button size="sm" variant="ghost" iconOnly onClick={() => setSelectedLeadId(null)} aria-label="Close timeline">
                    <X size={16} />
                  </Button>
                </div>

                {/* Content */}
                <div className="flex-1 space-y-6 overflow-y-auto p-5">
                  {loadingDetails ? (
                    <div className="space-y-3 py-20 text-center text-xs text-text-muted">
                      <Loader2 size={20} className="mx-auto animate-spin" />
                      <p>Syncing prospect timeline logs...</p>
                    </div>
                  ) : leadDetails ? (
                    <>
                      {/* Lead Profile Info Card */}
                      <div className="space-y-3 rounded-control border border-card-border p-4">
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <h3 className="text-sm font-semibold text-text-main">{leadDetails.name || 'Anonymous Prospect'}</h3>
                            {leadDetails.jobTitle && (
                              <p className="mt-0.5 text-xs text-text-sub">{leadDetails.jobTitle}</p>
                            )}
                          </div>
                          <ValidationBadge status={leadDetails.validationStatus} />
                        </div>

                        <div className="grid grid-cols-2 gap-4 border-t border-card-border pt-3 text-xs">
                          <div>
                            <span className={FIELD_LABEL}>Email Address</span>
                            <p className="mt-0.5 break-all text-text-main">{leadDetails.email}</p>
                          </div>
                          <div>
                            <span className={FIELD_LABEL}>Company</span>
                            <p className="mt-0.5 font-medium text-text-main">{leadDetails.company || 'N/A'}</p>
                          </div>
                        </div>

                        {/* Suppression List entry: shown whatever the CRM status says; only an admin removes it */}
                        {leadDetails.suppression && (
                          <div className="space-y-2 border-t border-card-border pt-3">
                            <div className="flex items-center justify-between gap-3">
                              <span className={FIELD_LABEL}>Suppression List</span>
                              <SuppressionChip lead={leadDetails} />
                            </div>
                            <p className="text-xs leading-relaxed text-text-sub">
                              {describeSuppression(leadDetails.suppression)}{' '}
                              {OPT_OUT_REASONS.includes(leadDetails.suppression.reason)
                                ? "ArcReach never emails this address: campaigns never enroll it and Unibox replies to it are blocked, whatever the lead's status."
                                : "Campaigns never enroll or email this address, whatever the lead's status."}
                            </p>
                            {isAdmin ? (
                              <Button size="sm" variant="danger" onClick={() => handleRemoveSuppression(leadDetails)}>
                                Remove From List
                              </Button>
                            ) : (
                              <p className="text-[11px] text-text-muted">Only an admin can remove an address from the suppression list.</p>
                            )}
                          </div>
                        )}

                        {/* Groups Management */}
                        <div className="border-t border-card-border pt-3">
                          <span className={FIELD_LABEL}>Group Memberships</span>
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {groups.map(group => {
                              const isMember = (leadDetails.groups || []).some((g: any) => g.groupId === group.id);
                              return (
                                <button
                                  key={group.id}
                                  type="button"
                                  aria-pressed={isMember}
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
                                        reloadLeads();
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
                                  className={cn(TOGGLE, 'h-6 px-2 text-[11px]', isMember ? TOGGLE_ON : TOGGLE_OFF)}
                                >
                                  {group.name}
                                </button>
                              );
                            })}
                            {groups.length === 0 && (
                              <span className="text-[11px] text-text-muted">{groupsError ? 'Lead groups could not be loaded.' : 'No lead groups created yet.'}</span>
                            )}
                          </div>
                        </div>

                        {/* Archive Status */}
                        <div className="flex items-center justify-between border-t border-card-border pt-3">
                          <span className={FIELD_LABEL}>Archiving Status</span>
                          <Button
                            size="sm"
                            variant={leadDetails.isArchived ? 'primary' : 'secondary'}
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
                                  // It moves to the other tab
                                  deselectLead(updatedLead.id);
                                  reloadLeads();
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
                          >
                            <Archive size={14} />
                            {leadDetails.isArchived ? 'Restore Prospect' : 'Archive Prospect'}
                          </Button>
                        </div>
                      </div>

                      {/* Timeline Events List */}
                      <div className="space-y-4">
                        <h3 className="text-[13px] font-semibold text-text-main">Activity Audit Log</h3>

                        {getTimeline().length === 0 ? (
                          <p className="py-6 text-center text-xs text-text-muted">No outbound campaigns or inbound responses recorded for this lead yet.</p>
                        ) : (
                          <div className="relative ml-3 space-y-4 border-l-2 border-card-border pl-5">
                            {getTimeline().map((event: any) => {
                              const isExpanded = expandedEmailId === event.id;
                              const isDispatch = event.type === 'dispatch';

                              // Check events
                              const opens = event.events.filter((ev: any) => ev.eventType === 'open').length;
                              const clicks = event.events.filter((ev: any) => ev.eventType === 'click').length;

                              return (
                                <div key={event.id} className="relative">
                                  {/* Dot Indicator */}
                                  <span
                                    aria-hidden
                                    className={cn(
                                      'absolute top-3 -left-[27px] size-3 rounded-full border-2 bg-card',
                                      isDispatch ? 'border-primary' : 'border-emerald-500',
                                    )}
                                  />

                                  {/* Event Card */}
                                  <div className="space-y-2 rounded-control border border-card-border p-3.5">
                                    {/* Header */}
                                    <div className="flex flex-col justify-between gap-1 text-[11px] text-text-muted sm:flex-row sm:items-center">
                                      <span className="flex items-center gap-1.5 font-medium text-text-sub">
                                        {isDispatch ? <Mail size={12} aria-hidden /> : <MessageSquare size={12} aria-hidden />}
                                        {isDispatch
                                          ? `Sent via ${event.campaign}${event.stepOrder ? ` · Step ${event.stepOrder}` : ''}`
                                          : 'Lead Inbound Reply'
                                        }
                                      </span>
                                      <span className="flex items-center gap-1">
                                        <Clock size={12} aria-hidden />
                                        {event.date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
                                      </span>
                                    </div>

                                    {/* Subject */}
                                    <h4 className="text-[13px] leading-snug font-semibold text-text-main">{event.subject}</h4>

                                    {/* Delivery and engagement */}
                                    {isDispatch && (
                                      <div className="flex flex-wrap gap-1.5">
                                        {event.status === 'Failed' ? (
                                          <Badge tone="red"><Ban size={12} aria-hidden />Failed</Badge>
                                        ) : event.status === 'Sending' ? (
                                          <Badge tone="amber"><Hourglass size={12} aria-hidden />Sending</Badge>
                                        ) : event.status === 'Unknown' ? (
                                          <Badge><MailQuestionMark size={12} aria-hidden />Unconfirmed</Badge>
                                        ) : event.deliveredAt ? (
                                          <Badge tone="green"><CheckCircle2 size={12} aria-hidden />Delivered</Badge>
                                        ) : (
                                          <Badge><Mail size={12} aria-hidden />Sent</Badge>
                                        )}
                                        {opens > 0 && (
                                          <Badge tone="blue"><Eye size={12} aria-hidden />Opened ({opens})</Badge>
                                        )}
                                        {clicks > 0 && (
                                          <Badge tone="blue"><MousePointerClick size={12} aria-hidden />Clicked ({clicks})</Badge>
                                        )}
                                      </div>
                                    )}

                                    {/* Body Toggle Button */}
                                    <button
                                      type="button"
                                      aria-expanded={isExpanded}
                                      onClick={() => setExpandedEmailId(isExpanded ? null : event.id)}
                                      className="flex cursor-pointer items-center gap-1 text-xs font-medium text-primary hover:underline"
                                    >
                                      {isExpanded ? 'Hide email copy' : 'View email copy'}
                                      {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                                    </button>

                                    {/* Body copy container — plain text only; bodies are untrusted HTML */}
                                    {isExpanded && (
                                      <div className="max-h-56 overflow-y-auto rounded-control border border-card-border bg-slate-50 p-3 text-xs leading-relaxed break-words whitespace-pre-wrap text-text-sub dark:bg-white/[0.02]">
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
                    <div className="space-y-3 py-10 text-center text-xs">
                      <p className="font-medium text-rose-600 dark:text-rose-400">{leadDetailsError || 'This lead could not be loaded.'}</p>
                      {selectedLeadId && (
                        <Button size="sm" onClick={() => fetchLeadDetails(selectedLeadId)}>
                          <RefreshCw size={14} />
                          Retry
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </BodyPortal>

      {/* Floating Bulk Actions Bar */}
      <AnimatePresence>
        {selectedLeads.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 50, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 50, scale: 0.95 }}
            role="toolbar"
            aria-label="Selected leads"
            className="fixed bottom-6 left-1/2 z-45 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center gap-2 rounded-card border border-card-border bg-card px-3 py-2 shadow-[0_8px_24px_rgba(15,23,42,0.14)]"
          >
            <span className="border-r border-card-border pr-3 text-xs font-medium text-text-main">
              {selectedLeads.length} selected
            </span>
            {activeTab === 'suppressed' ? (
              <Button size="sm" onClick={handleBulkReactivateLeads}>
                <RefreshCw size={14} />
                Re-activate
              </Button>
            ) : (
              <Button size="sm" onClick={handleBulkVerify} disabled={isVerifying}>
                <Globe size={14} />
                Check Domain MX
              </Button>
            )}
            <Button size="sm" onClick={() => handleBulkArchiveLeads(activeTab !== 'archived')}>
              <Archive size={14} />
              {activeTab === 'archived' ? 'Unarchive' : 'Archive'}
            </Button>
            {isAdmin && (
              <Button size="sm" variant="danger" onClick={handleBulkDeleteLeads}>
                <Trash2 size={14} />
                Delete
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setSelectedLeads([])}>
              Clear
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Delete All Leads Confirmation Modal */}
      <BodyPortal>
        <AnimatePresence>
          {showDeleteAllConfirm && (
            <>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 0.5 }}
                exit={{ opacity: 0 }}
                onClick={() => setShowDeleteAllConfirm(false)}
                className="fixed inset-0 z-50 bg-black backdrop-blur-xs"
              />
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 20 }}
                role="dialog"
                aria-modal="true"
                aria-labelledby="delete-all-title"
                className={MODAL}
              >
                <h2 id="delete-all-title" className="mb-2 flex items-center gap-2 text-base font-semibold text-text-main">
                  <AlertCircle size={18} className="text-rose-600 dark:text-rose-400" />
                  Delete All Leads
                </h2>
                <p className="mb-4 text-[13px] leading-relaxed text-text-sub">
                  This action will permanently delete all leads, including their activity history, replies, and group memberships. This cannot be undone.
                </p>
                <label htmlFor="delete-all-confirm" className={LABEL}>
                  Type <span className="font-semibold text-rose-600 dark:text-rose-400">DELETE</span> to confirm:
                </label>
                <input
                  id="delete-all-confirm"
                  type="text"
                  placeholder="DELETE"
                  value={deleteAllConfirmText}
                  onChange={(e) => setDeleteAllConfirmText(e.target.value)}
                  className={inputClasses('h-9 focus:border-rose-500 focus:ring-rose-500/20')}
                />
                <div className="mt-6 flex justify-end gap-2 border-t border-card-border pt-4">
                  <Button variant="ghost" onClick={() => setShowDeleteAllConfirm(false)}>
                    Cancel
                  </Button>
                  <Button variant="danger" onClick={handleDeleteAllLeads} disabled={deleteAllConfirmText !== 'DELETE'}>
                    <Trash2 size={14} />
                    Confirm Delete All
                  </Button>
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </BodyPortal>

      {/* Group Deletion Option Modal */}
      <BodyPortal>
        <AnimatePresence>
          {groupToDelete && (
            <>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 0.5 }}
                exit={{ opacity: 0 }}
                onClick={() => setGroupToDelete(null)}
                className="fixed inset-0 z-50 bg-black backdrop-blur-xs"
              />
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 20 }}
                role="dialog"
                aria-modal="true"
                aria-labelledby="delete-group-title"
                className={MODAL}
              >
                <h2 id="delete-group-title" className="mb-2 text-base font-semibold break-words text-text-main">
                  Delete Group: {groupToDelete.name}
                </h2>
                <p className="mb-4 text-[13px] leading-relaxed text-text-sub">
                  Decide what to do with the prospects currently assigned to this group:
                </p>

                <div className="space-y-2">
                  {/* KEEP option */}
                  <label className={RADIO_ROW}>
                    <input
                      type="radio"
                      name="disposalAction"
                      value="KEEP"
                      checked={leadDisposalAction === 'KEEP'}
                      onChange={() => setLeadDisposalAction('KEEP')}
                      className="mt-0.5 cursor-pointer accent-primary"
                    />
                    <div>
                      <span className="block text-[13px] font-medium text-text-main">Keep leads in CRM</span>
                      <span className="mt-0.5 block text-xs text-text-sub">Retains leads in the database and removes them from this group only.</span>
                    </div>
                  </label>

                  {/* DELETE option (admin only) */}
                  {isAdmin && (
                    <label className={RADIO_ROW}>
                      <input
                        type="radio"
                        name="disposalAction"
                        value="DELETE"
                        checked={leadDisposalAction === 'DELETE'}
                        onChange={() => setLeadDisposalAction('DELETE')}
                        className="mt-0.5 cursor-pointer accent-rose-600"
                      />
                      <div>
                        <span className="block text-[13px] font-medium text-rose-600 dark:text-rose-400">Delete associated leads</span>
                        <span className="mt-0.5 block text-xs text-text-sub">Permanently deletes all leads in this group from the CRM database.</span>
                      </div>
                    </label>
                  )}

                  {/* MOVE option */}
                  <label className={RADIO_ROW}>
                    <input
                      type="radio"
                      name="disposalAction"
                      value="MOVE"
                      checked={leadDisposalAction === 'MOVE'}
                      onChange={() => setLeadDisposalAction('MOVE')}
                      className="mt-0.5 cursor-pointer accent-primary"
                    />
                    <div className="w-full">
                      <span className="block text-[13px] font-medium text-text-main">Move leads to another group</span>
                      <span className="mt-0.5 block text-xs text-text-sub">Transfer all leads to a different existing group.</span>

                      {leadDisposalAction === 'MOVE' && (
                        <div className="mt-2.5" onClick={(e) => e.stopPropagation()}>
                          <select
                            aria-label="Target group"
                            value={disposalTargetGroupId}
                            onChange={(e) => setDisposalTargetGroupId(e.target.value)}
                            className={inputClasses('cursor-pointer')}
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

                <div className="mt-6 flex justify-end gap-2 border-t border-card-border pt-4">
                  <Button variant="ghost" onClick={() => setGroupToDelete(null)}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    onClick={handleExecuteDeleteGroup}
                    disabled={leadDisposalAction === 'MOVE' && !disposalTargetGroupId}
                  >
                    Confirm Delete Group
                  </Button>
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </BodyPortal>

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
