import { describe, it, expect } from 'vitest';
import { decodeQuotedPrintable, cleanReplyHistory, cleanMimeBody } from '../../lib/imapService';

describe('IMAP Email Body Cleaning & Decoding Logic', () => {

  describe('decodeQuotedPrintable', () => {
    it('should return unencoded text as-is', () => {
      const input = 'Hello this is normal text with = symbol that should not be decoded as it is not QP.';
      expect(decodeQuotedPrintable(input)).toBe(input);
    });

    it('should decode quoted-printable =3D to =', () => {
      const input = 'style=3D"margin:0" color=3D"red"';
      expect(decodeQuotedPrintable(input)).toBe('style="margin:0" color="red"');
    });

    it('should resolve soft line breaks', () => {
      const input = 'This is a very long line =\r\nthat was split into two parts.';
      expect(decodeQuotedPrintable(input)).toBe('This is a very long line that was split into two parts.');
    });

    it('should decode hex escapes like =20 and =0A', () => {
      const input = 'Hello=20World=3D!';
      expect(decodeQuotedPrintable(input)).toBe('Hello World=!');
    });
  });

  describe('cleanReplyHistory', () => {
    it('should strip everything starting with "On ... wrote:"', () => {
      const input = `Hi Team,\n\nI am interested in scheduling a demo next Tuesday.\n\nBest regards,\nJohn Doe\n\nOn Mon, Jun 8, 2026 at 10:04 PM Roshana Perera <mkroshana@gmail.com> wrote:\n> Hi John,\n> Would you be open to a quick call?`;
      const expected = `Hi Team,\n\nI am interested in scheduling a demo next Tuesday.\n\nBest regards,\nJohn Doe`;
      expect(cleanReplyHistory(input)).toBe(expected);
    });

    it('should strip multi-line "On ... wrote:" header blocks', () => {
      const input = `Yes, that works.\n\nOn Mon, Jun 8, 2026 at 10:04 PM Roshana Perera\n<mkroshana@gmail.com> wrote:\n> Some previous message`;
      const expected = `Yes, that works.`;
      expect(cleanReplyHistory(input)).toBe(expected);
    });

    it('should strip standard "Original Message" borders', () => {
      const input = `Thanks for reaching out.\n\n-----Original Message-----\nFrom: mkroshana@gmail.com\nSent: Monday, June 8, 2026 10:00 PM`;
      const expected = `Thanks for reaching out.`;
      expect(cleanReplyHistory(input)).toBe(expected);
    });

    it('should skip leading/middle standalone quote lines starting with >', () => {
      const input = `Hi,\n\nI agree.\n\n> Yes, let's do it.\n\nLet me know what time.`;
      const expected = `Hi,\n\nI agree.\n\nLet me know what time.`;
      expect(cleanReplyHistory(input)).toBe(expected);
    });
  });

  describe('cleanMimeBody', () => {
    it('should extract the plain text part from a multipart body and decode it', () => {
      const multipartInput = `--000000000000f5720c0653c097f4
Content-Type: text/plain; charset="UTF-8"
Content-Transfer-Encoding: quoted-printable

Hello Roshana,

Hope this email finds you well. I noticed your brand =E2=80=98Self Employed=E2=80=99 has been growing=3D

Best regards,
Roshana Perera

--000000000000f5720c0653c097f4
Content-Type: text/html; charset="UTF-8"
Content-Transfer-Encoding: quoted-printable

<div dir=3D"ltr">Hello Roshana,<br><br>Hope this email finds you well.</div>

--000000000000f5720c0653c097f4--`;

      const cleaned = cleanMimeBody(multipartInput);
      expect(cleaned).toContain('Hello Roshana');
      expect(cleaned).toContain('growing');
      expect(cleaned).not.toContain('text/html');
      expect(cleaned).not.toContain('Content-Type');
      expect(cleaned).not.toContain('--000000000000f5720c0653c097f4');
    });
  });
});
