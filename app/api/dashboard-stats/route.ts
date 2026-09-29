import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { UnauthorizedError, unauthorizedResponse } from '@/lib/sessionError';
import {
  countReplies,
  dailyEngagement,
  engagementFunnel,
  healthSummary,
  metricsScopeFor,
  metricsWindow,
  sendSummary,
} from '@/lib/engagementMetrics';

/** Longest period the dashboard counts, in days (the page offers 7, 30 and 90). */
const MAX_RANGE_DAYS = 365;

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();

    // Non-admins count the sends of the campaigns they own and the replies
    // their mailboxes received, not everything sent to leads they share.
    const scope = metricsScopeFor(session);

    const { searchParams } = new URL(req.url);
    const rangeParam = searchParams.get('range') || '7';
    const rangeDays = Math.min(Math.max(parseInt(rangeParam) || 7, 1), MAX_RANGE_DAYS);

    // Today and the rangeDays - 1 days before it, compared with the rangeDays
    // days before that. The trend has one bucket per day of the same period.
    const periods = metricsWindow(rangeDays);

    // 1. Sends, opens and clicks of the emails sent in each period, and the
    // bounces, failed attempts, unsubscribes and replies that happened in it
    // (lib/engagementMetrics defines each, as on the campaign and Accounts
    // pages). All counted in the database, the daily trend included: loading
    // every dispatch in the period here OOM'd the server.
    const [current, prior, health, totalReplies, priorReplies, trends] = await Promise.all([
      sendSummary(prisma, scope, periods.current),
      sendSummary(prisma, scope, periods.prior),
      healthSummary(prisma, scope, periods.current),
      countReplies(prisma, scope, periods.current),
      countReplies(prisma, scope, periods.prior),
      dailyEngagement(prisma, scope, periods),
    ]);

    // 2. Percentage change against the prior period
    const calculateDelta = (value: number, priorValue: number): number => {
      if (priorValue === 0) {
        return value > 0 ? 100 : 0;
      }
      return Number((((value - priorValue) / priorValue) * 100).toFixed(1));
    };

    const sentDelta = calculateDelta(current.sent, prior.sent);
    const openRateDelta = calculateDelta(current.openRate, prior.openRate);
    const clickRateDelta = calculateDelta(current.clickRate, prior.clickRate);
    const repliesDelta = calculateDelta(totalReplies, priorReplies);

    // 3. Funnel and Sentiment breakdown
    const meetingBookedCount = await prisma.lead.count({
      where: {
        status: 'Meeting_Booked',
        isArchived: false,
        enrollments: session.role !== 'ADMIN' ? {
          some: {
            campaign: {
              userId: session.id
            }
          }
        } : undefined
      }
    });

    const sentimentGroups = await prisma.lead.groupBy({
      by: ['status'],
      where: {
        isArchived: false,
        enrollments: session.role !== 'ADMIN' ? {
          some: {
            campaign: {
              userId: session.id
            }
          }
        } : undefined
      },
      _count: {
        id: true
      }
    });

    const funnel = engagementFunnel({
      sent: current.sent,
      opened: current.opened,
      clicked: current.clicked,
      replies: totalReplies,
      meetingsBooked: meetingBookedCount
    });

    const sentimentBreakdown = [
      { name: 'Neutral', value: 0 },
      { name: 'Interested', value: 0 },
      { name: 'Not Interested', value: 0 },
      { name: 'Meeting Booked', value: 0 },
      { name: 'Out of Office', value: 0 },
      { name: 'Bounced', value: 0 },
      { name: 'Unsubscribed', value: 0 }
    ];

    sentimentGroups.forEach(g => {
      const nameMap: Record<string, string> = {
        'Neutral': 'Neutral',
        'Interested': 'Interested',
        'Not_Interested': 'Not Interested',
        'Meeting_Booked': 'Meeting Booked',
        'Out_of_Office': 'Out of Office',
        'Bounced': 'Bounced',
        'Unsubscribed': 'Unsubscribed'
      };
      const mappedName = nameMap[g.status] || g.status;
      const item = sentimentBreakdown.find(item => item.name === mappedName);
      if (item) {
        item.value = g._count.id;
      }
    });

    return NextResponse.json({
      stats: {
        totalSent: current.sent,
        totalReplies,
        averageOpenRate: current.openRate,
        averageClickRate: current.clickRate,
        failed: health.failed,
        bounced: health.bounced,
        unsubscribed: health.unsubscribed,
        deltas: {
          sent: sentDelta,
          openRate: openRateDelta,
          clickRate: clickRateDelta,
          replies: repliesDelta
        }
      },
      trends,
      funnel,
      sentiment: sentimentBreakdown
    });
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
