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

    // 1. Get total numbers
    const totalSent = await prisma.emailDispatch.count({
      where: dispatchWhere
    });

    const totalReplies = await prisma.inboundResponse.count({
      where: inboundWhere
    });

    // Total opens and clicks (distinct dispatches having corresponding events)
    const dispatchesWithOpens = await prisma.emailDispatch.count({
      where: {
        ...dispatchWhere,
        events: {
          some: {
            eventType: 'open'
          }
        }
      }
    });

    const dispatchesWithClicks = await prisma.emailDispatch.count({
      where: {
        ...dispatchWhere,
        events: {
          some: {
            eventType: 'click'
          }
        }
      }
    });

    const averageOpenRate = totalSent > 0 ? (dispatchesWithOpens / totalSent) * 100 : 0;
    const averageClickRate = totalSent > 0 ? (dispatchesWithClicks / totalSent) * 100 : 0;

    // Deliverability health across the workspace
    const failedCount = await prisma.campaignEnrollment.count({
      where: { ...enrollmentWhere, status: 'Failed' }
    });

    const bouncedCount = await prisma.campaignEnrollment.count({
      where: { ...enrollmentWhere, status: 'Bounced' }
    });

    const unsubscribedCount = await prisma.campaignEnrollment.count({
      where: { ...enrollmentWhere, lead: { status: 'Unsubscribed' } }
    });

    // 2. Fetch daily trends for the last 7 days
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const trendDispatches = await prisma.emailDispatch.findMany({
      where: {
        ...dispatchWhere,
        sentAt: { gte: sevenDaysAgo }
      },
      include: {
        events: true
      }
    });

    // Generate daily buckets
    const dailyBuckets: Record<string, { name: string; sent: number; opens: number; clicks: number }> = {};
    for (let i = 6; i >= 0; i--) {
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
      },
      trends
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
