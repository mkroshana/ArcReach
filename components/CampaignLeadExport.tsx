/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
'use client';

import React, { useEffect, useState } from 'react';
import { Download, FolderPlus, Loader2, RefreshCw, Users } from 'lucide-react';
import {
  Alert, Box, Button, Card, CardContent, Dialog, DialogActions, DialogContent, DialogTitle,
  FormControl, InputLabel, MenuItem, Select, Stack, TextField, ToggleButton, ToggleButtonGroup, Typography,
} from '@mui/material';
import { useToast } from '@/components/Toast';
import { downloadCsv, toCsv } from '@/lib/csv';
import { loadErrorMessage, readJsonObject, responseErrorMessage } from '@/lib/apiResponse';

type LeadSet = 'delivered' | 'engaged';

/** The two lists (lib/campaignLeadExport), as the card names and explains them. */
const LISTS: Array<{ set: LeadSet; title: string; meaning: string }> = [
  { set: 'delivered', title: 'Delivered', meaning: "At least one of this campaign's emails was delivered to them." },
  { set: 'engaged', title: 'Engaged', meaning: "They replied, or opened or clicked one of this campaign's emails." },
];

const CSV_COLUMNS = [
  { key: 'email', label: 'Email' },
  { key: 'name', label: 'Name' },
  { key: 'company', label: 'Company' },
  { key: 'jobTitle', label: 'Job Title' },
  { key: 'status', label: 'Status' },
  { key: 'delivered', label: 'Emails Delivered' },
  { key: 'opened', label: 'Opened' },
  { key: 'clicked', label: 'Clicked' },
  { key: 'replied', label: 'Replied' },
];

