import { describe, it, expect } from 'vitest';

// Copy of the resolver function from app/templates/page.tsx to test its logic in isolation
function resolveTemplateText(text: string, variables: Record<string, string> = { firstName: 'Emily', company: 'Stark Industries' }) {
  if (!text) return '';
  let result = text;
  
  // Replace variables
  result = result.replace(/\{\{firstName\}\}/g, variables.firstName || 'Emily');
  result = result.replace(/\{\{company\}\}/g, variables.company || 'Stark Industries');

  // Basic Spintax solver: {A|B|C} -> selects the first option for consistency in preview
  const spintaxRegex = /\{([^{}]+)\}/g;
  result = result.replace(spintaxRegex, (match, options) => {
    const choices = options.split('|');
    return choices[0] || '';
  });

  return result;
}

describe('Template Resolver Logic', () => {
  it('should replace firstName and company variables correctly', () => {
    const input = 'Hi {{firstName}}, how is everything at {{company}}?';
    const output = resolveTemplateText(input);
    expect(output).toBe('Hi Emily, how is everything at Stark Industries?');
  });

  it('should allow custom variables for replacement override', () => {
    const input = 'Hello {{firstName}}, greetings from {{company}}!';
    const output = resolveTemplateText(input, { firstName: 'Mark', company: 'Oscorp' });
    expect(output).toBe('Hello Mark, greetings from Oscorp!');
  });

  it('should resolve simple spintax pattern using the first option', () => {
    const input = '{Quick question|Hello|Hi} regarding outreach.';
    const output = resolveTemplateText(input);
    expect(output).toBe('Quick question regarding outreach.');
  });

  it('should resolve mixed variables and spintax together', () => {
    const input = '{Hey|Hello} {{firstName}}, check out {this case study|our tool} for {{company}}.';
    const output = resolveTemplateText(input, { firstName: 'Tony', company: 'Stark Ind' });
    expect(output).toBe('Hey Tony, check out this case study for Stark Ind.');
  });

  it('should handle empty input strings gracefully', () => {
    expect(resolveTemplateText('')).toBe('');
  });
});

function isDispatchForStep(dispatchSubject: string, stepSubject: string) {
  if (!dispatchSubject || !stepSubject) return false;
  
  const cleanStep = stepSubject.trim().toLowerCase();
  const cleanDispatch = dispatchSubject.trim().toLowerCase();
  
  if (cleanDispatch === cleanStep) return true;
  
  // Convert step subject to a regex pattern
  // 1. Escape special regex characters
  let pattern = cleanStep.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  
  // 2. Make spaces flexible (allowing optional spaces only at word boundaries)
  pattern = pattern.replace(/\s+/g, '(?:\\s+|\\b)');
  
  // 3. Replace escaped variable markers `\{\{[^}]+\}\}` with wildcards `.*`
  pattern = pattern.replace(/\\\{\\\{[^}]+\\\}\\\}/g, '.*');
  
  // 4. Replace escaped spintax `\{option1\|option2\}` with regex group `(option1|option2)`
  pattern = pattern.replace(/\\\{([^{}]+)\\\}/g, (match, optionsEscaped) => {
    // Unescape the pipe character for the regex group
    const options = optionsEscaped.replace(/\\\|/g, '|');
    return `(${options})`;
  });
  
  try {
    const regex = new RegExp(`^${pattern}\\s*\\.*\\!*\\??$`);
    return regex.test(cleanDispatch);
  } catch (e) {
    return cleanDispatch.includes(cleanStep.replace(/\{\{[^}]+\}\}/g, '').replace(/\{[^}]+\}/g, '').trim());
  }
}

describe('isDispatchForStep Heuristic', () => {
  it('should match exact subjects', () => {
    expect(isDispatchForStep('Outreach', 'Outreach')).toBe(true);
  });

  it('should match subjects with personalized variables', () => {
    expect(isDispatchForStep('Welcome Emily!', 'Welcome {{firstName}}!')).toBe(true);
    expect(isDispatchForStep('Quick question regarding Stark Industries outreach', 'Quick question regarding {{company}} outreach')).toBe(true);
  });

  it('should match subjects with spintax', () => {
    expect(isDispatchForStep('Hi Emily', '{Hi|Hello} {{firstName}}')).toBe(true);
  });

  it('should match single characters or digits', () => {
    expect(isDispatchForStep('2', '2 {{firstName}}')).toBe(true);
    expect(isDispatchForStep('22', '22')).toBe(true);
    expect(isDispatchForStep('22', '2 {{firstName}}')).toBe(false); // should not match partial words
  });

  it('should handle missing subjects gracefully', () => {
    expect(isDispatchForStep('', '')).toBe(false);
    expect(isDispatchForStep('Welcome', '')).toBe(false);
    expect(isDispatchForStep('', 'Welcome')).toBe(false);
  });
});
