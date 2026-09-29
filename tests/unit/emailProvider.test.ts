import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendMessage, sendingDisabledReason, EmailConfigError, EmailSendError } from '../../lib/emailProvider';
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

describe('sendingDisabledReason (H1)', () => {
  const azure = {
    activeProvider: 'AZURE',
    azureConnString: encryptSecret('endpoint=https://x;accesskey=y'),
    azureSenderDomains: ['thejobshelpers.com'],
  };

  it('allows sending only when Azure is selected with a connection string and a verified domain', () => {
    expect(sendingDisabledReason(azure)).toBeNull();
  });

  it('refuses when there is no settings row, sending is DISABLED, or the retired MOCK value is stored', () => {
    for (const settings of [null, undefined, { ...azure, activeProvider: 'DISABLED' }, { ...azure, activeProvider: 'MOCK' }, { ...azure, activeProvider: null }]) {
      expect(sendingDisabledReason(settings)).toMatch(/^Sending is disabled\./);
    }
  });

  it('refuses Azure without a connection string or verified sender domains', () => {
    for (const settings of [{ ...azure, azureConnString: null }, { ...azure, azureConnString: '' }, { ...azure, azureSenderDomains: [] }]) {
      expect(sendingDisabledReason(settings)).toContain('connection string and at least one verified sender domain');
    }
  });
});

describe('sendMessage', () => {
  it('never reports success without sending: no settings, DISABLED and MOCK throw EmailConfigError and call no transport', async () => {
    const credentials = { azureConnString: encryptSecret('endpoint=https://x;accesskey=y'), azureSenderDomains: ['thejobshelpers.com'] };
    for (const settings of [null, { ...credentials, activeProvider: 'DISABLED' }, { ...credentials, activeProvider: 'MOCK' }]) {
      await expect(
        sendMessage({ to: 'lead@x.com', subject: 's', body: 'b', isHtml: false, sender }, settings)
      ).rejects.toBeInstanceOf(EmailConfigError);
    }
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

  it('AZURE omits replyTo when the sender has none configured', async () => {
    beginSend.mockResolvedValue({ pollUntilDone: async () => ({ id: 'azure-id-2', status: 'Succeeded' }) });
    await sendMessage(
      { to: 'lead@x.com', subject: 's', body: 'b', isHtml: false, sender },
      {
        activeProvider: 'AZURE',
        azureConnString: encryptSecret('endpoint=https://x;accesskey=y'),
        azureSenderDomains: ['thejobshelpers.com'],
      }
    );
    const message = beginSend.mock.calls[0][0];
    expect(message.replyTo).toBeUndefined();
  });

  it('AZURE includes replyTo only when explicitly set', async () => {
    beginSend.mockResolvedValue({ pollUntilDone: async () => ({ id: 'azure-id-3', status: 'Succeeded' }) });
    await sendMessage(
      {
        to: 'lead@x.com', subject: 's', body: 'b', isHtml: false,
        sender: { ...sender, replyTo: 'inbox@thejobshelpers.com' },
      },
      {
        activeProvider: 'AZURE',
        azureConnString: encryptSecret('endpoint=https://x;accesskey=y'),
        azureSenderDomains: ['thejobshelpers.com'],
      }
    );
    const message = beginSend.mock.calls[0][0];
    expect(message.replyTo).toEqual([{ address: 'inbox@thejobshelpers.com' }]);
  });

  it('AZURE without verified domains throws EmailConfigError', async () => {
    await expect(
      sendMessage(
        { to: 'lead@x.com', subject: 's', body: 'b', isHtml: false, sender },
        { activeProvider: 'AZURE', azureConnString: encryptSecret('endpoint=x;accesskey=y') }
      )
    ).rejects.toBeInstanceOf(EmailConfigError);
  });

  it('AZURE with a connection string that cannot be decrypted throws EmailConfigError and sends nothing (H9)', async () => {
    // A well-formed envelope whose GCM tag does not verify, as after SECRETS_KEY changes.
    const envelope = encryptSecret('endpoint=x;accesskey=y');
    const blobStart = envelope.lastIndexOf(':') + 1;
    const blob = Buffer.from(envelope.slice(blobStart), 'base64');
    blob[0] ^= 0xff;
    for (const azureConnString of [envelope.slice(0, blobStart) + blob.toString('base64'), 'enc:v1:not-an-envelope']) {
      const err = await sendMessage(
        { to: 'lead@x.com', subject: 's', body: 'b', isHtml: false, sender },
        { activeProvider: 'AZURE', azureConnString, azureSenderDomains: ['thejobshelpers.com'] }
      ).catch((e) => e);
      expect(err).toBeInstanceOf(EmailConfigError);
      expect(err.message).toMatch(/^The saved Azure Communication Services connection string could not be decrypted \(.+\)\. SECRETS_KEY may have changed/);
    }
    expect(beginSend).not.toHaveBeenCalled();
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

  it('SMTP omits replyTo when the sender has none configured', async () => {
    sendMail.mockResolvedValue({ messageId: '<smtp-msg-2>' });
    await sendMessage(
      { to: 'lead@x.com', subject: 's', body: 'b', isHtml: false, sender },
      {
        activeProvider: 'SMTP',
        smtpHost: 'smtp.global.com', smtpPort: 587,
        smtpUser: 'global@x.com', smtpPass: encryptSecret('secret'),
      }
    );
    const call = sendMail.mock.calls[0][0];
    expect(call.replyTo).toBeUndefined();
  });

  it('SMTP includes replyTo only when explicitly set', async () => {
    sendMail.mockResolvedValue({ messageId: '<smtp-msg-3>' });
    await sendMessage(
      {
        to: 'lead@x.com', subject: 's', body: 'b', isHtml: false,
        sender: { ...sender, replyTo: 'inbox@x.com' },
      },
      {
        activeProvider: 'SMTP',
        smtpHost: 'smtp.global.com', smtpPort: 587,
        smtpUser: 'global@x.com', smtpPass: encryptSecret('secret'),
      }
    );
    const call = sendMail.mock.calls[0][0];
    expect(call.replyTo).toBe('inbox@x.com');
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
