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

/**
 * Custom validation helper to ensure send limits (minuteLimit, hourlyLimit, dailyLimit) are not exceeded
 * before triggering automated outgoing emails.
 */
export function validateSendingFrequency(senderAccount: {
  minuteLimit: number;
  hourlyLimit: number;
  dailyLimit: number;
  emailsSentLastMinute: number;
  emailsSentLastHour: number;
  emailsSentToday: number;
}): { allowed: boolean; reason?: string } {
  if (senderAccount.emailsSentLastMinute >= senderAccount.minuteLimit) {
    return { allowed: false, reason: `Sending frequency limit reached: Max ${senderAccount.minuteLimit} per minute.` };
  }
  if (senderAccount.emailsSentLastHour >= senderAccount.hourlyLimit) {
    return { allowed: false, reason: `Sending frequency limit reached: Max ${senderAccount.hourlyLimit} per hour.` };
  }
  if (senderAccount.emailsSentToday >= senderAccount.dailyLimit) {
    return { allowed: false, reason: `Sending limit reached: Max ${senderAccount.dailyLimit} per day.` };
  }
  return { allowed: true };
}

/**
 * Main entry point for the cron job.
 */
export async function processDueEmails() {
  console.log('[SendEngine] Starting processing cycle...');
  
  try {
    const now = new Date();

    // 1. Fetch leads that are due for action
    /*
    const dueLeads = await prisma.lead.findMany({
      where: {
        nextActionDate: {
          lte: now, // nextActionDate is in the past or now
        },
        // We might want to filter out leads possessing a status like 'Bounced', 
        // or if stopOnReply is true and they are 'Interested' / 'Not_Interested', etc.
        // For simplicity:
        status: 'Neutral'
      },
      include: {
        campaign: {
           include: {
              steps: true
           }
        }
      },
      take: 100, // Batch limit to prevent timeout
    });
    */
    const dueLeads: any[] = await mockPrisma.leads.findMany({});

    if (dueLeads.length === 0) {
      console.log('[SendEngine] No emails due in this cycle.');
      return;
    }

    for (const lead of dueLeads) {
      const campaign = lead.campaign;
      
      // 2. Check Timezone & Sending Schedule restrictions
      // You would typically use a library like `date-fns-tz` to determine the current time 
      // in the campaign's specific timezone and check against `campaign.sendSchedule`.
      const isWithinSendingWindow = checkSendingWindow(campaign.timezone, campaign.sendSchedule);
      if (!isWithinSendingWindow) {
          // Skip for now, will be picked up in a later cron cycle
          continue;
      }

      // 3. Find the specific SequenceStep content
      const stepContent = campaign.steps.find((s: any) => s.stepNumber === lead.currentSequenceStep);
      
      if (!stepContent) {
          // Lead has finished the sequence
          continue;
      }

      // 4. Personalize the email (Spintax, Variables)
      const parsedBody = personalizeEmail(stepContent.body, lead);
      const parsedSubject = personalizeEmail(stepContent.subject, lead);

      // 5. SEND EMAIL via Azure Communication Services
      console.log(`[SendEngine] Sending Step ${lead.currentSequenceStep} to ${lead.email}`);
      // await sendEmailWithAzure(lead.email, parsedSubject, parsedBody, campaign.trackOpens);

      // 6. Calculate nextActionDate for the next step (if any)
      const nextStepNum = lead.currentSequenceStep + 1;
      const nextStepContent = campaign.steps.find((s: any) => s.stepNumber === nextStepNum);

      if (nextStepContent) {
          const nextDate = new Date();
          nextDate.setDate(now.getDate() + nextStepContent.waitDays);
          
          /*
          await prisma.lead.update({
             where: { id: lead.id },
             data: {
                 currentSequenceStep: nextStepNum,
                 nextActionDate: nextDate
             }
          });
          */
      } else {
          // Finished sequence
          /*
          await prisma.lead.update({
              where: { id: lead.id },
              data: {
                  nextActionDate: null // Completed
              }
          });
          */
      }
    }

    console.log('[SendEngine] Cycle completed successfully.');

  } catch (error) {
    console.error('[SendEngine] Error during processing cycle:', error);
  }
}

/**
 * Helper to check if current time is within the campaign's allowed schedule.
 */
function checkSendingWindow(timezone: string, schedule: any): boolean {
    // Boilerplate for timezone/schedule checking
    // E.g., getting current day of week and hour in `timezone`
    // and comparing against `schedule.days` and `schedule.window`
    return true; 
}

/**
 * Replace variables like {{firstName}} and resolve {A|B} Spintax
 */
function personalizeEmail(template: string, lead: any): string {
    if (!template) return '';
    let result = template;
    
    const getFirstName = (fullName: string | null | undefined, fallback: string = 'there') => {
        if (!fullName) return fallback;
        return fullName.trim().split(/\s+/)[0] || fallback;
    };

    // Replace {{firstName}}
    result = result.replace(/\{\{firstName\}\}/g, getFirstName(lead.name || lead.firstName, 'there'));

    // Replace {{company}}
    result = result.replace(/\{\{company\}\}/g, lead.company || 'your company');

    // Replace n8n/json style name variable with fallback: {{ $json.name || 'there' }}
    result = result.replace(/\{\{\s*\$json\.name\s*\|\|\s*'([^']*)'\s*\}\}/g, (match, fallback) => {
        return getFirstName(lead.name || lead.firstName, fallback || 'there');
    });

    // Replace n8n/json style name variable without fallback: {{ $json.name }}
    result = result.replace(/\{\{\s*\$json\.name\s*\}\}/g, getFirstName(lead.name || lead.firstName, 'there'));

    // Also support single braces versions just in case: { $json.name || 'there' }
    result = result.replace(/\{\s*\$json\.name\s*\|\|\s*'([^']*)'\s*\}/g, (match, fallback) => {
        return getFirstName(lead.name || lead.firstName, fallback || 'there');
    });
    result = result.replace(/\{\s*\$json\.name\s*\}/g, getFirstName(lead.name || lead.firstName, 'there'));

    // Support n8n/json style company variable: {{ $json.company || 'your company' }}
    result = result.replace(/\{\{\s*\$json\.company\s*\|\|\s*'([^']*)'\s*\}\}/g, (match, fallback) => {
        return lead.company || fallback || 'your company';
    });
    result = result.replace(/\{\{\s*\$json\.company\s*\}\}/g, lead.company || 'your company');

    // Single braces version: { $json.company || 'your company' }
    result = result.replace(/\{\s*\$json\.company\s*\|\|\s*'([^']*)'\s*\}/g, (match, fallback) => {
        return lead.company || fallback || 'your company';
    });
    result = result.replace(/\{\s*\$json\.company\s*\}/g, lead.company || 'your company');

    // Basic Spintax: {Hi|Hello|Hey}
    const spintaxRegex = /\{([^{}]+)\}/g;
    result = result.replace(spintaxRegex, (match, options) => {
        const choices = options.split('|');
        return choices[Math.floor(Math.random() * choices.length)];
    });

    return result;
}
