# ArcReach 🚀

**ArcReach** is a premium, high-performance internal cold email marketing and outreach automation platform. Built on Next.js 15, PostgreSQL, and Prisma.

---

## 🛠️ Technology Stack

- **Core Framework**: [Next.js v15.4.9](https://nextjs.org) (App Router, React 19)
- **Database & ORM**: PostgreSQL, managed with [Prisma v5.22.0](https://prisma.io) (see [schema.prisma](file:///d:/Development/ArcReach/schema.prisma))
- **Styling**: Tailwind CSS v4 (configured in [package.json](file:///d:/Development/ArcReach/package.json))
- **Animations**: Framer Motion (via `motion/react`)
- **Telemetry Charts**: [Recharts](https://recharts.org)
- **Icons**: [Lucide React](https://lucide.dev)

---

## ✨ Core Features & Modules

1. **Campaign Analytics Dashboard** ([page.tsx](file:///d:/Development/ArcReach/app/page.tsx))
   - Live telemetry on Sent Outbound, Unique Opens, Clickthrough Rates, and Sequences Replies.
   - Interactive engagement trends charting with date-range filters.
   
2. **Campaign Sequences Builder** ([app/campaigns](file:///d:/Development/ArcReach/app/campaigns))
   - Create multi-step outreach schedules with granular follow-up intervals (`waitDays`).
   - Personalization variables (`{{firstName}}`, `{{company}}`) and dynamic Spintax template resolution.
   - A/B testing support, custom timezones, and open/click tracking toggles.

3. **Sender Accounts & Throttle Controls** ([app/accounts](file:///d:/Development/ArcReach/app/accounts))
   - Link multiple sender mailboxes (Microsoft 365, Google Workspace, custom SMTP/IMAP).
   - Dynamic deliverability stats: reputations scores, warmup controls, replies count, and spam-save telemetry.
   - Fine-grained throttle configurations (minute limits, hourly limits, and daily caps) evaluated by the sending engine.

4. **Lead CRM & Bulk Validation** ([app/leads](file:///d:/Development/ArcReach/app/leads))
   - Structured table listing lead emails, company variables, verification status, and campaign logs.
   - Interactive CSV/Spreadsheet bulk importer and verification category filters.

5. **Unified Inbox (Unibox)** ([app/unibox](file:///d:/Development/ArcReach/app/unibox))
   - Unified interface grouping incoming lead responses.
   - Sentiment evaluation, unread notification toggling, and quick inline text response drafts.

6. **Workspace Settings** ([app/settings](file:///d:/Development/ArcReach/app/settings))
   - Workspace member invite flow, subscription management, API key controls, and profile configurations.

7. **RBAC & Administration Panel** ([app/admin/users](file:///d:/Development/ArcReach/app/admin/users))
   - Dynamic session swapping widget in the sidebar (Admin vs. Standard User).
   - Next.js middleware route protection (configured in [middleware.ts](file:///d:/Development/ArcReach/middleware.ts)) preventing non-admin access to the users directory.

---

## ⚙️ How the Email Send Engine Works

The background email dispatch engine is located in [lib/sendEngine.ts](file:///d:/Development/ArcReach/lib/sendEngine.ts). It:
- Iterates through due leads enrolled in campaign sequences.
- Evaluates sender-mailbox timezone restrictions and throttle limits using `validateSendingFrequency()`.
- Resolves templated variables and Spintax formats (e.g., `{Hi|Hello}`).
- Interfaces with Azure Communication Services (stubbed in development) and logs dispatches.

Azure Event Grid webhook events (delivery confirmations, opens, clicks) are captured and parsed by the webhook route in [app/api/webhook/route.ts](file:///d:/Development/ArcReach/app/api/webhook/route.ts).

---

## 🚀 Getting Started

### Prerequisites
- Node.js (v18+ recommended)
- PostgreSQL database instance

### Setup Steps
1. **Clone the repository and install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment variables:**
   Create a `.env` file in the root directory (based on [.env.example](file:///d:/Development/ArcReach/.env.example)):
   ```env
   DATABASE_URL="postgresql://username:password@localhost:5432/arcreach?schema=public"
   APP_URL="http://localhost:3000"
   ```

3. **Synchronize database schema:**
   Deploy the database schema via Prisma:
   ```bash
   npx prisma db push
   ```

4. **Launch development server:**
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000) in your browser.
