import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { suppressEmail } from './suppression';

/**
 * Azure delivery reports (Microsoft.Communication.EmailDeliveryReportReceived),
 * applied by the delivery webhook to the dispatch they report on. ACS reports:
 *  - Delivered: the recipient's mail server accepted the message.
 *  - Expanded: a distribution list was expanded; each member gets a report of its own.
 *  - Bounced: the recipient's mail server refused it for good. A hard bounce,
 *    unless its statusMessage shows the refusal was transient, over a full
 *    mailbox, or over spam, content filters, reputation, a block list, policy,
 *    rate or authentication rather than the address: then a soft one, so a
 *    sender reputation problem never suppresses good recipients (classifyBounce).
 *  - Suppressed: ACS did not send it because the address hard-bounced before
 *    (ACS's own suppression list), so a hard bounce.
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

/**
 * RFC 3463 enhanced status code: class, subject and detail. Never part of a
 * longer dotted number, such as an IP address the server quotes ('[5.1.1.4]').
 */
const ENHANCED_CODE = /(?<!\d\.)\b([245])\.(\d{1,3})\.(\d{1,3})\b(?!\.\d)/;
/** The same code right after a 3-digit reply code ('550 5.7.1', '550-5.7.1'), where the server puts its own. */
const REPLY_THEN_ENHANCED_CODE = /(?<![\w.])[245]\d\d[ -]([245])\.(\d{1,3})\.(\d{1,3})\b(?!\.\d)/;
/** 5.1.x details for a bad destination: mailbox (1), system (2), address syntax (3), moved away (6), null MX (10). */
const BAD_ADDRESS_DETAILS = ['1', '2', '3', '6', '10'];
/** A bare transient (4xx) SMTP reply code, for a message without an enhanced code. */
const TRANSIENT_REPLY_CODE = /(?:^|\s)4\d\d[\s-]/;
/** Wording for a mailbox or domain that does not exist. */
const BAD_ADDRESS_WORDING =
  /no such (user|mailbox)|user unknown|unknown user|recipient not found|recipientnotfound|mailbox (unavailable|not found)|does not exist|doesn't exist|invalid recipient|domain not found|nxdomain|no mx|null mx/;
/**
 * Wording for a refusal over spam or a content filter, the sender's reputation,
 * a block list, authentication, policy or rate, not the address.
 */
const POLICY_WORDING =
  /spam|unsolicited|as junk|phishing|content filter|\bfiltered\b|content (not accepted|rejected)|reputation|polic(y|ies)|blocked|block ?list|black ?list|listed at|dnsbl|\brbl\b|rate.?limit|too many|dmarc|\bspf\b|dkim|authenticat/;
/**
 * Wording for a refusal of the sender itself: spam or a content filter, its
 * reputation, a block list, authentication or policy. POLICY_WORDING without
 * the rate limits, which pass and say nothing against the sender.
 */
const SENDER_REFUSAL_WORDING =
  /spam|unsolicited|as junk|phishing|content filter|\bfiltered\b|content (not accepted|rejected)|reputation|polic(y|ies)|blocked|block ?list|black ?list|listed at|dnsbl|\brbl\b|dmarc|\bspf\b|dkim|authenticat/;
/** Wording for a mailbox too full to take the message: the address is fine. */
const MAILBOX_FULL_WORDING = /(mail|in)box (is )?full|over quota|quota exceeded|out of storage|insufficient storage/;

/**
 * A lowercased statusMessage's enhanced status code as [class, subject,
 * detail], the one right after a reply code first, or null.
 */
function enhancedCode(text: string): [string, string, string] | null {
  const match = REPLY_THEN_ENHANCED_CODE.exec(text) ?? ENHANCED_CODE.exec(text);
  return match ? [match[1], match[2], match[3]] : null;
}

/**
 * What a lowercased statusMessage's reply codes alone say: 'soft' for a code
 * that is not permanent (4.x.x or a bare 4xx) or a policy one (5.7.x: spam,
 * reputation, authentication), 'hard' for a bad-address one (5.1.x), or null
 * when its codes, or the lack of any, leave it to the wording.
 */
function classifyReplyCode(text: string): 'hard' | 'soft' | null {
  const code = enhancedCode(text);
  if (code) {
    const [codeClass, subject, detail] = code;
    if (codeClass !== '5' || subject === '7') return 'soft';
    if (subject === '1' && BAD_ADDRESS_DETAILS.includes(detail)) return 'hard';
    return null;
  }
  return TRANSIENT_REPLY_CODE.test(text) ? 'soft' : null;
}

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
  return classifyReplyCode(text) ?? (BAD_ADDRESS_WORDING.test(text) ? 'hard' : 'soft');
}

/** Whether a lowercased statusMessage says the mailbox is full: an x.2.2 code (5.2.2, 4.2.2) or that wording. */
function isMailboxFull(text: string): boolean {
  const code = enhancedCode(text);
  return (code !== null && code[1] === '2' && code[2] === '2') || MAILBOX_FULL_WORDING.test(text);
}

/**
 * Whether a Bounced report's statusMessage leaves it a hard bounce (the
 * address is suppressed) or makes it a soft one. ACS reports Bounced for a
 * permanent refusal, but a mail server that refuses a sender with a poor
 * reputation says so permanently too, and the address is fine. A transient
 * code (4.x.x or a bare 4xx), a policy one (5.7.x) or, without a deciding
 * code, a full mailbox (5.2.2 or that wording) or spam, content filter,
 * reputation, policy, block list, rate or authentication wording is soft, even
 * beside bad-address wording; a bad-address code (5.1.x) is hard whatever the
 * wording; anything else, a missing message included, is hard.
 */
