import { describe, it, expect } from 'vitest';
import { applyEmailTracking, sentClickTargets } from '../../lib/emailTracking';

describe('Email Tracking Utilities', () => {
  const dispatchId = 'test-dispatch-id';
  const token = 'test-token';

  describe('Unsubscribe Placeholder Replacements', () => {
    it('should replace custom [[unsubscribe_url]] with the actual unsubscribe URL', () => {
      const body = '<html><body>Click <a href="[[unsubscribe_url]]">here</a> to unsubscribe.</body></html>';
      const result = applyEmailTracking(body, dispatchId, true, false, false, token);

      expect(result).toContain('href="http://localhost:3000/api/unsubscribe?token=test-token"');
      expect(result).not.toContain('[[unsubscribe_url]]');
      // Should not have default footer injected since it had a custom one
      expect(result).not.toContain('If you no longer wish to receive these emails');
    });

    it('should replace custom {{unsubscribe_url}} with the actual unsubscribe URL', () => {
      const body = '<html><body>Click <a href="{{unsubscribe_url}}">here</a> to unsubscribe.</body></html>';
      const result = applyEmailTracking(body, dispatchId, true, false, false, token);

      expect(result).toContain('href="http://localhost:3000/api/unsubscribe?token=test-token"');
      expect(result).not.toContain('{{unsubscribe_url}}');
      // Should not have default footer injected
      expect(result).not.toContain('If you no longer wish to receive these emails');
    });

    it('should replace placeholder even without a token with a generic unsubscribe URL', () => {
      const body = '<html><body>Click <a href="[[unsubscribe_url]]">here</a> to unsubscribe.</body></html>';
      const result = applyEmailTracking(body, dispatchId, true, false, false);

      expect(result).toContain('href="http://localhost:3000/api/unsubscribe"');
      expect(result).not.toContain('[[unsubscribe_url]]');
    });

    it('should inject default footer if no custom unsubscribe is present', () => {
      const body = '<html><body>Hello World!</body></html>';
      const result = applyEmailTracking(body, dispatchId, true, false, false, token);

      expect(result).toContain('If you no longer wish to receive these emails');
      expect(result).toContain('href="http://localhost:3000/api/unsubscribe?token=test-token"');
    });
  });

  describe('Plain-text bodies (H15)', () => {
    it('ends a plain-text body with an Unsubscribe line and adds no pixel or tracked links', () => {
      const body = 'Hi Jane,\n\nSee https://example.com/demo\n\nThanks\n';
      const result = applyEmailTracking(body, dispatchId, false, true, true, token);

      expect(result).toBe(
        'Hi Jane,\n\nSee https://example.com/demo\n\nThanks\n\nUnsubscribe: http://localhost:3000/api/unsubscribe?token=test-token'
      );
    });

    it.each(['[[unsubscribe_url]]', '{{ unsubscribe_url }}'])('fills a plain-text %s placeholder and adds no second line', (placeholder) => {
      const result = applyEmailTracking(`Hi Jane,\n\nOpt out: ${placeholder}`, dispatchId, false, false, false, token);

      expect(result).toBe('Hi Jane,\n\nOpt out: http://localhost:3000/api/unsubscribe?token=test-token');
    });
  });

  describe('Click Tracking Redirection and Exclusion', () => {
    it('should rewrite regular links for tracking', () => {
      const body = '<html><body>Visit <a href="https://example.com/hello">our website</a></body></html>';
      const result = applyEmailTracking(body, dispatchId, true, false, true, token);

      expect(result).toContain('/api/track/click/test-dispatch-id?url=https%3A%2F%2Fexample.com%2Fhello');
    });

    it('should NOT rewrite resolved unsubscribe links for tracking', () => {
      const body = '<html><body>Unsubscribe <a href="[[unsubscribe_url]]">here</a> or <a href="https://example.com/home">home</a></body></html>';
      const result = applyEmailTracking(body, dispatchId, true, false, true, token);

      // The home link should be rewritten
      expect(result).toContain('/api/track/click/test-dispatch-id?url=https%3A%2F%2Fexample.com%2Fhome');
      // The unsubscribe link should NOT be rewritten
      expect(result).toContain('href="http://localhost:3000/api/unsubscribe?token=test-token"');
      expect(result).not.toContain('url=http%3A%2F%2Flocalhost%3A3000%2Fapi%2Funsubscribe');
    });

    it('decodes &amp; in an href before tracking it, so the redirect keeps every query parameter (M32)', () => {
      const body = '<p><a href="https://example.com/demo?utm_source=email&amp;utm_campaign=q4">Book</a></p>';
      const result = applyEmailTracking(body, dispatchId, true, false, true);

      expect(result).toContain(
        `/api/track/click/test-dispatch-id?url=${encodeURIComponent('https://example.com/demo?utm_source=email&utm_campaign=q4')}"`
      );
      expect(result).not.toContain('amp%3B');
    });

    it("keeps a single-quoted href whole when a decoded &#39; puts a quote in its url", () => {
      const result = applyEmailTracking("<a href='https://example.com/?n=D&#39;Arcy'>x</a>", dispatchId, true, false, true);

      expect(result).toBe("<a href='http://localhost:3000/api/track/click/test-dispatch-id?url=https%3A%2F%2Fexample.com%2F%3Fn%3DD%27Arcy'>x</a>");
    });
  });

  describe('sentClickTargets (H23)', () => {
    it('lists the url of each link tracked for this dispatch, decoded as the click route matches it', () => {
      const body = applyEmailTracking(
        '<a href="https://example.com/a?x=1&amp;y=2">a</a> <a href="/pricing">p</a> <a href="mailto:me@example.com">m</a>',
        dispatchId, true, true, true, token
      );

      expect([...sentClickTargets(body, dispatchId)]).toEqual(['https://example.com/a?x=1&y=2', '/pricing']);
    });

    it('reads links tracked before &amp; was decoded as their decoded url', () => {
      const body = `<a href="http://localhost:3000/api/track/click/${dispatchId}?url=${encodeURIComponent('https://example.com/a?x=1&amp;y=2')}">a</a>`;

      expect([...sentClickTargets(body, dispatchId)]).toEqual(['https://example.com/a?x=1&y=2']);
    });

    it("ignores another dispatch's tracked links, and lists a body stored before tracking by its own links", () => {
      const other = applyEmailTracking('<a href="https://example.com/other">o</a>', 'other-dispatch', true, false, true);

      expect(sentClickTargets(other, dispatchId).size).toBe(0);
      expect([...sentClickTargets('<a href="https://example.com/plain">p</a>', dispatchId)]).toEqual(['https://example.com/plain']);
      expect(sentClickTargets(null, dispatchId).size).toBe(0);
    });
  });
});
