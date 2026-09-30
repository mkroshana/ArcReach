import { prisma } from './db';
import { suppressEmail } from './suppression';

/**
 * Azure delivery reports (Microsoft.Communication.EmailDeliveryReportReceived),
 * applied by the delivery webhook to the dispatch they report on. ACS reports:
 *  - Delivered: the recipient's mail server accepted the message.
 *  - Expanded: a distribution list was expanded; each member gets a report of its own.
 *  - Bounced: permanently undeliverable, a hard bounce.
 *  - Suppressed: ACS did not send it because the address hard-bounced before
 *    (ACS's own suppression list), so a hard bounce too.
 *  - Quarantined, FilteredSpam: the recipient's filtering held or rejected the
 *    message as spam. Nothing is wrong with the address; the dispatch records it.
 *  - Failed: not delivered; its statusMessage says whether for good (classifyDeliveryFailure).
 */
export const DELIVERY_STATUSES = ['Delivered', 'Expanded', 'Bounced', 'Suppressed', 'Quarantined', 'FilteredSpam', 'Failed'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** What a report does to its dispatch: 'hard' and 'soft' are bounces. */
export type DeliveryOutcome = 'delivered' | 'expanded' | 'filtered' | 'hard' | 'soft';

/** A report's status as ACS spells it, or null for one it does not document. */
export function parseDeliveryStatus(status: unknown): DeliveryStatus | null {
  if (typeof status !== 'string') return null;
  const wanted = status.trim().toLowerCase();
  return DELIVERY_STATUSES.find((known) => known.toLowerCase() === wanted) ?? null;
}

/** RFC 3463 enhanced status code: class, subject and detail. */
const ENHANCED_CODE = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/;
/** 5.1.x details for a bad destination: mailbox (1), system (2), address syntax (3), moved away (6), null MX (10). */
const BAD_ADDRESS_DETAILS = ['1', '2', '3', '6', '10'];
/** A bare transient (4xx) SMTP reply code, for a message without an enhanced code. */
const TRANSIENT_REPLY_CODE = /(?:^|\s)4\d\d[\s-]/;
/** Wording for a mailbox or domain that does not exist. */
const BAD_ADDRESS_WORDING =
  /no such (user|mailbox)|user unknown|unknown user|recipient not found|recipientnotfound|mailbox (unavailable|not found)|does not exist|doesn't exist|invalid recipient|domain not found|nxdomain|no mx|null mx/;

/**
 * Whether a Failed report's statusMessage (deliveryStatusDetails) says the
 * address can never be delivered to ('hard': it is suppressed) or not
 * ('soft'). A transient code (4.x.x or a bare 4xx) or a policy one (5.7.x:
 * spam, reputation, authentication) is soft whatever the wording; a
 * bad-address code or wording is hard; anything else, a missing message
 * included, is soft, so a passing failure never suppresses a good address.
 */
export function classifyDeliveryFailure(statusMessage: string | null | undefined): 'hard' | 'soft' {
  const text = (statusMessage || '').toLowerCase();
  const code = ENHANCED_CODE.exec(text);
  if (code) {
    const [, codeClass, subject, detail] = code;
    if (codeClass !== '5' || subject === '7') return 'soft';
    if (subject === '1' && BAD_ADDRESS_DETAILS.includes(detail)) return 'hard';
  } else if (TRANSIENT_REPLY_CODE.test(text)) {
    return 'soft';
  }
  return BAD_ADDRESS_WORDING.test(text) ? 'hard' : 'soft';
}

/** What a report with this status (and, for Failed, this statusMessage) does to its dispatch. */
export function deliveryOutcome(status: DeliveryStatus, statusMessage?: string | null): DeliveryOutcome {
  switch (status) {
    case 'Delivered':
      return 'delivered';
    case 'Expanded':
      return 'expanded';
    case 'Quarantined':
    case 'FilteredSpam':
      return 'filtered';
    case 'Bounced':
    case 'Suppressed':
      return 'hard';
    case 'Failed':
      return classifyDeliveryFailure(statusMessage);
  }
}

/** The first of `values` that is a valid timestamp, or now. */
export function reportedAt(...values: unknown[]): Date {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const at = new Date(value);
    if (!Number.isNaN(at.getTime())) return at;
  }
  return new Date();
}

/** The dispatch fields a report is applied with. */
export type ReportedDispatch = { id: string; leadId: string | null; messageId: string };

/**
 * The dispatch a report is about, or null. ACS reports under the Operation-Id
 * the send was made with, which a campaign send stores (operationId) before
 * the provider call, so a report that arrives before the send's bookkeeping
 * still finds it; rows recorded after the send (Unibox replies, mailbox tests)
 * carry that id as their messageId. Case-insensitive as a fallback.
 */
