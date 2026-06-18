'use client';

import { useState } from 'react';
import { ChevronDown, Type, FileText } from 'lucide-react';

/**
 * VariableToolbar — Reusable toolbar for inserting personalization variables
 * into subject line and body fields across templates and campaign editors.
 *
 * Features a field target selector (Subject/Body) when onInsertSubject is provided,
 * quick-access buttons for common variables, and a "More" dropdown for all options.
 */

interface Variable {
  label: string;
  value: string;
  description: string;
  category: 'personalization' | 'spintax';
}

const VARIABLES: Variable[] = [
  { label: 'First Name', value: '{{firstName}}', description: 'Lead\'s first name', category: 'personalization' },
  { label: 'Full Name', value: '{{name}}', description: 'Lead\'s full name', category: 'personalization' },
  { label: 'Company', value: '{{company}}', description: 'Lead\'s company', category: 'personalization' },
  { label: 'Job Title', value: '{{jobTitle}}', description: 'Lead\'s job title', category: 'personalization' },
  { label: 'Email', value: '{{email}}', description: 'Lead\'s email address', category: 'personalization' },
  { label: 'Greeting', value: '{Hi|Hey|Hello}', description: 'Random greeting spintax', category: 'spintax' },
  { label: 'Opener', value: '{Hope you\'re doing well|Hope this finds you well|Trust you\'re having a great day}', description: 'Opener line spintax', category: 'spintax' },
  { label: 'CTA', value: '{Would love to chat|Happy to hop on a quick call|Let me know if you\'d be open to a brief call}', description: 'Call-to-action spintax', category: 'spintax' },
  { label: 'Custom Spintax', value: '{Option A|Option B}', description: 'Your own custom spintax', category: 'spintax' },
];

const CATEGORY_LABELS: Record<string, string> = {
  personalization: 'Personalization',
  spintax: 'Spintax',
};

const CATEGORY_COLORS: Record<string, { bg: string; text: string; border: string; hoverBg: string }> = {
  personalization: {
    bg: 'bg-blue-50 dark:bg-blue-950/40',
    text: 'text-blue-700 dark:text-blue-400',
    border: 'border-blue-200 dark:border-blue-500/15',
    hoverBg: 'hover:bg-blue-100 dark:hover:bg-blue-900/40',
  },
  spintax: {
    bg: 'bg-violet-50 dark:bg-violet-950/40',
    text: 'text-violet-700 dark:text-violet-400',
    border: 'border-violet-200 dark:border-violet-500/15',
    hoverBg: 'hover:bg-violet-100 dark:hover:bg-violet-900/40',
  },
};

interface VariableToolbarProps {
  /** Insert variable into the body field (default target) */
  onInsert: (value: string) => void;
  /** Insert variable into the subject field (enables target selector) */
  onInsertSubject?: (value: string) => void;
  /** Unused — kept for backwards compatibility */
  compact?: boolean;
}

export default function VariableToolbar({ onInsert, onInsertSubject }: VariableToolbarProps) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [target, setTarget] = useState<'body' | 'subject'>('body');

  const handleInsert = (value: string) => {
    if (target === 'subject' && onInsertSubject) {
      onInsertSubject(value);
    } else {
      onInsert(value);
    }
  };

  // Primary quick-access variables (always visible as buttons)
  const quickVars = VARIABLES.filter(v =>
    ['First Name', 'Company', 'Job Title', 'Greeting'].includes(v.label)
  );

  // All remaining variables in the dropdown
  const dropdownVars = VARIABLES.filter(v =>
    !quickVars.includes(v)
  );

  // Group dropdown vars by category
  const grouped = dropdownVars.reduce<Record<string, Variable[]>>((acc, v) => {
    (acc[v.category] = acc[v.category] || []).push(v);
    return acc;
  }, {});

  return (
    <div className="flex items-center gap-1.5 flex-wrap relative">
      {/* Target selector — only show when both handlers are provided */}
      {onInsertSubject && (
        <div className="flex items-center bg-slate-100 dark:bg-slate-800 rounded-md p-0.5 mr-1">
          <button
            type="button"
            onClick={() => setTarget('subject')}
            title="Insert into Subject Line"
            className={`flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider transition-all cursor-pointer ${
              target === 'subject'
                ? 'bg-white dark:bg-slate-700 text-slate-800 dark:text-white shadow-xs'
                : 'text-slate-450 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
            }`}
          >
            <Type className="w-2.5 h-2.5" />
            Subject
          </button>
          <button
            type="button"
            onClick={() => setTarget('body')}
            title="Insert into Body"
            className={`flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider transition-all cursor-pointer ${
              target === 'body'
                ? 'bg-white dark:bg-slate-700 text-slate-800 dark:text-white shadow-xs'
                : 'text-slate-450 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
            }`}
          >
            <FileText className="w-2.5 h-2.5" />
            Body
          </button>
        </div>
      )}

      {/* Quick-access buttons */}
      {quickVars.map((v) => {
        const colors = CATEGORY_COLORS[v.category];
        return (
          <button
            key={v.label}
            type="button"
            onClick={() => handleInsert(v.value)}
            title={`Insert ${v.value} — ${v.description}`}
            className={`text-[9px] ${colors.bg} ${colors.text} ${colors.border} ${colors.hoverBg} px-2 py-0.5 rounded border uppercase font-bold transition-colors cursor-pointer active:scale-95`}
          >
            + {v.label}
          </button>
        );
      })}

      {/* More dropdown toggle */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setShowDropdown(!showDropdown)}
          className="text-[9px] bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:bg-slate-200 dark:hover:bg-slate-700 px-2 py-0.5 rounded uppercase font-bold transition-colors cursor-pointer flex items-center gap-0.5 active:scale-95"
        >
          More
          <ChevronDown className={`w-2.5 h-2.5 transition-transform ${showDropdown ? 'rotate-180' : ''}`} />
        </button>

        {showDropdown && (
          <>
            {/* Backdrop */}
            <div className="fixed inset-0 z-40" onClick={() => setShowDropdown(false)} />

            {/* Dropdown */}
            <div className="absolute right-0 top-full mt-1 z-50 w-72 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xl overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150">
              {Object.entries(grouped).map(([category, vars]) => (
                <div key={category}>
                  <div className="px-3 py-1.5 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800">
                    <span className="text-[9px] uppercase font-bold tracking-widest text-slate-500 dark:text-slate-400">
                      {CATEGORY_LABELS[category] || category}
                    </span>
                  </div>
                  {vars.map((v) => {
                    const colors = CATEGORY_COLORS[v.category];
                    return (
                      <button
                        key={v.label}
                        type="button"
                        onClick={() => {
                          handleInsert(v.value);
                          setShowDropdown(false);
                        }}
                        className="w-full text-left px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors flex items-center justify-between gap-2 group"
                      >
                        <div className="min-w-0">
                          <span className={`text-[10px] font-bold ${colors.text}`}>+ {v.label}</span>
                          <span className="text-[9px] text-slate-400 dark:text-slate-500 ml-2">{v.description}</span>
                        </div>
                        <code className="text-[8px] text-slate-400 dark:text-slate-600 font-mono bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded flex-shrink-0 max-w-[120px] truncate">
                          {v.value}
                        </code>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
