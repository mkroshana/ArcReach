import { describe, it, expect } from 'vitest';
import { applyEmailTracking, rewriteLinksForTracking, injectUnsubscribeLink } from '../../lib/emailTracking';

describe('Email Tracking Utilities', () => {
  const dispatchId = 'test-dispatch-id';
  const leadId = 'test-lead-id';

  describe('Unsubscribe Placeholder Replacements', () => {
    it('should replace custom [[unsubscribe_url]] with the actual unsubscribe URL', () => {
      const body = '<html><body>Click <a href="[[unsubscribe_url]]">here</a> to unsubscribe.</body></html>';
      const result = applyEmailTracking(body, dispatchId, true, false, false, leadId);
      
      expect(result).toContain('href="http://localhost:3000/api/unsubscribe?id=test-lead-id"');
      expect(result).not.toContain('[[unsubscribe_url]]');
      // Should not have default footer injected since it had a custom one
      expect(result).not.toContain('If you no longer wish to receive these emails');
    });

    it('should replace custom {{unsubscribe_url}} with the actual unsubscribe URL', () => {
      const body = '<html><body>Click <a href="{{unsubscribe_url}}">here</a> to unsubscribe.</body></html>';
      const result = applyEmailTracking(body, dispatchId, true, false, false, leadId);
      
      expect(result).toContain('href="http://localhost:3000/api/unsubscribe?id=test-lead-id"');
      expect(result).not.toContain('{{unsubscribe_url}}');
      // Should not have default footer injected
      expect(result).not.toContain('If you no longer wish to receive these emails');
    });

    it('should replace placeholder even without leadId with a generic unsubscribe URL', () => {
      const body = '<html><body>Click <a href="[[unsubscribe_url]]">here</a> to unsubscribe.</body></html>';
      const result = applyEmailTracking(body, dispatchId, true, false, false);
      
      expect(result).toContain('href="http://localhost:3000/api/unsubscribe"');
      expect(result).not.toContain('[[unsubscribe_url]]');
    });

    it('should inject default footer if no custom unsubscribe is present', () => {
      const body = '<html><body>Hello World!</body></html>';
      const result = applyEmailTracking(body, dispatchId, true, false, false, leadId);
      
      expect(result).toContain('If you no longer wish to receive these emails');
      expect(result).toContain('href="http://localhost:3000/api/unsubscribe?id=test-lead-id"');
    });
  });

  describe('Click Tracking Redirection and Exclusion', () => {
    it('should rewrite regular links for tracking', () => {
      const body = '<html><body>Visit <a href="https://example.com/hello">our website</a></body></html>';
      const result = applyEmailTracking(body, dispatchId, true, false, true, leadId);
      
      expect(result).toContain('/api/track/click/test-dispatch-id?url=https%3A%2F%2Fexample.com%2Fhello');
    });

    it('should NOT rewrite resolved unsubscribe links for tracking', () => {
      const body = '<html><body>Unsubscribe <a href="[[unsubscribe_url]]">here</a> or <a href="https://example.com/home">home</a></body></html>';
      const result = applyEmailTracking(body, dispatchId, true, false, true, leadId);
      
      // The home link should be rewritten
      expect(result).toContain('/api/track/click/test-dispatch-id?url=https%3A%2F%2Fexample.com%2Fhome');
      // The unsubscribe link should NOT be rewritten
      expect(result).toContain('href="http://localhost:3000/api/unsubscribe?id=test-lead-id"');
      expect(result).not.toContain('url=http%3A%2F%2Flocalhost%3A3000%2Fapi%2Funsubscribe');
    });
  });
});