const yesNo = (value: unknown) => (value ? 'Yes' : 'No');
const leadCount = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'lead' : 'leads'}`;
/** A file name part from a campaign's name: its letters and digits, hyphenated. */
const fileNamePart = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'campaign';

interface CampaignLeadExportProps {
  campaignId: string;
  campaignName: string;
  /** The lead groups, as GET /api/leads/groups lists them. */
  groups: Array<{ id: string; name: string; _count?: { leads?: number } }>;
  /** Called after a list was added to a group, so the page loads the groups again. */
  onGroupsChanged: () => void;
}

/**
 * The campaign's Delivered and Engaged leads (lib/campaignLeadExport): each
 * list can be exported as a CSV file or added to a lead group, an existing one
 * or a new one.
 */
export default function CampaignLeadExport({ campaignId, campaignName, groups, onGroupsChanged }: CampaignLeadExportProps) {
  const { toast: showToast } = useToast();
  const [counts, setCounts] = useState<Record<LeadSet, number> | null>(null);
  /** How many campaigns target each lead group, by group id. */
  const [groupCampaigns, setGroupCampaigns] = useState<Record<string, number>>({});
  const [loadError, setLoadError] = useState('');
  const [exporting, setExporting] = useState<LeadSet | null>(null);
  /** The list the Add To Group dialog is open for. */
  const [adding, setAdding] = useState<LeadSet | null>(null);
  const [target, setTarget] = useState<'existing' | 'new'>('existing');
  const [groupId, setGroupId] = useState('');
  const [groupName, setGroupName] = useState('');
  const [saving, setSaving] = useState(false);

  const loadCounts = async () => {
    let error = '';
    try {
      const data = await readJsonObject(await fetch(`/api/campaigns/${campaignId}/leads`), 'The lead lists');
      setCounts({ delivered: Number(data.counts?.delivered) || 0, engaged: Number(data.counts?.engaged) || 0 });
      setGroupCampaigns(data.groupCampaigns ?? {});
    } catch (err) {
      console.error(err);
      error = loadErrorMessage(err, 'The lead lists');
    }
    setLoadError(error);
  };

  useEffect(() => { loadCounts(); }, [campaignId]);

  const exportList = async (set: LeadSet) => {
    try {
      setExporting(set);
      const data = await readJsonObject(await fetch(`/api/campaigns/${campaignId}/leads?set=${set}`), 'The leads');
      const leads: any[] = Array.isArray(data.leads) ? data.leads : [];
      if (leads.length === 0) { showToast('This list has no leads to export.', 'warning'); return; }
      const rows = leads.map((lead) => ({ ...lead, opened: yesNo(lead.opened), clicked: yesNo(lead.clicked), replied: yesNo(lead.replied) }));
      downloadCsv(`${fileNamePart(campaignName)}-${set}-leads-${new Date().toISOString().split('T')[0]}.csv`, toCsv(rows, CSV_COLUMNS));
      showToast(`Exported ${leadCount(leads.length)} to CSV.`);
    } catch (err) {
      console.error(err);
      showToast(loadErrorMessage(err, 'The leads'), 'error');
    } finally { setExporting(null); }
  };

  const openAddDialog = (set: LeadSet) => {
    setAdding(set);
    setTarget(groups.length > 0 ? 'existing' : 'new');
    setGroupId('');
    setGroupName('');
  };

  const addToGroup = async () => {
    if (!adding) return;
    const name = groupName.trim();
    if (target === 'existing' ? !groupId : !name) {
      showToast(target === 'existing' ? 'Choose a lead group.' : 'Name the new lead group.', 'error');
      return;
    }
    try {
      setSaving(true);
      const res = await fetch(`/api/campaigns/${campaignId}/leads`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ set: adding, ...(target === 'existing' ? { groupId } : { groupName: name }) }),
      });
      if (!res.ok) { showToast(await responseErrorMessage(res, 'The leads could not be added to the group.'), 'error'); return; }
      const result = await res.json();
      const already = result.alreadyIn > 0 ? ` ${leadCount(result.alreadyIn)} ${result.alreadyIn === 1 ? 'was' : 'were'} in it already.` : '';
      showToast(`Added ${leadCount(result.added)} to "${result.group?.name}".${already}`);
      setAdding(null);
      onGroupsChanged();
      loadCounts();
    } catch (err) {
      console.error(err);
      showToast('The leads could not be added to the group. Check your connection and try again.', 'error');
    } finally { setSaving(false); }
  };

  const addingList = LISTS.find((list) => list.set === adding);
  const addingCount = adding && counts ? counts[adding] : 0;
  const targetCampaigns = target === 'existing' && groupId ? groupCampaigns[groupId] ?? 0 : 0;

  return (
    <Card>
      <CardContent>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
          <Users size={16} color="#2563EB" />
          <Typography variant="overline" sx={{ fontWeight: 700, lineHeight: 1.6 }}>Export Leads</Typography>
        </Stack>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 2 }}>
          Export a list of this campaign&apos;s leads as a CSV file, or add it to a lead group. Leads that have since bounced, unsubscribed or been archived are left out.
        </Typography>

        {loadError ? (
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
            <Typography variant="caption" sx={{ color: 'error.main' }}>{loadError}</Typography>
            <Button size="small" variant="outlined" color="inherit" startIcon={<RefreshCw size={12} />} onClick={loadCounts}>Retry</Button>
          </Stack>
        ) : (
          <Stack spacing={1.5}>
            {LISTS.map((list) => {
              const count = counts?.[list.set];
              const empty = !count;
              return (
                <Stack key={list.set} direction={{ xs: 'column', sm: 'row' }} sx={{ gap: 1.5, alignItems: { sm: 'center' }, justifyContent: 'space-between', p: 1.5, border: 1, borderColor: 'divider', borderRadius: '12px' }}>
                  <Box>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline' }}>
                      <Typography variant="body2" sx={{ fontWeight: 700 }}>{list.title}</Typography>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>{count === undefined ? '…' : leadCount(count)}</Typography>
                    </Stack>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>{list.meaning}</Typography>
                  </Box>
                  <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
                    <Button size="small" variant="outlined" color="inherit" disabled={empty || exporting !== null} startIcon={exporting === list.set ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} onClick={() => exportList(list.set)}>
                      Export CSV
                    </Button>
                    <Button size="small" variant="outlined" disabled={empty} startIcon={<FolderPlus size={14} />} onClick={() => openAddDialog(list.set)}>
                      Add To Group
                    </Button>
                  </Stack>
                </Stack>
              );
            })}
          </Stack>
        )}
      </CardContent>

      <Dialog open={adding !== null} onClose={() => !saving && setAdding(null)} maxWidth="xs" fullWidth slotProps={{ paper: { sx: { borderRadius: '20px' } } }}>
        <DialogTitle>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
            <FolderPlus size={20} color="#2563EB" />
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Add {addingList?.title} Leads To A Group</Typography>
          </Stack>
        </DialogTitle>
        <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {leadCount(addingCount)} will join the group. Those already in it stay as they are.
          </Typography>
          <ToggleButtonGroup size="small" exclusive value={target} onChange={(_, value) => value && setTarget(value)}>
            <ToggleButton value="existing" disabled={groups.length === 0} sx={{ fontSize: 11, fontWeight: 700 }}>Existing Group</ToggleButton>
            <ToggleButton value="new" sx={{ fontSize: 11, fontWeight: 700 }}>New Group</ToggleButton>
          </ToggleButtonGroup>
          {target === 'existing' ? (
            <FormControl size="small" fullWidth>
              <InputLabel>Lead Group</InputLabel>
              <Select label="Lead Group" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                {groups.map((group) => (
                  <MenuItem key={group.id} value={group.id}>{group.name} ({(group._count?.leads ?? 0).toLocaleString()})</MenuItem>
                ))}
              </Select>
            </FormControl>
          ) : (
            <TextField size="small" fullWidth label="Group Name" value={groupName} onChange={(e) => setGroupName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addToGroup(); }} />
          )}
          {targetCampaigns > 0 && (
            <Alert severity="warning" sx={{ fontSize: 12 }}>
              {targetCampaigns === 1 ? 'A campaign targets' : `${targetCampaigns} campaigns target`} this group. These leads will be enrolled in {targetCampaigns === 1 ? 'it' : 'them'}, and an Active campaign starts emailing them.
            </Alert>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button color="inherit" disabled={saving} onClick={() => setAdding(null)}>Cancel</Button>
          <Button variant="contained" disabled={saving} startIcon={saving ? <Loader2 size={14} className="animate-spin" /> : <FolderPlus size={14} />} onClick={addToGroup}>
            {saving ? 'Adding…' : 'Add To Group'}
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}
