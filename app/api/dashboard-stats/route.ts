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

    // Filter enrollments by period (using enrolledAt)
    const enrollmentWhere = session.role !== 'ADMIN' ? {
      lead: {
        enrollments: {
          some: {
            campaign: {
              userId: session.id
            }
          }
        }
      }
    } : {};

    // 1. Get current period stats
    const totalSent = await prisma.emailDispatch.count({
      where: {
        ...dispatchWhere,
        sentAt: { gte: startOfCurrentPeriod, lte: now }
      }
    });

    const dispatchesWithOpens = await prisma.emailDispatch.count({
      where: {
        ...dispatchWhere,
        sentAt: { gte: startOfCurrentPeriod, lte: now },
        events: {
          some: { eventType: 'open' }
        }
      }
    });

    const dispatchesWithClicks = await prisma.emailDispatch.count({
      where: {
        ...dispatchWhere,
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

    const bouncedCount = await prisma.campaignEnrollment.count({
      where: { 
        ...enrollmentWhere, 
        status: 'Bounced',
        enrolledAt: { gte: startOfCurrentPeriod, lte: now }
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
        sentAt: { gte: startOfPriorPeriod, lt: startOfCurrentPeriod }
      }
    });

    const priorOpens = await prisma.emailDispatch.count({
      where: {
        ...dispatchWhere,
        sentAt: { gte: startOfPriorPeriod, lt: startOfCurrentPeriod },
        events: {
          some: { eventType: 'open' }
        }
      }
    });

    const priorClicks = await prisma.emailDispatch.count({
      where: {
        ...dispatchWhere,
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

    // 3. Fetch daily trends for the selected range period
    const trendDispatches = await prisma.emailDispatch.findMany({
      where: {
        ...dispatchWhere,
        sentAt: { gte: startOfCurrentPeriod, lte: now }
      },
      include: {
        events: true
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
      trends
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
