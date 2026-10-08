import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { UnauthorizedError, unauthorizedResponse } from '@/lib/sessionError';
import { isPlainObject } from '@/lib/updateAllowList';
import {
  GroupAddError,
  LEAD_SETS,
  addLeadSetToGroup,
  campaignsByGroup,
  exportLeadSet,
  isLeadSet,
  leadSetCounts,
} from '@/lib/campaignLeadExport';

const SET_ERROR = `set must be one of ${LEAD_SETS.join(', ')}.`;

/** The campaign when the caller may see it (its owner, or an admin), else the response that says why not. */
async function campaignFor(id: string): Promise<{ campaign: { id: string } } | { response: NextResponse }> {
  const session = await getSession();
  const campaign = await prisma.campaign.findUnique({ where: { id }, select: { id: true, userId: true } });
  if (!campaign) return { response: NextResponse.json({ error: 'Campaign not found.' }, { status: 404 }) };
  if (session.role !== 'ADMIN' && campaign.userId !== session.id) {
    return { response: NextResponse.json({ error: 'Unauthorized access to this campaign.' }, { status: 403 }) };
  }
  return { campaign };
}

/**
 * The campaign's lead lists (lib/campaignLeadExport), for the campaign page's
 * Export Leads card. Without `set`: how many leads each list holds
 * (`counts`), and how many campaigns target each lead group (`groupCampaigns`,
 * by group id), since a lead added to a group is enrolled in them. With
 * `?set=delivered` or `?set=engaged`: that list's leads, which the page turns
 * into a CSV file. Changes nothing.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const found = await campaignFor(id);
    if ('response' in found) return found.response;

    const set = new URL(req.url).searchParams.get('set');
    if (set === null) {
      const [counts, groupCampaigns] = await Promise.all([leadSetCounts(prisma, id), campaignsByGroup(prisma)]);
      return NextResponse.json({ counts, groupCampaigns });
    }
    if (!isLeadSet(set)) return NextResponse.json({ error: SET_ERROR }, { status: 400 });
    return NextResponse.json({ leads: await exportLeadSet(prisma, id, set) });
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * Adds one of the campaign's lead lists to a lead group: `{ set, groupId }`
 * for an existing group, or `{ set, groupName }` for a new one. Joining a
 * group enrolls the leads in the campaigns that target it. Answers the group
 * and how many leads joined it or were in it already.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const found = await campaignFor(id);
    if ('response' in found) return found.response;

    const body = await req.json().catch(() => null);
    if (!isPlainObject(body)) return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 });
    if (!isLeadSet(body.set)) return NextResponse.json({ error: SET_ERROR }, { status: 400 });

    return NextResponse.json(await addLeadSetToGroup(id, body.set, { groupId: body.groupId, groupName: body.groupName }));
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    if (error instanceof GroupAddError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