function classifyBounce(statusMessage: string | null | undefined): 'hard' | 'soft' {
  const text = (statusMessage || '').toLowerCase();
  return classifyReplyCode(text) ?? (isMailboxFull(text) || POLICY_WORDING.test(text) ? 'soft' : 'hard');
}

/**
 * What a report with this status (and, for Bounced and Failed, this
 * statusMessage) does to its dispatch. Suppressed is always a hard bounce;
 * Bounced is hard unless its statusMessage shows a transient, full-mailbox or
 * policy refusal (classifyBounce); Failed is soft unless its statusMessage
 * shows a bad address (classifyDeliveryFailure).
 */
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
      return classifyBounce(statusMessage);
    case 'Suppressed':
      return 'hard';
    case 'Failed':
      return classifyDeliveryFailure(statusMessage);
  }
}

/**
 * Whether a report says the receiving server refused the email because of its
 * sender (the mailbox, its domain or what it sent), not because of the address
 * or of something that passes. Such an email is sent again from another
 * mailbox (requeueRefusedStep). True for FilteredSpam, and for a Bounced or
 * Failed report with a permanent policy code (5.7.x: spam, reputation,
 * authentication) or, with no deciding code, spam, reputation, policy, block
 * list or authentication wording. False for a temporary refusal (4.x.x or a
 * bare 4xx, a rate limit among them: the same mailbox may be accepted later),
 * a full mailbox, a bad address, and Quarantined, where the message was taken
 * and held and may still be released.
 */
export function isSenderRefusal(status: DeliveryStatus, statusMessage?: string | null): boolean {
  if (status === 'FilteredSpam') return true;
  if (status !== 'Bounced' && status !== 'Failed') return false;
  const text = (statusMessage || '').toLowerCase();
  const code = enhancedCode(text);
  if (code) {
    if (code[0] !== '5') return false;
    if (code[1] === '7') return true;
  } else if (TRANSIENT_REPLY_CODE.test(text)) {
    return false;
  }
  return !isMailboxFull(text) && !BAD_ADDRESS_WORDING.test(text) && SENDER_REFUSAL_WORDING.test(text);
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
export type ReportedDispatch = {
  id: string;
  leadId: string | null;
  messageId: string;
  /** The campaign and step the email was, to send the step again when its sender was refused; absent on rows loaded without them. */
  campaignId?: string | null;
  stepOrder?: number | null;
};

/**
 * The dispatch a report is about, or null. ACS reports under the Operation-Id
 * the send was made with, which a campaign send stores (operationId) before
 * the provider call, so a report that arrives before the send's bookkeeping
 * still finds it; rows recorded after the send (Unibox replies, mailbox tests)
 * carry that id as their messageId. Case-insensitive as a fallback.
 */
export async function findReportedDispatch(messageId: string): Promise<ReportedDispatch | null> {
  const select = { id: true, leadId: true, messageId: true, campaignId: true, stepOrder: true };
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
      if (isSenderRefusal(status, report.statusMessage)) {
        // Rejected as spam: the step is sent again from another mailbox, once.
        await prisma.$transaction(async (tx) => {
          const { count } = await tx.emailDispatch.updateMany({
            where: { ...notBounced, senderRefusedAt: null },
            data: { deliveryStatus: status, senderRefusedAt: report.at },
          });
          if (count > 0) await requeueRefusedStep(tx, dispatch, report.at);
        });
        break;
      }
      await prisma.emailDispatch.updateMany({
        where: notBounced,
        data: { deliveryStatus: status },
      });
      break;
    case 'soft':
      if (isSenderRefusal(status, report.statusMessage)) {
        // Refused because of its sender. The address stays mailable, and the
        // step is sent again from another mailbox, once: only the report that
        // marks the dispatch queues it.
        await prisma.$transaction(async (tx) => {
          const { count } = await tx.emailDispatch.updateMany({
            where: notBounced,
            data: { deliveryStatus: status, bouncedAt: report.at, bounceType: 'soft', senderRefusedAt: report.at },
          });
          if (count > 0) await requeueRefusedStep(tx, dispatch, report.at);
        });
        break;
      }
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
 * Puts a lead back on the step whose email was refused because of its sender,
 * due now, so the send engine sends that step again. The engine leaves out
 * every mailbox that refused the lead (lib/sendEngine), so it goes out from
 * another one the campaign allows for it, or waits for one.
 *
 * Only an enrollment that has not moved on since is put back: one waiting for
 * the next step, or one the refused step completed (it was the last). A lead
 * that replied, unsubscribed, bounced or left the campaign meanwhile stays as
 * it is, and so does a mailbox test or a Unibox reply, which has no step.
 */
async function requeueRefusedStep(
  tx: Pick<Prisma.TransactionClient, 'campaignStep' | 'campaignEnrollment'>,
  dispatch: ReportedDispatch,
  at: Date,
): Promise<void> {
  const { campaignId, leadId, stepOrder } = dispatch;
  if (!campaignId || !leadId || typeof stepOrder !== 'number') return;
  const laterStep = await tx.campaignStep.findFirst({
    where: { campaignId, stepOrder: stepOrder + 1 },
    select: { id: true },
  });
  await tx.campaignEnrollment.updateMany({
    where: laterStep
      ? { leadId, campaignId, status: 'Active', currentSequenceStep: stepOrder + 1 }
      : { leadId, campaignId, status: 'Completed' },
    data: { status: 'Active', currentSequenceStep: stepOrder, nextActionDate: at, retryCount: 0 },
  });
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
