import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Send } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Segmented } from '../../components/ui/Segmented';
import { DeltaBadge, StatCard } from '../../components/ui/StatCard';

describe('components/ui', () => {
  it('Button defaults to type="button" so it never submits a form by accident', () => {
    expect(renderToStaticMarkup(<Button>Export</Button>)).toContain('type="button"');
    expect(renderToStaticMarkup(<Button type="submit">Save</Button>)).toContain('type="submit"');
  });

  it('primary Button text uses text-on-primary, not text-white (light mode remaps text-white to dark)', () => {
    const html = renderToStaticMarkup(<Button variant="primary">Export</Button>);
    expect(html).toContain('text-on-primary');
    expect(html).not.toContain('text-white');
  });

  it('Segmented marks only the chosen option as pressed', () => {
    const html = renderToStaticMarkup(
      <Segmented
        label="Date range"
        value="30d"
        onChange={() => {}}
        options={[
          { value: '7d', label: '7d' },
          { value: '30d', label: '30d' },
        ]}
      />,
    );
    expect(html).toContain('aria-label="Date range"');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-pressed="true"[^>]*>30d</);
  });

  it('DeltaBadge is green when the figure moved the good way and red otherwise', () => {
    expect(renderToStaticMarkup(<DeltaBadge delta={15.53} />)).toMatch(/emerald[\s\S]*\+15\.5%/);
    expect(renderToStaticMarkup(<DeltaBadge delta={-4} />)).toMatch(/rose[\s\S]*-4%/);
    expect(renderToStaticMarkup(<DeltaBadge delta={-4} goodDirection="down" />)).toContain('emerald');
    expect(renderToStaticMarkup(<DeltaBadge delta={0.01} />)).toContain('slate');
  });

  it('StatCard leaves the change row out when there is nothing to compare', () => {
    const withDelta = renderToStaticMarkup(
      <StatCard label="Emails Sent" icon={Send} value="16,431" delta={15.5} comparison="vs. 14,653 last period" />,
    );
    expect(withDelta).toContain('+15.5%');
    expect(withDelta).toContain('vs. 14,653 last period');

    const without = renderToStaticMarkup(<StatCard label="Emails Sent" value="16,431" delta={null} />);
    expect(without).not.toContain('%');
    expect(without).not.toContain('mt-2 ');
  });
});
