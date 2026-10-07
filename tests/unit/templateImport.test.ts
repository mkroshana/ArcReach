import { describe, it, expect } from 'vitest';
import {
  readEmailFile,
  importRefusal,
  sortImportedEmails,
  importWaitDays,
  sequenceTemplate,
  separateTemplates,
  MAX_IMPORT_FILE_BYTES,
  DEFAULT_IMPORT_WAIT_DAYS,
  type ImportedEmail,
} from '../../lib/templateImport';
import { isHtmlTemplate, renderEmailBody } from '../../lib/personalize';

const encode = (text: string) => new TextEncoder().encode(text);

const document = (title: string | null, body = '<p>Hi {{firstName}},</p>') =>
  `<!DOCTYPE html>\n<html>\n<head>\n${title === null ? '' : `<title>${title}</title>\n`}</head>\n<body>\n${body}\n</body>\n</html>\n`;

function read(fileName: string, text: string): ImportedEmail {
  const result = readEmailFile(fileName, encode(text));
  if (!result.ok) throw new Error(`${fileName} was refused: ${result.reason}`);
  return result.email;
}

describe('readEmailFile', () => {
  it('takes the subject from <title>, the name from the file name and the whole file as the body', () => {
    const html = document('It Might Be Time to Take Another Look at JobProMax');
    expect(read('Email 1 - Welcome Back.html', html)).toEqual({
      fileName: 'Email 1 - Welcome Back.html',
      name: 'Email 1 - Welcome Back',
      subject: 'It Might Be Time to Take Another Look at JobProMax',
      subjectFromTitle: true,
      body: html,
      hasUnreadableText: false,
    });
  });

  it('decodes character references in the title', () => {
    expect(read('a.html', document('Come Back to JobProMax &amp; Save 20%')).subject).toBe('Come Back to JobProMax & Save 20%');
    expect(read('a.html', document('Let&rsquo;s Go &#128640; &#x2014; Now')).subject).toBe('Let’s Go 🚀 — Now');
  });

  it('keeps merge fields, emoji and typographic quotes in the title as written', () => {
    expect(read('a.html', document('{{firstName}}, here’s what’s new 🚀')).subject).toBe('{{firstName}}, here’s what’s new 🚀');
    expect(read('a.html', document("{{ $json.jobTitle || 'New Job Opportunity' }} - JobProMax")).subject)
      .toBe("{{ $json.jobTitle || 'New Job Opportunity' }} - JobProMax");
  });

  it('writes a title that spans lines as one line', () => {
    expect(read('a.html', document('\n    Upgrade Confirmation -\n    Welcome\n  ')).subject).toBe('Upgrade Confirmation - Welcome');
  });

  it('reads the title whatever its case and attributes', () => {
    expect(read('a.html', '<HTML><HEAD><TITLE id="t">Hello</TITLE></HEAD><BODY><p>x</p></BODY></HTML>').subject).toBe('Hello');
  });

  it('uses the file name as the subject when there is no title, and says so', () => {
    for (const html of [document(null), document(''), document('   ')]) {
      const email = read('Welcome Back.html', html);
      expect(email.subject).toBe('Welcome Back');
      expect(email.subjectFromTitle).toBe(false);
    }
  });

  it('never takes the title of an inline SVG in the body or a commented-out one', () => {
    const svg = document(null, '<svg><title>Logo</title></svg><p>Hi</p>');
    expect(read('a.html', svg).subjectFromTitle).toBe(false);

    const commented = '<html><head><!-- <title>Old Subject</title> --><title>New Subject</title></head><body><p>Hi</p></body></html>';
    expect(read('a.html', commented).subject).toBe('New Subject');
  });

  it('accepts .htm and any capitalisation of the extension', () => {
    expect(read('Promo.HTM', document('Promo')).name).toBe('Promo');
    expect(read('Promo.Html', document('Promo')).name).toBe('Promo');
  });

  it('refuses a file that is not .html or .htm', () => {
    expect(readEmailFile('leads.csv', encode('Email\na@x.com'))).toEqual({ ok: false, fileName: 'leads.csv', reason: 'Not an .html or .htm file.' });
    expect(readEmailFile('email.html.txt', encode(document('x'))).ok).toBe(false);
  });

  it('refuses an empty or whitespace-only file', () => {
    expect(readEmailFile('a.html', new Uint8Array(0))).toEqual({ ok: false, fileName: 'a.html', reason: 'The file is empty.' });
    expect(readEmailFile('a.html', encode(' \r\n\t ')).ok).toBe(false);
  });

  it('refuses a file over the size limit and reads one at the limit', () => {
    const atLimit = new Uint8Array(MAX_IMPORT_FILE_BYTES).fill(0x61);
    expect(readEmailFile('a.html', atLimit).ok).toBe(true);
    const over = new Uint8Array(MAX_IMPORT_FILE_BYTES + 1).fill(0x61);
    expect(readEmailFile('a.html', over)).toEqual({ ok: false, fileName: 'a.html', reason: 'Larger than 1 MB.' });
  });

  it('drops a UTF-8 byte order mark from the body', () => {
    const html = document('Hello');
    const email = readEmailFile('a.html', new Uint8Array([0xef, 0xbb, 0xbf, ...encode(html)]));
    expect(email.ok && email.email.body).toBe(html);
  });

  it('reads a windows-1252 file with its accents and quotes intact', () => {
    // "<title>Café’s</title><p>x</p>" as windows-1252: é is 0xE9 and ’ is 0x92.
    const bytes = new Uint8Array([...encode('<title>Caf'), 0xe9, 0x92, ...encode('s</title><p>x</p>')]);
    const result = readEmailFile('a.html', bytes);
    expect(result.ok && result.email.subject).toBe('Café’s');
    expect(result.ok && result.email.hasUnreadableText).toBe(false);
  });

  it('flags text that could not be read', () => {
    // A UTF-8 byte order mark followed by a byte that is not valid UTF-8.
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encode('<title>Caf'), 0xe9, ...encode('</title><p>x</p>')]);
    const result = readEmailFile('a.html', bytes);
    expect(result.ok && result.email.hasUnreadableText).toBe(true);
  });

  it('gives a body the send path sends as HTML, unchanged but for the merge fields', () => {
    const html = document('Hello', '<p>Hi {{firstName}},</p><a href="[[unsubscribe_url]]">Unsubscribe</a>');
    const { body } = read('a.html', html);
    expect(isHtmlTemplate(body)).toBe(true);
    expect(renderEmailBody(body, { name: 'Emily Carter' }, () => 0)).toEqual({ isHtml: true, body: html.replace('{{firstName}}', 'Emily') });
  });
});

