import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendMessage, EmailConfigError, EmailSendError } from '../../lib/emailProvider';
import { encryptSecret } from '../../lib/secrets';

const sendMail = vi.fn();
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail: (...args: any[]) => sendMail(...args) }) },
}));

const beginSend = vi.fn();
vi.mock('@azure/communication-email', () => ({
  EmailClient: class { beginSend(...a: any[]) { return beginSend(...a); } },
}));

const sender = {
  emailAddress: 'sales@thejobshelpers.com',
  replyTo: null,
  name: 'Sales',
};

beforeEach(() => {
  sendMail.mockReset();
  beginSend.mockReset();
});

describe('sendMessage', () => {
  it('MOCK provider returns no provider message id and does not call any transport', async () => {
    const result = await sendMessage(
      { to: 'lead@x.com', subject: 's', body: 'b', isHtml: false, sender },
      { activeProvider: 'MOCK' }
    );
    expect(result.providerMessageId).toBeNull();
    expect(sendMail).not.toHaveBeenCalled();
    expect(beginSend).not.toHaveBeenCalled();
  });

  it('AZURE returns the provider id on success', async () => {
    beginSend.mockResolvedValue({ pollUntilDone: async () => ({ id: 'azure-id-1', status: 'Succeeded' }) });
    const result = await sendMessage(
      { to: 'lead@x.com', subject: 's', body: 'b', isHtml: false, sender },
      {
        activeProvider: 'AZURE',
        azureConnString: encryptSecret('endpoint=https://x;accesskey=y'),
        azureSenderDomains: ['thejobshelpers.com'],
      }
    );
    expect(result.providerMessageId).toBe('azure-id-1');
  });

  it('AZURE without verified domains throws EmailConfigError', async () => {
    await expect(
      sendMessage(
        { to: 'lead@x.com', subject: 's', body: 'b', isHtml: false, sender },
        { activeProvider: 'AZURE', azureConnString: encryptSecret('endpoint=x;accesskey=y') }
      )
    ).rejects.toBeInstanceOf(EmailConfigError);
  });

  it('AZURE Failed status surfaces as EmailSendError', async () => {
    beginSend.mockResolvedValue({
      pollUntilDone: async () => ({ status: 'Failed', error: { message: 'boom' } }),
    });
    await expect(
      sendMessage(
        { to: 'lead@x.com', subject: 's', body: 'b', isHtml: false, sender },
        {
          activeProvider: 'AZURE',
          azureConnString: encryptSecret('endpoint=x;accesskey=y'),
          azureSenderDomains: ['thejobshelpers.com'],
        }
      )
    ).rejects.toBeInstanceOf(EmailSendError);
  });

  it('SMTP path uses per-sender credentials when present', async () => {
    sendMail.mockResolvedValue({ messageId: '<smtp-msg-1>' });
    const result = await sendMessage(
      {
        to: 'lead@x.com', subject: 's', body: 'b', isHtml: false,
        sender: {
          ...sender,
          smtpHost: 'smtp.sender.com', smtpPort: 587,
          smtpUser: 'override@sender.com', smtpPass: encryptSecret('secret'),
        },
      },
      { activeProvider: 'SMTP' }
    );
    expect(result.providerMessageId).toBe('<smtp-msg-1>');
    const call = sendMail.mock.calls[0][0];
    expect(call.from).toContain('override@sender.com');
    expect(call.to).toBe('lead@x.com');
  });

  it('SMTP without any credentials throws EmailConfigError', async () => {
    await expect(
      sendMessage(
        { to: 'lead@x.com', subject: 's', body: 'b', isHtml: false, sender },
        { activeProvider: 'SMTP' }
      )
    ).rejects.toBeInstanceOf(EmailConfigError);
  });

  it('SMTP transport rejection surfaces as EmailSendError', async () => {
    sendMail.mockRejectedValue(new Error('mailbox unavailable'));
    await expect(
      sendMessage(
        { to: 'lead@x.com', subject: 's', body: 'b', isHtml: false, sender },
        {
          activeProvider: 'SMTP',
          smtpHost: 'smtp.global.com', smtpPort: 587,
          smtpUser: 'global@x.com', smtpPass: encryptSecret('secret'),
        }
      )
    ).rejects.toBeInstanceOf(EmailSendError);
  });
});
