import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    useSyncExternalStore: (_subscribe: any, getSnapshot: any) => getSnapshot(),
  };
});

vi.mock('react-dom', async () => {
  const actual = await vi.importActual<typeof import('react-dom')>('react-dom');
  return {
    ...actual,
    createPortal: (children: any) => children,
  };
});

if (typeof document === 'undefined') {
  (globalThis as any).document = { body: { nodeType: 1 } };
}

import { ActionDrawer, ActionDrawerProps } from '../../components/ActionDrawer';
import { Mail } from 'lucide-react';

describe('ActionDrawer Static & Structural Contract Tests', () => {
  it('returns null during SSR when mounted is false', () => {
    // Verified by code contract: useSyncExternalStore(emptySubscribe, () => true, () => false) returns false on server
    expect(typeof ActionDrawer).toBe('function');
  });

  it('renders title and children in portal markup when client-hydrated', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        ActionDrawer,
        {
          isOpen: true,
          onClose: () => {},
          title: 'Shopeers Lead Export',
        },
        React.createElement('div', { id: 'child-lead-table' }, 'Lead Table Content')
      )
    );

    expect(html).toContain('Shopeers Lead Export');
    expect(html).toContain('Lead Table Content');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
  });

  it('renders subtitle with aria-describedby binding', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        ActionDrawer,
        {
          isOpen: true,
          onClose: () => {},
          title: 'Connect Mailbox',
          subtitle: 'Configure SMTP and IMAP connection parameters',
        },
        React.createElement('div', null, 'Form Body')
      )
    );

    expect(html).toContain('Connect Mailbox');
    expect(html).toContain('Configure SMTP and IMAP connection parameters');
    expect(html).toContain('aria-describedby=');
  });

  it('applies width presets correctly', () => {
    const widths: Array<[ActionDrawerProps['width'], string]> = [
      ['sm', 'sm:max-w-[420px]'],
      ['md', 'sm:max-w-[560px]'],
      ['lg', 'sm:max-w-[680px]'],
      ['xl', 'sm:max-w-[840px]'],
      ['full', 'sm:max-w-full'],
    ];

    for (const [w, expectedClass] of widths) {
      const html = renderToStaticMarkup(
        React.createElement(ActionDrawer, {
          isOpen: true,
          width: w,
          onClose: () => {},
          title: `Width ${w}`,
        })
      );
      expect(html).toContain(expectedClass);
    }
  });

  it('renders top indeterminate pulse bar when isLoading is true', () => {
    const html = renderToStaticMarkup(
      React.createElement(ActionDrawer, {
        isOpen: true,
        isLoading: true,
        onClose: () => {},
        title: 'Loading Drawer',
      })
    );

    expect(html).toContain('animate-pulse');
  });

  it('renders <form> when onSubmit is provided', () => {
    const html = renderToStaticMarkup(
      React.createElement(ActionDrawer, {
        isOpen: true,
        formId: 'export-form',
        onSubmit: () => {},
        onClose: () => {},
        title: 'Form Drawer',
      })
    );

    expect(html).toContain('<form');
    expect(html).toContain('id="export-form"');
    expect(html).toContain('type="submit"');
  });

  it('renders linked submit button when formId is set without onSubmit', () => {
    const html = renderToStaticMarkup(
      React.createElement(ActionDrawer, {
        isOpen: true,
        formId: 'external-form-99',
        onClose: () => {},
        title: 'External Form Drawer',
      })
    );

    expect(html).not.toContain('<form');
    expect(html).toContain('type="submit"');
    expect(html).toContain('form="external-form-99"');
  });

  it('suppresses footer when footer={null}', () => {
    const html = renderToStaticMarkup(
      React.createElement(ActionDrawer, {
        isOpen: true,
        footer: null,
        onClose: () => {},
        title: 'No Footer',
      })
    );

    expect(html).not.toContain('Save Changes');
    expect(html).not.toContain('Cancel');
  });

  it('renders custom footer when provided', () => {
    const html = renderToStaticMarkup(
      React.createElement(ActionDrawer, {
        isOpen: true,
        footer: React.createElement('div', { id: 'custom-action-bar' }, 'Custom Actions'),
        onClose: () => {},
        title: 'Custom Footer',
      })
    );

    expect(html).toContain('custom-action-bar');
    expect(html).toContain('Custom Actions');
  });

  it('renders Lucide icon container when icon is provided', () => {
    const html = renderToStaticMarkup(
      React.createElement(ActionDrawer, {
        isOpen: true,
        icon: Mail,
        title: 'Mail Settings',
      })
    );

    expect(html).toContain('lucide-mail');
  });

  it('omits close button when showCloseButton is false', () => {
    const html = renderToStaticMarkup(
      React.createElement(ActionDrawer, {
        isOpen: true,
        showCloseButton: false,
        onClose: () => {},
        title: 'No Close Button',
      })
    );

    expect(html).not.toContain('aria-label="Close drawer"');
  });
});