export async function findReportedDispatch(messageId: string): Promise<ReportedDispatch | null> {
  const select = { id: true, leadId: true, messageId: true };
  return (
    (await prisma.emailDispatch.findUnique({ where: { operationId: messageId }, select })) ??
    (await prisma.emailDispatch.findUnique({ where: { messageId }, select })) ??
    (await prisma.emailDispatch.findFirst({
      where: {
        OR: [
          { operationId: { equals: messageId, mode: 'insensitive' } },
          { messageId: { equals: messageId, mode: 'insensitive' } },
        ],
      },
      select,
    }))
  );
}

/**
 * Applies one delivery report to its dispatch and returns what it did, or null
 * for a status ACS does not document (logged, nothing written). Each write is
 * conditional on what the dispatch already records, so a report Event Grid
 * delivers again (it redelivers a whole batch when any event in it fails)
 * changes nothing twice. A bounce is final: a later report never overwrites
 * it, except a hard bounce replacing a soft one.
 */
export async function applyDeliveryReport(
  dispatch: ReportedDispatch,
  report: { status: unknown; statusMessage?: string | null; at: Date },
): Promise<DeliveryOutcome | null> {
  const status = parseDeliveryStatus(report.status);
  if (!status) {
    console.warn(`[DeliveryReport] Dispatch ${dispatch.id}: unknown delivery status ${JSON.stringify(report.status)}; nothing recorded.`);
    return null;
  }
  const outcome = deliveryOutcome(status, report.statusMessage);
  const notBounced = { id: dispatch.id, bouncedAt: null };

  switch (outcome) {
    case 'delivered':
      await prisma.emailDispatch.updateMany({
        where: notBounced,
        data: { deliveryStatus: status, deliveredAt: report.at },
      });
      break;
    case 'expanded':
      // Only as the first report: the members' own reports follow and say how each ended.
      await prisma.emailDispatch.updateMany({
        where: { ...notBounced, deliveryStatus: null },
        data: { deliveryStatus: status },
      });
      break;
    case 'filtered':
      await prisma.emailDispatch.updateMany({
        where: notBounced,
        data: { deliveryStatus: status },
      });
      break;
    case 'soft':
      // Not delivered this time. The address stays mailable and the sequence goes on.
      await prisma.emailDispatch.updateMany({
        where: notBounced,
        data: { deliveryStatus: status, bouncedAt: report.at, bounceType: 'soft' },
      });
      break;
    case 'hard':
      await recordHardBounce(dispatch, status, report);
      break;
  }

  console.log(`[DeliveryReport] Dispatch ${dispatch.id}: ${status}${outcome === 'hard' || outcome === 'soft' ? ` (${outcome} bounce)` : ''}${report.statusMessage ? `: ${report.statusMessage}` : ''}`);
  return outcome;
}

/**
 * Records a hard bounce in one transaction: the dispatch, the lead (Bounced
 * and Invalid, and its address suppressed), the lead's Active enrollments in
 * every campaign (Bounced) and a 'bounce' EmailEvent. Only the report that
 * marks the dispatch hard writes the rest, so a redelivered one writes nothing.
 */
async function recordHardBounce(
  dispatch: ReportedDispatch,
  status: DeliveryStatus,
  report: { statusMessage?: string | null; at: Date },
): Promise<void> {
  const lastError = `Azure delivery report: ${status}${report.statusMessage ? ` (${report.statusMessage})` : ''}`;
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.emailDispatch.updateMany({
      where: { id: dispatch.id, OR: [{ bounceType: null }, { bounceType: 'soft' }] },
      data: { deliveryStatus: status, bouncedAt: report.at, bounceType: 'hard' },
    });
    if (count === 0) return;

    // A mailbox test send went to the testing user, so there is no lead to mark
    if (dispatch.leadId) {
      const bouncedLead = await tx.lead.update({
        where: { id: dispatch.leadId },
        data: { status: 'Bounced', validationStatus: 'Invalid' },
      });
      // The suppression list outlives the lead, so the address is never mailed again
      await suppressEmail(tx, bouncedLead.email, 'HardBounce', 'delivery-webhook');
      await tx.campaignEnrollment.updateMany({
        where: { leadId: dispatch.leadId, status: 'Active' },
        data: { status: 'Bounced', nextActionDate: null, lastError, lastBounceType: 'hard' },
      });
    }

    // Audit trail EmailEvent for the bounce
    await tx.emailEvent.create({
      data: { messageId: dispatch.messageId, eventType: 'bounce' },
    });
  });
}
