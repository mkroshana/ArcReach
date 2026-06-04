'use client';

export function Background() {
  return (
    <div className="fixed inset-0 h-full w-full z-[-1] overflow-hidden bg-slate-50 dark:bg-[#090a10] transition-colors duration-200">
      {/* Subtle clean vertical & horizontal grid lines (Light Mode) */}
      <div 
        className="absolute inset-0 opacity-[0.035] dark:hidden" 
        style={{ 
          backgroundImage: `
            linear-gradient(to right, rgba(15, 23, 42, 0.4) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(15, 23, 42, 0.4) 1px, transparent 1px)
          `,
          backgroundSize: '40px 40px' 
        }}
      />
      
      {/* Subtle clean vertical & horizontal grid lines (Dark Mode) */}
      <div 
        className="absolute inset-0 hidden dark:block opacity-[0.03]" 
        style={{ 
          backgroundImage: `
            linear-gradient(to right, rgba(255, 255, 255, 0.4) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(255, 255, 255, 0.4) 1px, transparent 1px)
          `,
          backgroundSize: '40px 40px' 
        }}
      />
      
      {/* Faint diagonal ambient light at top-left to provide standard depth */}
      <div className="absolute top-0 left-0 w-[60vw] h-[60vw] rounded-full bg-gradient-to-tr from-blue-500/5 to-transparent blur-[160px] pointer-events-none" />
    </div>
  );
}
