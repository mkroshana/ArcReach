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
   - Custom timezones and open/click tracking toggles.

3. **Sender Accounts & Sending Limits** ([app/accounts](file:///d:/Development/ArcReach/app/accounts))
   - Link multiple sender mailboxes on your verified Azure domains. Azure Communication Services sends all mail, so a mailbox needs no SMTP details; optional IMAP details (e.g. Google Workspace or your own server) let ArcReach read its replies.
   - Per-mailbox deliverability stats: emails sent/opened/clicked, replies, and bounces.
   - Warmup volume ramp (gradually increases a new mailbox's daily cap; enforced by the send engine).
   - *Planned (schema fields present but not yet computed):* reputation score and spam-save / warmup-network telemetry.
   - A daily cap per mailbox, enforced by the send engine over a rolling 24 hours. Per-minute and per-hour limits are global, set by an admin in Settings, and apply to all mailboxes together.

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
- Checks the global per-minute and per-hour rate limits (`checkGlobalRateLimits()` in [lib/rateLimits.ts](file:///d:/Development/ArcReach/lib/rateLimits.ts)), each campaign's sending window, and each sender mailbox's daily or warmup cap.
- Resolves templated variables and Spintax formats (e.g., `{Hi|Hello}`).
- Interfaces with Azure Communication Services (stubbed in development) and logs dispatches.

Azure Event Grid webhook events (delivery confirmations, opens, clicks) are captured and parsed by the webhook route in [app/api/webhook/route.ts](file:///d:/Development/ArcReach/app/api/webhook/route.ts). The route authenticates each request via the `X-ArcReach-Webhook-Secret` header (configured as an Event Grid delivery property), checked against the `WEBHOOK_SECRET` env var.

---

## 🧹 Dispatch Metrics & Duplicate Cleanup

Each outbound email writes an `EmailDispatch` row. To keep the campaign metrics
(Total Sent Requests / Emails Sent / Delivered / Opens / Clicks) accurate:

- A dispatch's `status` is `Sending` (recorded before the provider call), `Sent`
  (accepted by the provider), `Failed`, or `Unknown`. Only `Sent` rows count
  toward the "Emails Sent" figure.
- A send interrupted by a crash or restart leaves its dispatch `Sending`. Every
  5 minutes the worker asks ACS about dispatches `Sending` for over 10 minutes,
  by their stored operation id: an accepted send is recorded `Sent` and the
  enrollment advanced, a failed one is handled like any failed send, and one ACS
  never received is deleted so the step is sent again. A dispatch that cannot be
  checked (no operation id, or ACS no longer knows an operation over a day old)
  becomes `Unknown`: it is never sent again and counts toward sending caps and
  rate limits, but not as sent.
- Every campaign dispatch records its `stepOrder`, and the send engine guards
  against sending the **same step to the same lead twice**. Run Now and Send
  Step only queue leads (mark them due); the send engine sends them. Run Now
  queues leads that are due or that the campaign has not emailed yet, never a
  follow-up before its wait days pass; Send Step queues every lead at its step.
- `deliveredAt` is stamped by the Azure delivery webhook for the "Delivered" metric.
  The webhook records every ACS delivery status in `deliveryStatus`. Bounced and
  Suppressed, and a Failed whose reason names a bad address (5.1.x, "user
  unknown"), are hard bounces: `bounceType` `hard` with `bouncedAt`, and the
  address goes on the suppression list. Any other Failed is a soft bounce that
  leaves the lead mailable. The Bounced metrics on the dashboard, campaign and
  Accounts pages count hard-bounced dispatches. The webhook answers 500 when an
  event fails so Event Grid redelivers it, and 200 for a message it has no
  dispatch for.

The send engine enforces the dedup guard automatically, so under
normal operation no manual cleanup is required. The one-off maintenance script
[scripts/audit-dispatches.ts](file:///d:/Development/ArcReach/scripts/audit-dispatches.ts)
exists for legacy data created before these guards, or if duplicates ever slip
through (e.g. a concurrent cron + manual run). It is **read-only by default** and
lists what each flag would change:

- `--backfill` sets `stepOrder` on a legacy row only when its subject matches
  exactly one step and no other row of the lead has or infers that step. The
  subject match can mistake a follow-up for step 1, so rows matching several
  steps or sharing a step with another row are listed and left alone.
- `--fix` deletes extra `Sent` rows for the same campaign, lead and stored
  `stepOrder`. For each step it keeps the row with events, else with a delivery
  report, else with a provider id, else the earliest. It never deletes a row
  with events, a `Failed`, `Sending` or
  `Unknown` row (a retried step leaves a `Failed` attempt before its `Sent` row),
  or a row whose step was only inferred. A deleted row's tracked links show Link
  Unavailable; its unsubscribe link still works.

```bash
# 1. Apply any schema changes. On Windows, stop the running `next dev` server first —
#    it locks the Prisma engine binary and causes a generate/EPERM error.
npx prisma db push --schema schema.prisma

# 2. Audit historical rows — DRY RUN first (read-only, makes no changes):
npx tsx scripts/audit-dispatches.ts

# 3. Review the listed rows, then backfill stepOrder and delete the duplicate Sent rows:
npx tsx scripts/audit-dispatches.ts --backfill --fix
```

> **Note:** the backfill updates rows one at a time, so against a remote DB it can
> take a few minutes for several thousand rows. The delete phase that follows is
> batched and fast. Neither flag leaves anything a later `--fix` would delete,
> so the script is safe to re-run.

---

## 🤖 Bot Filtering & Engagement-Metric Accuracy

To keep email open and link click metrics accurate and prevent security scanners (e.g. Proofpoint, Barracuda, Mimecast, Microsoft Safelinks) from inflating statistics:

- **Single Source of Truth**: All engagement tracking events (opens and clicks) are generated exclusively from self-hosted tracking endpoints. Webhook telemetry notifications from Azure Communication Services are no-oped to prevent double-counting.
- **Machine Events Are Kept, Not Counted**: Tracking hits judged automated (`lib/botFilter.ts`) are recorded as `machine_open` / `machine_click` events with a `botReason`; open and click metrics count only `open` and `click` events.
- **User-Agent Filtering**: Hits with no User-Agent, or one matching a known email-security scanner, a crawler, a link unfurler (Slack, Teams, WhatsApp, Facebook, LinkedIn...), a headless browser or an HTTP library (curl, python-requests, Go, Java...), are machine events.
- **Heuristic Prefetch Window**: Clicks within 5 seconds and opens within 10 seconds of ACS accepting the send (the dispatch's `acceptedAt`, when it became Sent), or before the send was accepted, are machine events.
- **Link Bursts**: Clicks on two different links of one email within 2 seconds are a scanner following every link, so those clicks become machine clicks.
- **Apple Mail Privacy Protection**: MPP's proxy fetches every pixel when the email arrives, opened or not, under the bare `Mozilla/5.0` user agent, so those fetches are machine opens. Gmail Image Proxy and YahooMailProxy fetch the pixel only when a person opens the email, so they count.
- **Removal of Implicit Opens**: The click tracking endpoint does not auto-generate an open event upon registering a click.
- **HEAD Requests**: Link checkers' HEAD requests to the tracking endpoints are answered but never recorded as opens or clicks.
- **Sent Links Only**: The click endpoint records a click and redirects only when its `url` is exactly one of the links that email sent; anything else, or a click whose dispatch is gone, gets a neutral Link Unavailable page.

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

   # Hardened Server-Only Secrets
   SESSION_SECRET="arcreach_session_secret_jwt_32_chars_long_placeholder"
   WEBHOOK_SECRET="whsec_e9a182c38d4f7281"
   ```

   #### Key Specifications & How to Obtain/Generate Them:
   - **`DATABASE_URL`**: Connection string to the PostgreSQL database instance.
     - *How to Obtain*: 
       - **Local**: Install and run a PostgreSQL server locally on port 5432.
       - **Online (Recommended & Free)**: Sign up at [Neon (neon.tech)](https://neon.tech) or [Supabase (supabase.com)](https://supabase.com) to instantly spin up a serverless cloud PostgreSQL database, and copy the provided connection string.
   - **`APP_URL`**: Absolute URL of the hosted application. Set to `http://localhost:3000` for local development.
   - **`SESSION_SECRET`**: Private signing key for session JWTs. Must be at least 32 characters in production.
   - **`WEBHOOK_SECRET`**: Secret signature verified by the CRM webhook endpoint.
     - *How to Generate*: Any secret string starting with `whsec_` followed by hexadecimal characters (e.g. `whsec_e9a182c38d4f7281`).


3. **Synchronize database schema:**
   Deploy the database schema via Prisma:
   ```bash
   npx prisma db push
   ```

4. **Seed initial admin user:**
   To seed a secure initial admin user in the database, configure the optional environment variables `ADMIN_EMAIL` and `ADMIN_PASSWORD` in your `.env` file, and execute:
   ```bash
   npm run seed
   ```
   If these variables are omitted, the script seeds `admin@arcreach.com` with password `securepassword123` by default.

5. **Launch development server:**
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## ☁️ Azure Deployment (App Service + Git)

ArcReach deploys to **Azure App Service** using **GitHub integration**. Pushing to the `azure` branch triggers an automatic deployment.

### Step 1: Create the Database Manually

Create an **Azure Database for PostgreSQL Flexible Server** via the Azure Portal:

1. Go to **Azure Portal** → **Create a resource** → **Azure Database for PostgreSQL Flexible Server**.
2. Configure:
   - **Server name**: e.g. `arcreach-db`
   - **Region**: Choose your preferred region (e.g. `East US`)
   - **PostgreSQL version**: `15` or `16`
   - **Compute tier**: `Burstable` → `Standard_B1ms` (cheapest)
   - **Storage**: `32 GB`
   - **Admin username**: e.g. `arcadmin`
   - **Admin password**: Choose a strong password
3. Under **Networking**, enable **Allow public access from any Azure service** and add your local IP if you need direct access.
4. After creation, go to **Databases** → **Add** → create a database named `arcreach`.
5. Note down the connection string:
   ```
   postgresql://arcadmin:<password>@arcreach-db.postgres.database.azure.com:5432/arcreach?sslmode=require
   ```

### Step 2: Run Database Migrations

From your local machine (ensure your IP is whitelisted in the server firewall):

```bash
# Set the Azure DATABASE_URL temporarily
export DATABASE_URL="postgresql://arcadmin:<password>@arcreach-db.postgres.database.azure.com:5432/arcreach?sslmode=require"

# Push schema
npx prisma db push

# Seed admin user
npm run seed
```

### Step 3: Create the Azure App Service

1. Go to **Azure Portal** → **Create a resource** → **Web App**.
2. Configure:
   - **Name**: e.g. `arcreach-app` (will be `arcreach-app.azurewebsites.net`)
   - **Runtime stack**: `Node 22 LTS`
   - **Operating System**: `Linux`
   - **Region**: Same region as your database
   - **Pricing plan**: `Basic B1` or higher
3. After creation, go to **Settings** → **Environment variables** and add:
   ```
   DATABASE_URL = postgresql://arcadmin:<password>@arcreach-db.postgres.database.azure.com:5432/arcreach?sslmode=require
   APP_URL = https://arcreach-app.azurewebsites.net
   SESSION_SECRET = <your minimum 32 character session signing key>
   WEBHOOK_SECRET = <your webhook signature secret>
   SEND_WORKER_ENABLED = true
   ```
   `SEND_WORKER_ENABLED` turns on the background worker that sends campaign email and syncs IMAP replies. Without it the app never sends. Leave it off in local `.env` files.
4. Under **Settings** → **Configuration** → **General settings**, set the **Startup Command**:
   ```
   npm run build && npm run start
   ```

### Step 4: Connect GitHub for Auto-Deployment

1. In the App Service, go to **Deployment Center**.
2. Choose **Source**: `GitHub`.
3. Authorize and select:
   - **Organization**: `mkroshana`
   - **Repository**: `ArcReach`
   - **Branch**: `azure`
4. Save. Azure will configure a GitHub Actions workflow or Kudu-based deployment that triggers on every push to the `azure` branch.

### Deploying Updates

```bash
# Switch to the azure branch
git checkout azure

# Merge latest changes from main
git merge main

# Push to trigger deployment
git push origin azure
```

---

## 🧪 Running Automated Tests

ArcReach features an automated testing architecture to validate both core logic and live endpoints. We use **Vitest** to run our TypeScript test suites.

To run the tests:

1. **Ensure the Next.js local server is running** (required for API integration tests):
   ```bash
   npm run dev
   ```

2. **Execute the test suite:**
   ```bash
   npm run test
   ```

3. **Run tests in interactive watch mode:**
   ```bash
   npm run test:watch
   ```