describe('importRefusal', () => {
  it('refuses by name and size alone, with the reasons readEmailFile gives', () => {
    expect(importRefusal('a.html', 6429)).toBeNull();
    expect(importRefusal('a.htm', MAX_IMPORT_FILE_BYTES)).toBeNull();
    expect(importRefusal('a.pdf', 10)).toBe('Not an .html or .htm file.');
    expect(importRefusal('a.html', MAX_IMPORT_FILE_BYTES + 1)).toBe('Larger than 1 MB.');
  });
});

describe('sortImportedEmails', () => {
  const named = (fileName: string) => read(fileName, document('x'));

  it('orders numbered files by number, not by character', () => {
    const emails = ['Email 10 - J.html', 'Email 2 - B.html', 'Email 1 - A.html', 'Email 11 - K.html', 'Email 9 - I.html'].map(named);
    expect(sortImportedEmails(emails).map((e) => e.fileName)).toEqual([
      'Email 1 - A.html', 'Email 2 - B.html', 'Email 9 - I.html', 'Email 10 - J.html', 'Email 11 - K.html',
    ]);
  });

  it('ignores capitalisation and leaves the list it was given alone', () => {
    const emails = ['b.html', 'A.html', 'c.html'].map(named);
    expect(sortImportedEmails(emails).map((e) => e.fileName)).toEqual(['A.html', 'b.html', 'c.html']);
    expect(emails.map((e) => e.fileName)).toEqual(['b.html', 'A.html', 'c.html']);
  });
});

