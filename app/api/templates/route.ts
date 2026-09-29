import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { UnauthorizedError, unauthorizedResponse } from '@/lib/sessionError';

const seedTemplates = [
  {
    name: 'SaaS Cold Pitch',
    subject: '{Quick question|Simple query} regarding {{company}} outreach',
    body: 'Hi {{firstName}},\n\nI was looking at {{company}} and noticed you guys might be looking to scale your cold pipeline.\n\nWe help companies generate highly qualified meetings completely automated.\n\n{Let me know if you have 5 mins next week?|Would you be open to a quick chat?}\n\nBest,\nJohn',
    category: 'Cold Outreach'
  },
  {
    name: 'Friendly Bump (No response)',
    subject: 'Following up / {{firstName}} x ArcReach',
    body: 'Hey {{firstName}},\n\nI know you are super busy, so I wanted to give this a quick bump.\n\nDid you have a chance to look over my last email?\n\n{Best|Cheers},\nJohn',
    category: 'Follow Up'
  },
  {
    name: 'Value Offering / Case Study',
    subject: 'how we helped Stark Ind scale 3x',
    body: 'Hi {{firstName}},\n\nI thought you might find this interesting. We recently wrote a case study detailing how we helped marketing teams double their response rates in under 30 days.\n\nNo pitch - {here is the link|you can read it here}: [Link]\n\nHope this is helpful!\nJohn',
    category: 'Value Prep'
  }
];

export async function GET() {
  try {
    const session = await getSession();
    
    let templates = await prisma.template.findMany({
      orderBy: { createdAt: 'desc' }
    });

    // Auto seed templates if database table is blank
    if (templates.length === 0) {
      await prisma.template.createMany({
        data: seedTemplates
      });
      
      templates = await prisma.template.findMany({
        orderBy: { createdAt: 'desc' }
      });
    }

    return NextResponse.json(templates);
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    const data = await req.json();
    const { name, subject, body, category, steps } = data;

    const created = await prisma.template.create({
      data: {
        name: name || 'New Custom Template',
        subject: subject || '',
        body: body || '',
        category: category || 'Cold Outreach',
        steps: steps || null,
      }
    });

    return NextResponse.json(created);
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const session = await getSession();
    const data = await req.json();
    const { id, name, subject, body, category, steps } = data;

    if (!id) {
      return NextResponse.json({ error: 'Template ID is required.' }, { status: 400 });
    }

    const updated = await prisma.template.update({
      where: { id },
      data: {
        name,
        subject,
        body,
        category,
        steps: steps || null,
      }
    });

    return NextResponse.json(updated);
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await getSession();
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'Template ID is required.' }, { status: 400 });
    }

    await prisma.template.delete({
      where: { id }
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse();
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
