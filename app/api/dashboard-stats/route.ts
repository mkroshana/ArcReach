import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    
    // Filter scopes
    let campaignWhere = {};
    let senderAccountWhere = {};
    let dispatchWhere = {};
    let inboundWhere = {};
    let enrollmentWhere: any = {};

    if (session.role !== 'ADMIN') {
      campaignWhere = { userId: session.id };
      senderAccountWhere = { userId: session.id };
      dispatchWhere = {
        lead: {
          enrollments: {
            some: {
              campaign: {
                userId: session.id
              }
            }
          }
        }
      };
      inboundWhere = {
        lead: {
          enrollments: {
            some: {
              campaign: {
                userId: session.id
              }
            }
          }
        }
      };
      enrollmentWhere = { campaign: { userId: session.id } };
    }

    const { searchParams } = new URL(req.url);
    const rangeParam = searchParams.get('range') || '7';
    const rangeDays = parseInt(rangeParam) || 7;

    const now = new Date();
    
    // Current period window
    const startOfCurrentPeriod = new Date();
    startOfCurrentPeriod.setDate(now.getDate() - rangeDays);
    startOfCurrentPeriod.setHours(0, 0, 0, 0);

    // Prior period window of equal length
    const startOfPriorPeriod = new Date();
    startOfPriorPeriod.setDate(now.getDate() - (rangeDays * 2));
    startOfPriorPeriod.setHours(0, 0, 0, 0);



    // 1. Get current period stats (only count emails actually sent, not failed attempts)
    const totalSent = await prisma.emailDispatch.count({
      where: {
        ...dispatchWhere,
        status: 'Sent',
        sentAt: { gte: startOfCurrentPeriod, lte: now }
      }
    });

    const dispatchesWithOpens = await prisma.emailDispatch.count({
      where: {
        ...dispatchWhere,
        status: 'Sent',
        sentAt: { gte: startOfCurrentPeriod, lte: now },
        events: {
          some: { eventType: 'open' }
        }
      }
    });

    const dispatchesWithClicks = await prisma.emailDispatch.count({
      where: {
        ...dispatchWhere,
        status: 'Sent',
        sentAt: { gte: startOfCurrentPeriod, lte: now },
        events: {
          some: { eventType: 'click' }
        }
      }
    });

    const totalReplies = await prisma.inboundResponse.count({
      where: {
        ...inboundWhere,
        receivedAt: { gte: startOfCurrentPeriod, lte: now }
      }
    });

    const failedCount = await prisma.campaignEnrollment.count({
      where: { 
        ...enrollmentWhere, 
        status: 'Failed',
        enrolledAt: { gte: startOfCurrentPeriod, lte: now }
      }
    });

    // Hard bounces the Azure delivery webhook reported in this period, counted
    // on the dispatch by the campaign that sent it, so a bounce of a last step
    // (whose enrollment is already Completed) counts too.
    const bouncedCount = await prisma.emailDispatch.count({
      where: {
        ...(session.role !== 'ADMIN' ? { campaign: { userId: session.id } } : {}),
        bounceType: 'hard',
        bouncedAt: { gte: startOfCurrentPeriod, lte: now }
      }
    });

    const unsubscribedCount = await prisma.campaignEnrollment.count({
      where: { 
        ...enrollmentWhere, 
        lead: { status: 'Unsubscribed' },
        enrolledAt: { gte: startOfCurrentPeriod, lte: now }
      }
    });

    const averageOpenRate = totalSent > 0 ? (dispatchesWithOpens / totalSent) * 100 : 0;
    const averageClickRate = totalSent > 0 ? (dispatchesWithClicks / totalSent) * 100 : 0;

    // 2. Get prior period stats for delta comparison
    const priorSent = await prisma.emailDispatch.count({
      where: {
        ...dispatchWhere,
        status: 'Sent',
        sentAt: { gte: startOfPriorPeriod, lt: startOfCurrentPeriod }
      }
    });

    const priorOpens = await prisma.emailDispatch.count({
      where: {
        ...dispatchWhere,
        status: 'Sent',
        sentAt: { gte: startOfPriorPeriod, lt: startOfCurrentPeriod },
        events: {
          some: { eventType: 'open' }
        }
      }
    });

    const priorClicks = await prisma.emailDispatch.count({
      where: {
        ...dispatchWhere,
        status: 'Sent',
        sentAt: { gte: startOfPriorPeriod, lt: startOfCurrentPeriod },
        events: {
          some: { eventType: 'click' }
        }
      }
    });

    const priorReplies = await prisma.inboundResponse.count({
      where: {
        ...inboundWhere,
        receivedAt: { gte: startOfPriorPeriod, lt: startOfCurrentPeriod }
      }
    });

    const priorOpenRate = priorSent > 0 ? (priorOpens / priorSent) * 100 : 0;
    const priorClickRate = priorSent > 0 ? (priorClicks / priorSent) * 100 : 0;

    // Helper to calculate percentage change
    const calculateDelta = (current: number, prior: number): number => {
      if (prior === 0) {
        return current > 0 ? 100 : 0;
      }
      return Number((((current - prior) / prior) * 100).toFixed(1));
    };

    const sentDelta = calculateDelta(totalSent, priorSent);
    const openRateDelta = calculateDelta(averageOpenRate, priorOpenRate);
    const clickRateDelta = calculateDelta(averageClickRate, priorClickRate);
    const repliesDelta = calculateDelta(totalReplies, priorReplies);

    // 3. Fetch daily trends for the selected range period.
    // Select ONLY what the bucketing needs — a bare findMany here returned
    // every dispatch's full HTML body (~100KB each), which at thousands of
    // sends per day meant ~GB-scale payloads on every 30s dashboard poll
    // and OOM'd the server.
    const trendDispatches = await prisma.emailDispatch.findMany({
      where: {
        ...dispatchWhere,
        status: 'Sent',
        sentAt: { gte: startOfCurrentPeriod, lte: now }
      },
      select: {
        sentAt: true,
        events: { select: { eventType: true } },
      }
    });

    // Generate daily buckets
    const dailyBuckets: Record<string, { name: string; sent: number; opens: number; clicks: number }> = {};
    for (let i = rangeDays - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const label = d.toLocaleDateString('en-US', { day: '2-digit', month: 'short' });
      dailyBuckets[label] = { name: label, sent: 0, opens: 0, clicks: 0 };
    }

    trendDispatches.forEach(dispatch => {
      const label = new Date(dispatch.sentAt).toLocaleDateString('en-US', { day: '2-digit', month: 'short' });
      if (dailyBuckets[label]) {
        dailyBuckets[label].sent++;
        if (dispatch.events.some(e => e.eventType === 'open')) {
          dailyBuckets[label].opens++;
        }
        if (dispatch.events.some(e => e.eventType === 'click')) {
          dailyBuckets[label].clicks++;
        }
      }
    });

    const trends = Object.values(dailyBuckets);

    // 4. Funnel and Sentiment breakdown
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

    const funnel = [
      { name: 'Sent', value: totalSent },
      { name: 'Opened', value: dispatchesWithOpens },
      { name: 'Clicked', value: dispatchesWithClicks },
      { name: 'Replied', value: totalReplies },
      { name: 'Meeting Booked', value: meetingBookedCount }
    ];

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
        totalSent,
        totalReplies,
        averageOpenRate: Number(averageOpenRate.toFixed(1)),
        averageClickRate: Number(averageClickRate.toFixed(1)),
        failed: failedCount,
        bounced: bouncedCount,
        unsubscribed: unsubscribedCount,
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
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