describe('importWaitDays', () => {
  it('keeps a whole number of days of 1 or more', () => {
    expect(importWaitDays(1)).toBe(1);
    expect(importWaitDays(14)).toBe(14);
    expect(importWaitDays('7')).toBe(7);
  });

  it('rounds a fraction down and raises anything under 1 to 1', () => {
    expect(importWaitDays(2.9)).toBe(2);
    expect(importWaitDays(0)).toBe(1);
    expect(importWaitDays(-4)).toBe(1);
  });

  it('uses the default for a blank or a value that is not a number', () => {
    expect(importWaitDays('')).toBe(DEFAULT_IMPORT_WAIT_DAYS);
    expect(importWaitDays('  ')).toBe(DEFAULT_IMPORT_WAIT_DAYS);
    expect(importWaitDays('abc')).toBe(DEFAULT_IMPORT_WAIT_DAYS);
    expect(importWaitDays(undefined)).toBe(DEFAULT_IMPORT_WAIT_DAYS);
    expect(importWaitDays(Infinity)).toBe(DEFAULT_IMPORT_WAIT_DAYS);
  });
});

describe('sequenceTemplate', () => {
  const emails = [
    read('Email 1 - Welcome Back.html', document('First Subject', '<p>One</p>')),
    read('Email 2 - Restart.html', document('Second Subject', '<p>Two</p>')),
    read('Email 3 - Resume.html', document('Third Subject', '<p>Three</p>')),
  ];

  it('makes one template with a step per email, in the order given', () => {
    const template = sequenceTemplate(emails, '  Win-Back Emails ', ' Win-Back ', 4);
    expect(template).toEqual({
      name: 'Win-Back Emails',
      category: 'Win-Back',
      subject: 'First Subject',
      body: emails[0].body,
      steps: [
        { id: 'step-1', waitDays: 0, subject: 'First Subject', body: emails[0].body },
        { id: 'step-2', waitDays: 4, subject: 'Second Subject', body: emails[1].body },
        { id: 'step-3', waitDays: 4, subject: 'Third Subject', body: emails[2].body },
      ],
    });
  });

  it('gives the first step no wait and every later step a wait of 1 day at least', () => {
    expect(sequenceTemplate(emails, 'n', 'c', 0)?.steps.map((s) => s.waitDays)).toEqual([0, 1, 1]);
    expect(sequenceTemplate(emails, 'n', 'c', 'abc')?.steps.map((s) => s.waitDays)).toEqual([0, DEFAULT_IMPORT_WAIT_DAYS, DEFAULT_IMPORT_WAIT_DAYS]);
  });

  it('makes a single-step template from one email', () => {
    expect(sequenceTemplate([emails[0]], 'Solo', 'c', 3)?.steps).toEqual([
      { id: 'step-1', waitDays: 0, subject: 'First Subject', body: emails[0].body },
    ]);
  });

  it('is null when there are no emails', () => {
    expect(sequenceTemplate([], 'n', 'c', 3)).toBeNull();
  });
});

describe('separateTemplates', () => {
  it('makes one single-step template per email, named after its file', () => {
    const emails = [
      read('Password Reset.html', document('Reset Your Password', '<p>Reset</p>')),
      read('Welcome Email.html', document('Welcome to JobProMax', '<p>Welcome</p>')),
    ];
    expect(separateTemplates(emails, ' System ')).toEqual([
      {
        name: 'Password Reset', category: 'System', subject: 'Reset Your Password', body: emails[0].body,
        steps: [{ id: 'step-1', waitDays: 0, subject: 'Reset Your Password', body: emails[0].body }],
      },
      {
        name: 'Welcome Email', category: 'System', subject: 'Welcome to JobProMax', body: emails[1].body,
        steps: [{ id: 'step-1', waitDays: 0, subject: 'Welcome to JobProMax', body: emails[1].body }],
      },
    ]);
  });

  it('is empty when there are no emails', () => {
    expect(separateTemplates([], 'c')).toEqual([]);
  });
});
