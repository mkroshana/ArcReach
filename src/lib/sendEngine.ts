/**
 * Background Email Worker / Send Engine
 * 
 * In a real-world scenario with Next.js, you cannot rely entirely on long-running
 * processes within serverless functions.
 * 
 * RECOMMENDED SETUP:
 * Deploy this logic as an API route (e.g., /api/cron/process-emails) and 
 * ping it every 5 minutes using a scheduler like Vercel Cron, GitHub Actions, 
 * or a service like Trigger.dev / Inngest for more robust queueing and retries.
 */

// import { PrismaClient } from '@prisma/client';
// const prisma = new PrismaClient();

// Mock dependencies
const mockPrisma = {
    leads: {
        findMany: async (args: any) => []
    },
    campaigns: {
        findUnique: async (args: any) => null
    }
}

export async function processDueEmails() {
  console.log('[SendEngine] Starting processing cycle...');
  
  try {
    const now = new Date();

    // 1. Fetch leads that are due for action
    const dueLeads: any[] = await mockPrisma.leads.findMany({});

    if (dueLeads.length === 0) {
      console.log('[SendEngine] No emails due in this cycle.');
      return;
    }

    for (const lead of dueLeads) {
      const campaign = lead.campaign;
      
      // 2. Check Timezone & Sending Schedule restrictions
      const isWithinSendingWindow = checkSendingWindow(campaign.timezone, campaign.sendSchedule);
      if (!isWithinSendingWindow) {
          continue;
      }

      // 3. Find the specific SequenceStep content
      const stepContent = campaign.steps.find((s: any) => s.stepNumber === lead.currentSequenceStep);
      
      if (!stepContent) {
          continue;
      }

      // 4. Personalize the email (Spintax, Variables)
      const parsedBody = personalizeEmail(stepContent.body, lead);
      const parsedSubject = personalizeEmail(stepContent.subject, lead);

      // 5. SEND EMAIL via Azure Communication Services
      console.log(`[SendEngine] Sending Step ${lead.currentSequenceStep} to ${lead.email}`);

      // 6. Calculate nextActionDate for the next step (if any)
      const nextStepNum = lead.currentSequenceStep + 1;
      const nextStepContent = campaign.steps.find((s: any) => s.stepNumber === nextStepNum);

      if (nextStepContent) {
          const nextDate = new Date();
          nextDate.setDate(now.getDate() + nextStepContent.waitDays);
      }
    }

    console.log('[SendEngine] Cycle completed successfully.');

  } catch (error) {
    console.error('[SendEngine] Error during processing cycle:', error);
  }
}

function checkSendingWindow(timezone: string, schedule: any): boolean {
    return true; 
}

function personalizeEmail(template: string, lead: any): string {
    let result = template;
    
    result = result.replace(/\{\{firstName\}\}/g, lead.firstName || 'there');
    result = result.replace(/\{\{company\}\}/g, lead.company || 'your company');

    const spintaxRegex = /\{([^{}]+)\}/g;
    result = result.replace(spintaxRegex, (match, options) => {
        const choices = options.split('|');
        return choices[Math.floor(Math.random() * choices.length)];
    });

    return result;
}
