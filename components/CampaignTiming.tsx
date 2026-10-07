'use client';

import { useState, type ReactNode } from 'react';
import { Clock } from 'lucide-react';
import { Box, Card, CardContent, Stack, Typography } from '@mui/material';
import { useNow } from '@/hooks/use-now';
import { savedScheduleNote } from '@/lib/campaignPause';
import { hasSendingSchedule, isValidTimezone } from '@/lib/sendSchedule';
import { timeAgo } from '@/lib/systemStatus';
import {
  bothZones, durationText, earliestFinish, scheduleSummary, sendTime, viewerTimeZone, windowState, zoneDifferenceText, zoneLabel, zonedClock, zonedDate,
} from '@/lib/campaignTiming';

/**
 * The campaign page's Timing panel: the current time, the saved sending window
 * and when it opens or closes, when the next email goes and the last one went,
 * and the earliest the sequence can finish. It reads the campaign as the server
 * returned it, so the window is the saved one the send engine uses, not unsaved
 * edits on the Schedule tab. Every date and time is given in the campaign's
 * time zone and, where that reads differently, in the viewer's.
 */

type Item = { label: string; value: ReactNode; tone?: 'success' | 'warning'; lines: Array<string | null | undefined> };

const MINUTE_MS = 60_000;

/** A valid date from an API value, or null. */
function instant(value: unknown): Date | null {
  if (!value) return null;
  const at = new Date(value as string);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * "in 6h 18m" until `to`, counted down each second; nothing once it has passed.
 * For a time shown beside it that the page worked out when it last loaded.
 */
export function Countdown({ to }: { to: Date | string }) {
  const now = useNow();
  const left = now ? new Date(to).getTime() - now.getTime() : 0;
  return left > 0 ? <>in {durationText(left)}</> : null;
}

export default function CampaignTiming({ campaign }: { campaign: any }) {
  // This panel is only shown once the campaign has loaded in the browser, so its first time is the browser's.
  const [openedAt] = useState(() => new Date());
  const now = useNow() ?? openedAt;

  const status: string = campaign?.status ?? 'Draft';
  const campaignZone: string = campaign?.timezone;
  const zoneKnown = isValidTimezone(campaignZone);
  const viewerZone = viewerTimeZone();
  const viewerDifference = zoneKnown ? zoneDifferenceText(now, viewerZone, campaignZone) : null;
  const progress = campaign?.telemetry?.progress ?? {};

  /** An instant in the campaign's zone and, when it reads differently there, in the viewer's. */
  const times = (at: Date): string[] => {
    const both = bothZones(at, campaignZone, viewerZone);
    return both.viewer ? [both.campaign, `${both.viewer} your time`] : [both.campaign];
  };

  /** A zone's name with its short name and offset; UTC needs no more than its name. */
  const zoneLine = (zone: string) => (zone === 'UTC' ? 'UTC' : `${zone} · ${zoneLabel(now, zone)}`);

  const items: Item[] = [];

  // 1. Now
  items.push({
    label: viewerDifference ? 'Campaign Time' : 'Current Time',
    value: zonedClock(now, campaignZone),
    lines: [
      zonedDate(now, campaignZone),
      zoneLine(zoneKnown ? campaignZone : viewerZone),
      zoneKnown ? (viewerDifference ? null : 'Your time zone reads the same') : 'The campaign has no valid time zone, so this is your time',
    ],
  });
  if (viewerDifference) {
    items.push({
      label: 'Your Time',
      value: zonedClock(now, viewerZone),
      // "9h 30m ahead of campaign time" or "3h 30m behind campaign time"
      lines: [zonedDate(now, viewerZone), zoneLine(viewerZone), `${viewerDifference}${viewerDifference.endsWith('ahead') ? ' of' : ''} campaign time`],
    });
  }

  // 2. The saved sending window
  const sendingWindow = windowState(campaignZone, campaign?.sendSchedule, now);
  const summary = scheduleSummary(campaign?.sendSchedule);
  const summaryLine = summary ? `${summary}, campaign time` : null;
  if (sendingWindow.state === 'none') {
    items.push({
      label: 'Sending Window', value: 'No Schedule', tone: 'warning',
      lines: [savedScheduleNote(campaign ?? {}) ?? 'No complete sending window is saved, so this campaign sends nothing.'],
    });
  } else if (sendingWindow.state === 'open') {
    const closesAt = sendingWindow.closesAt;
    items.push({
      label: 'Sending Window', tone: 'success',
      value: closesAt ? `Open · closes in ${durationText(closesAt.getTime() - now.getTime())}` : 'Open Around The Clock',
      // The end time is open to the end of its minute, so the last open minute is the one before the closing.
      lines: [...(closesAt ? times(new Date(closesAt.getTime() - MINUTE_MS)).map((time, index) => (index === 0 ? `Until ${time}` : time)) : []), summaryLine],
    });
  } else {
    const opensAt = sendingWindow.opensAt;
    items.push({
      label: 'Sending Window',
      value: opensAt ? `Closed · opens in ${durationText(opensAt.getTime() - now.getTime())}` : 'Closed',
      lines: [...(opensAt ? times(opensAt) : ['The next opening could not be worked out']), summaryLine],
    });
  }

  // 3. The next email
  const nextDue = instant(progress.nextDueAt);
  if (status !== 'Active') {
    items.push({
      label: 'Next Send',
      value: status === 'Stopped' ? 'None While Stopped' : status === 'Paused' ? 'None While Paused' : 'Not Published',
      lines: [status === 'Stopped' ? 'Leads keep their place until a restart' : status === 'Paused' ? 'Leads keep their place until it is Active again' : 'A campaign that is not Active sends nothing'],
    });
  } else if (!nextDue) {
    items.push({ label: 'Next Send', value: 'No Lead Waiting', lines: [] });
  } else if (sendingWindow.state === 'none') {
    items.push({ label: 'Next Send', value: 'Held', tone: 'warning', lines: ['Nothing is sent without a sending schedule'] });
  } else if (nextDue.getTime() <= now.getTime()) {
    const due = Number(progress.dueNow) || 0;
    items.push({
      label: 'Next Send', value: 'Due Now',
      lines: [
        due > 0 ? `${due.toLocaleString()} ${due === 1 ? 'lead' : 'leads'} due` : null,
        sendingWindow.state === 'open' ? 'Goes out in the next send cycles, as the sending limits allow' : 'Held until the sending window opens',
      ],
    });
  } else {
    // A send date outside the window waits for the next opening after it, as the send engine makes it.
    const send = sendTime(campaignZone, campaign?.sendSchedule, nextDue);
    items.push({
      label: 'Next Send',
      value: `In ${durationText(send.at.getTime() - now.getTime())}`,
      lines: [...times(send.at), send.held ? `Due ${bothZones(nextDue, campaignZone, viewerZone).campaign}, then held for the window` : null],
    });
  }

  // 4. What has gone out
  const lastSent = instant(progress.lastSentAt);
  items.push({ label: 'Last Send', value: lastSent ? timeAgo(lastSent, now) : 'Never', lines: lastSent ? times(lastSent) : [] });
  const firstSent = instant(progress.firstSentAt);
  items.push({ label: 'First Send', value: firstSent ? timeAgo(firstSent, now) : 'Never', lines: firstSent ? times(firstSent) : [] });

  // 5. The earliest the sequence can finish
  const finish = status === 'Active' ? earliestFinish(campaign?.steps ?? [], campaign?.telemetry?.stepStats ?? [], now) : null;
  if (finish) {
    const left = finish.getTime() - now.getTime();
    items.push({
      label: 'Earliest Finish',
      value: left > MINUTE_MS ? `In ${durationText(left)}` : 'Now',
      lines: [...times(finish), 'By wait days alone; the sending window and limits can make it later'],
    });
  } else {
    items.push({
      label: 'Earliest Finish', value: '—',
      lines: [status === 'Active' ? 'No lead is waiting for a step' : status === 'Stopped' ? 'Nothing is sent while stopped' : status === 'Paused' ? 'Nothing is sent while paused' : 'Not published'],
    });
  }

  // 6. Status timers
  const resumesAt = status === 'Paused' ? instant(campaign?.pausedUntil) : null;
  if (resumesAt) {
    const left = resumesAt.getTime() - now.getTime();
    items.push({
      label: 'Auto-Resume', tone: 'warning',
      value: left > 0 ? `In ${durationText(left)}` : 'Any Moment',
      lines: [...times(resumesAt), hasSendingSchedule(campaignZone, campaign?.sendSchedule) ? null : 'Goes to Draft then: no sending schedule'],
    });
  }
  const stoppedAt = status === 'Stopped' ? instant(campaign?.stoppedAt) : null;
  if (stoppedAt) items.push({ label: 'Stopped', value: timeAgo(stoppedAt, now), lines: times(stoppedAt) });

  const createdAt = instant(campaign?.createdAt);
  const changedAt = instant(campaign?.updatedAt);
  if (createdAt) {
    items.push({
      label: 'Created', value: timeAgo(createdAt, now),
      lines: [...times(createdAt), changedAt ? `Last changed ${timeAgo(changedAt, now)}` : null],
    });
  }

  return (
    <Card>
      <CardContent sx={{ '&:last-child': { pb: 2 } }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} sx={{ justifyContent: 'space-between', alignItems: { sm: 'center' }, gap: 0.5, pb: 1.5, mb: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Clock size={16} color="#2563EB" />
            <Typography variant="overline" sx={{ fontWeight: 700, lineHeight: 1.6 }}>Timing</Typography>
          </Stack>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {viewerDifference ? "Dates and times are in the campaign's time zone, then in yours." : "Dates and times are in the campaign's time zone."}
          </Typography>
        </Stack>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(4, 1fr)' }, columnGap: 2.5, rowGap: 2 }}>
          {items.map((item) => (
            <Box key={item.label} sx={{ minWidth: 0 }}>
              <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block' }}>
                {item.label}
              </Typography>
              <Typography variant="body1" sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: item.tone ? `${item.tone}.main` : 'text.primary' }}>
                {item.value}
              </Typography>
              {item.lines.filter(Boolean).map((line, index) => (
                <Typography key={index} variant="caption" sx={{ color: 'text.secondary', display: 'block', lineHeight: 1.5, fontVariantNumeric: 'tabular-nums' }}>
                  {line}
                </Typography>
              ))}
            </Box>
          ))}
        </Box>
      </CardContent>
    </Card>
  );
}
