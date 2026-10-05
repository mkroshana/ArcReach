# ArcReach 🚀

**ArcReach** is a premium, high-performance internal cold email marketing and outreach automation platform. Built on Next.js 15, PostgreSQL, and Prisma.

---

## 🛠️ Technology Stack

- **Core Framework**: [Next.js 15.5](https://nextjs.org) (App Router, React 19)
- **Database & ORM**: PostgreSQL, managed with [Prisma 6.19](https://prisma.io) (see [schema.prisma](file:///d:/Development/ArcReach/schema.prisma))
- **Email**: Azure Communication Services (`@azure/communication-email`), the only send provider; replies are read over IMAP
- **UI & Styling**: MUI components and Tailwind CSS v4 (set up in `app/globals.css` and `postcss.config.mjs`)
- **Animations**: Framer Motion (via `motion/react`)
- **Telemetry Charts**: [Recharts](https://recharts.org)
- **Icons**: [Lucide React](https://lucide.dev)
- **Tests**: [Vitest](https://vitest.dev)

---

## ✨ Core Features & Modules

1. **Campaign Analytics Dashboard** ([page.tsx](file:///d:/Development/ArcReach/app/page.tsx))
   - Emails Sent, Open Rate, Click Rate and Replies over the last 7, 30 or 90 days, each with its change from the period before, plus Failed Sends, Bounced and Unsubscribed.
   - An Engagement Trends chart (emails sent, opened and clicked each day), a funnel from Sent to Meeting Booked, and a count of leads by the status set on them in Unibox.
   - The outbox status (Running, Stalled, Failing, Not Running or Sending Disabled), read from the send worker's heartbeat and the Azure settings.

2. **Campaign Sequences Builder** ([app/campaigns](file:///d:/Development/ArcReach/app/campaigns))
   - Multi-step sequences with a wait in days before each follow-up (`waitDays`); a step is plain text or HTML, written in place or filled from a template.
   - Personalization variables (`{{firstName}}`, `{{name}}`, `{{company}}`, `{{jobTitle}}`, `{{email}}`) and Spintax (`{Hi|Hello}`).
   - An audience of Valid or Unverified leads or a lead group, a sending window in the campaign's timezone, a pool of the owner's mailboxes to send from, stop-on-reply, and open/click tracking toggles.
   - Only Active campaigns send, and only inside their sending window. A campaign needs a saved sending schedule (days, a start and end time and a timezone) to be published or made Active; without one it stays Draft and sends nothing. Run Now and Send Step queue leads for the send worker rather than sending themselves.

3. **Templates** ([app/templates](file:///d:/Development/ArcReach/app/templates))
   - A library of reusable subjects and bodies with a variable toolbar and a preview for a sample lead.

4. **Sender Accounts & Sending Limits** ([app/accounts](file:///d:/Development/ArcReach/app/accounts))
   - Link multiple sender mailboxes on your verified Azure domains. Azure Communication Services sends all mail, so a mailbox needs no SMTP details; optional IMAP details (e.g. Google Workspace or your own server) let ArcReach read its replies.
   - Per-mailbox stats: sent, delivered, unique opens and clicks, replies and hard bounces, plus the last reply sync and its error.
   - Warmup volume ramp (gradually increases a new mailbox's daily cap; enforced by the send engine). That is all warmup does: there is no warmup network, and no reputation score or inbox placement is measured.
   - A daily cap per mailbox, enforced by the send engine over a rolling 24 hours. Per-minute and per-hour limits are global, set by an admin in Settings, and apply to all mailboxes together.

5. **Lead CRM** ([app/leads](file:///d:/Development/ArcReach/app/leads))
   - A paged lead directory with search and status filters, lead groups, a cross-check of leads in several groups, and Suppressed and Archived tabs.
   - CSV import with column mapping (optionally into a group), CSV export, and each lead's activity timeline of sent emails and replies.
   - Check Domain MX looks up each lead's email domain: a domain that does not exist, or that declares it accepts no mail (a null MX record), marks the lead Invalid, and a failed lookup Risky. It never contacts a mail server, so it cannot confirm that a mailbox exists.
   - Unsubscribed, hard-bounced and Invalid addresses go on a suppression list and are never emailed again, even when re-imported.

6. **Unified Inbox (Unibox)** ([app/unibox](file:///d:/Development/ArcReach/app/unibox))
   - Replies read over IMAP from each mailbox that has IMAP details, grouped into threads by lead and subject, with unread markers that clear when a thread is opened. Bounces and out-of-office replies are flagged and do not pause sequences.
   - Plain-text replies sent through Azure from one of your mailboxes, pausing or resuming a lead's sequence, a lead status set by hand (Interested, Meeting Booked, and so on), search and CSV export.

7. **Settings** ([app/settings](file:///d:/Development/ArcReach/app/settings))
   - My Profile: your name, organization and password.
   - Email Delivery (admins only): the Azure Communication Services connection string and verified sender domains, or Sending Disabled, and the global per-minute and per-hour sending limits.

8. **Users Admin** ([app/admin/users](file:///d:/Development/ArcReach/app/admin/users))
   - Admins add users, promote or demote them, reset their passwords, and disable, enable or delete them. The last admin cannot be demoted or deleted.
   - [middleware.ts](file:///d:/Development/ArcReach/middleware.ts) sends signed-out visitors to the login page and non-admins away from `/admin`; every API route checks the session and the role against the database.

---

## ⚙️ How the Email Send Engine Works

The email dispatch engine is located in [lib/sendEngine.ts](file:///d:/Development/ArcReach/lib/sendEngine.ts). It runs in a background worker that the server starts ([instrumentation.ts](file:///d:/Development/ArcReach/instrumentation.ts) calls [lib/workerDaemon.ts](file:///d:/Development/ArcReach/lib/workerDaemon.ts)) **only when `SEND_WORKER_ENABLED=true`**. Without the flag the process never sends campaign email or syncs IMAP replies: Run Now and Send Step still queue leads, but nothing sends them, and while no process runs the worker the dashboard shows Outbox Not Running. When several processes set the flag, a lease row in the database (`WorkerLease`) lets only one of them run the worker at a time.

The worker sends every 30 seconds and reads new IMAP replies every 3 minutes. Each send run:
- Picks due leads enrolled in Active campaigns, skipping any address on the suppression list.
- Checks the global per-minute and per-hour rate limits (`checkGlobalRateLimits()` in [lib/rateLimits.ts](file:///d:/Development/ArcReach/lib/rateLimits.ts)), each campaign's sending window, and each sender mailbox's daily or warmup cap. A campaign with no complete sending schedule never sends: the engine sets it back to Draft.
- Resolves templated variables and Spintax formats (e.g., `{Hi|Hello}`).
- Sends through Azure Communication Services and records each send as an `EmailDispatch` row. There is no stub or mock provider: until an admin selects Azure and saves its connection string and a verified sender domain in Settings, nothing is sent.
- Pauses a campaign for an hour, then resumes it, when ACS refuses a send for its quota or rate limit.

Azure Event Grid delivery reports are recorded by the webhook route in [app/api/webhook/route.ts](file:///d:/Development/ArcReach/app/api/webhook/route.ts); ACS engagement (open and click) events are acknowledged and ignored, since ArcReach tracks opens and clicks itself. The route authenticates each request via the `X-ArcReach-Webhook-Secret` header (configured as an Event Grid delivery property), checked against the `WEBHOOK_SECRET` env var.

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
- `deliveredAt` is stamped by the Azure delivery webhook when a report says
  Delivered. The webhook records every ACS delivery status in `deliveryStatus`.
  The "Delivered" metric counts the emails whose `deliveryStatus` is Delivered
  and that have no bounce, so an email a later report bounces or files as spam
  (which leaves `deliveredAt` set) counts under that outcome alone. A hard
  bounce sets `bounceType` `hard` with `bouncedAt` and puts the address on the
  suppression list; a soft bounce sets `bounceType` `soft` and leaves the lead
  mailable. Suppressed is always hard. A Failed is hard only when its reason
  names a bad address (5.1.x, "user unknown"). A Bounced is soft when its
  reason shows the refusal was temporary or about the sender rather than the
  address: a 4xx or 4.x.x code, a 5.7.x code, a full mailbox (5.2.2, "mailbox
  full", "over quota", "out of storage"), or spam, junk, phishing, content
  filter, block list ("listed at", DNSBL, RBL), reputation, policy, rate-limit
  or authentication (SPF, DKIM, DMARC) wording. Any other Bounced is hard,
  including one with no reason, and a bad-address code (5.1.x) keeps it hard
  whatever the wording. An IP address quoted in a reason is never read as a
  status code. The Bounced metrics on the dashboard, campaign and
  Accounts pages count hard-bounced dispatches. The webhook answers 500 when an
  event fails so Event Grid redelivers it, and 200 for a message it has no
  dispatch for.

The send engine enforces the dedup guard automatically, so under
normal operation no manual cleanup is required. The one-off maintenance script
[scripts/audit-dispatches.ts](file:///d:/Development/ArcReach/scripts/audit-dispatches.ts)
exists for legacy data created before these guards, or if duplicates ever slip
through. It is **read-only by default** and
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
  or a row whose step was only inferred. A deleted row's tracked links redirect
  only to the domains in `PRE_RESET_LINK_DOMAINS` and otherwise show Link
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
- **Heuristic Prefetch Window**: Clicks and opens within 2 minutes of ACS accepting the send (the dispatch's `acceptedAt`, when it became Sent), or before the send was accepted, are machine events: security gateways fetch the pixel and follow links on delivery, and in production most scanner hits landed within 2 minutes of the send.
- **Link Bursts**: Clicks on two different links of one email within 2 seconds are a scanner following every link, so those clicks become machine clicks.
- **Apple Mail Privacy Protection**: MPP's proxy fetches every pixel when the email arrives, opened or not, under the bare `Mozilla/5.0` user agent, so those fetches are machine opens. Gmail Image Proxy and YahooMailProxy fetch the pixel only when a person opens the email, so they count.
- **Removal of Implicit Opens**: The click tracking endpoint does not auto-generate an open event upon registering a click.
- **HEAD Requests**: Link checkers' HEAD requests to the tracking endpoints are answered but never recorded as opens or clicks.
- **Sent Links Only**: The click endpoint records a click and redirects only when its `url` is exactly one of the links that email sent; anything else gets a neutral Link Unavailable page. A click whose dispatch is gone (mail sent before the 2026-10 campaign history reset, or a row deleted since) records nothing and redirects only to jobpromax.com, thejobhelpers.com, calendly.com or their subdomains (`PRE_RESET_LINK_DOMAINS` in `lib/emailTracking.ts`); any other url gets the same page.

---

## 🚀 Getting Started

### Prerequisites
- Node.js 20.19+ or 22.12+ (the `engines` range in `package.json`; CI and the Azure app run Node 22)
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

   # Hardened Server-Only Secrets (generate each with: openssl rand -hex 32)
   SESSION_SECRET=""
   SECRETS_KEY=""
   WEBHOOK_SECRET=""
   UNSUBSCRIBE_SECRET=""

   # Leave "false" locally: "true" runs the background worker that sends campaign email
   SEND_WORKER_ENABLED="false"
   ```
   `.env.example` lists every variable the app reads, with what each does.

   #### Key Specifications & How to Obtain/Generate Them:
   - **`DATABASE_URL`**: Connection string to the PostgreSQL database instance.
     - *How to Obtain*: 
       - **Local**: Install and run a PostgreSQL server locally on port 5432.
       - **Online (Recommended & Free)**: Sign up at [Neon (neon.tech)](https://neon.tech) or [Supabase (supabase.com)](https://supabase.com) to instantly spin up a serverless cloud PostgreSQL database, and copy the provided connection string.
   - **`APP_URL`**: Absolute URL of the hosted application, the base of every tracked link and unsubscribe link in sent email. Set to `http://localhost:3000` for local development. In production it must be the app's public `https` URL; the server refuses to start while it is unset, not `https` or points at localhost.
   - **`SESSION_SECRET`**: Private signing key for session JWTs.
   - **`SECRETS_KEY`**: Encrypts the Azure connection string and mailbox passwords stored in the database. Keep it once set: stored secrets cannot be decrypted with another key. Set your own locally whenever `DATABASE_URL` points at a shared database, since the local fallback key is published in this repository.
   - **`WEBHOOK_SECRET`**: Secret the Event Grid webhook checks in the `X-ArcReach-Webhook-Secret` header.
   - **`UNSUBSCRIBE_SECRET`**: Signs the unsubscribe link in every campaign email. Keep it once set: changing it breaks the links in email already sent.
   - **`SEND_WORKER_ENABLED`**: `true` starts the background worker that sends campaign email and syncs IMAP replies (see How the Email Send Engine Works). Leave it `false` or unset locally, so `npm run dev` never sends, even against a shared database; only the Azure App Service sets it to `true`.
   - *How to Generate the Secrets*: `openssl rand -hex 32`, or `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Left empty locally, `SESSION_SECRET`, `SECRETS_KEY` and `UNSUBSCRIBE_SECRET` fall back to dev values published in this repository, and the webhook refuses every request. In production the server refuses to start while `SESSION_SECRET`, `SECRETS_KEY` or `UNSUBSCRIBE_SECRET` is unset, shorter than 32 characters, contains `placeholder` or `change_me`, or is an example or dev fallback value published in this repository, and the webhook refuses every request while `WEBHOOK_SECRET` is a placeholder or a published example.


3. **Synchronize database schema:**
   Deploy the database schema via Prisma:
   ```bash
   npx prisma db push
   ```

4. **Seed initial admin user:**
   To create the first admin user, optionally set `ADMIN_EMAIL` (default `admin@arcreach.com`) in your `.env` file, and execute:
   ```bash
   npm run seed
   ```
   The script asks for the admin's password in the terminal, or reads it from `ADMIN_PASSWORD` when that is set. There is no default password. It creates the admin only while the database has no admin at all; once one exists it changes nothing, and it never updates an existing user's password. Change passwords in the app (**Users Admin > Reset password**, or **Settings** for your own).

   `npm run seed:dev` adds the dev users that CI and the integration tests sign in as (`admin-id-999`, `user-id-111`) with a well-known password, so it refuses to run with `NODE_ENV=production` or unless `DATABASE_URL` points at a local database (`localhost`, `127.0.0.1`, `::1` or a socket) or a test database (a name like `arcreach_test`); `npm run seed:dev -- --force` overrides that. `npm run dev` adds the same users on first use under the same conditions.

5. **Launch development server:**
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## ☁️ Azure Deployment (App Service + Git)

ArcReach deploys to **Azure App Service** from the GitHub Actions workflow in [.github/workflows/azure_arcreach-app.yml](file:///d:/Development/ArcReach/.github/workflows/azure_arcreach-app.yml). Pushing to the `azure` branch runs the tests and, when they pass, builds and deploys the app (see What the Workflow Does). The deploy never changes the database, so schema changes and one-off scripts are run by hand first (see Deploying Updates).

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

### Step 2: Push the Schema and Create the First Admin

From your local machine (ensure your IP is whitelisted in the server firewall):

```bash
# Set the Azure DATABASE_URL temporarily
export DATABASE_URL="postgresql://arcadmin:<password>@arcreach-db.postgres.database.azure.com:5432/arcreach?sslmode=require"

# Push schema
npx prisma db push

# Create the first admin (asks for its password; does nothing once an admin exists)
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
   SESSION_SECRET = <output of: openssl rand -hex 32>
   SECRETS_KEY = <output of: openssl rand -hex 32>
   UNSUBSCRIBE_SECRET = <output of: openssl rand -hex 32>
   WEBHOOK_SECRET = <output of: openssl rand -hex 32>
   SEND_WORKER_ENABLED = true
   ```
   Generate a different value for each secret. The server refuses to start without `APP_URL`, `SESSION_SECRET`, `SECRETS_KEY` and `UNSUBSCRIBE_SECRET` set as described under Setup Steps.

   `SEND_WORKER_ENABLED` turns on the background worker that sends campaign email and syncs IMAP replies. Without it the app never sends. Leave it off in local `.env` files.
4. Under **Settings** → **Configuration** → **General settings**, set the **Startup Command**:
   ```
   npm run start
   ```
   The workflow builds the app and ships the build and `node_modules` in its package, so the app only needs starting. Do not add `npm run build` here: it would rebuild the app on every start, which on B1 is slow enough to time out or run out of memory, and nothing sends until it finishes.
5. On the same page, make sure **Always On** is on. Without it App Service unloads the app after 20 minutes without requests, and the send worker stops with it until the next request.

### Step 4: Give the Workflow Access to Azure

The workflow is already in the repository. Do **not** connect GitHub in the App Service's **Deployment Center**: that adds a second workflow for the same app, which deploys without this one's tests and schema check.

The workflow signs in to Azure with OpenID Connect, using the three repository secrets named in its **Login to Azure** step (`AZUREAPPSERVICE_CLIENTID_…`, `AZUREAPPSERVICE_TENANTID_…` and `AZUREAPPSERVICE_SUBSCRIPTIONID_…`). They hold the client, tenant and subscription ids of a Microsoft Entra app registration or user-assigned managed identity with a federated credential for this repository's `azure` branch and permission to deploy to the web app. They are already set for `arcreach-app`. For a different app, create such an identity, add its ids as repository secrets (GitHub → **Settings** → **Secrets and variables** → **Actions**), and change the secret names and `app-name` in the workflow to match. The optional `AZURE_DATABASE_URL` secret is described under Deploying Updates.

### What the Workflow Does

It runs on every push to `azure`, and when started by hand from **Actions** → **Run workflow**. Pushes to other branches and pull requests run nothing. A push's run waits for the previous push's run to finish instead of cancelling it, so deploys land in push order; a newer push replaces a run that is still waiting. Its actions are pinned to commit SHAs.

1. **`test`**: on Node 22 with a Postgres 16 service database (`arcreach_test`), it runs `npm ci`, `npx prisma db push`, `npm run seed:dev` and `npm run test:ci`, then starts `npm run dev` and runs `npm run test:integration` against it.
2. **`build-and-deploy`**: only after `test` passes, and only for a push (a run started by hand tests but never deploys). It runs `npm ci` and `npm run build`, checks the Azure database schema (see Deploying Updates), zips the app with its build and `node_modules` (leaving out `.env*` files), and deploys the zip to the `Production` slot of `arcreach-app`.

### Deploying Updates

Changes that need database work come with deploy steps: a schema push, data cleanup, or one-off scripts to run. Release the database changes first, then the code: code that reads a column the database lacks fails its queries, and some one-off scripts need the new tables.

1. Merge the changes into `azure` locally, without pushing yet:
   ```bash
   git checkout azure
   git merge main
   ```
2. In a shell with `DATABASE_URL` set to the Azure connection string (as in Step 2), do any data cleanup the changes' deploy steps ask for before the schema push, such as removing duplicate rows that a new unique constraint would reject.
3. If `schema.prisma` changed, push it to the Azure database:
   ```bash
   npx prisma db push
   ```
4. Run the one-off scripts the deploy steps list (see One-Off Scripts), each as a dry run first, in the order given.
5. Push to deploy:
   ```bash
   git push origin azure
   ```
6. Once the new code is live, repeat any script the deploy steps say to run again.

#### One-Off Scripts

These bring data written by older versions in line with the current code. Each only reports what it would change unless given its write flag, and is safe to run again. Run them as `npx tsx scripts/<name>.ts` in the shell whose `DATABASE_URL` points at the Azure database.

| Script | What it does | Write flag | Needs |
|---|---|---|---|
| `clear-lead-placeholders.ts` | Clears the stand-in names (the email's local part) and companies (`Unknown`, `Self Employed`, `External Node`) that older imports and Add Lead stored | `--apply` | Run before `normalize-lead-emails.ts` |
| `normalize-lead-emails.ts` | Trims and lowercases lead emails and merges leads that differ only in case | `--apply` | The `LeadAlias` table (db push) and the send worker stopped (`SEND_WORKER_ENABLED=false` on the App Service meanwhile); run again once the release that normalises emails is live |
| `backfill-suppression.ts` | Puts leads already Unsubscribed, Bounced or Invalid on the suppression list and pauses their Active enrollments | `--apply` | The `SuppressedEmail` table (db push) |
| `encrypt-mailbox-secrets.ts` | Encrypts mailbox IMAP passwords stored in plaintext | `--write` | `SECRETS_KEY` set to the App Service's value |
| `audit-dispatches.ts` | Backfills `stepOrder` and deletes duplicate `Sent` dispatches (see Dispatch Metrics & Duplicate Cleanup) | `--backfill`, `--fix` | The schema pushed (db push) |
| `reset-campaign-history.ts` | Deletes every campaign with its emails, events, steps and enrollments, keeping leads, groups, templates, mailboxes and the suppression list. First exports who received what to `--out` (outside the repo) and, as its flags say, suppresses Azure-dropped addresses, resets clock-skew Risky leads and saves progress groups | `--apply` with `--expect-dispatches`, `--expect-host`, `--azure-dropped`, `--clock-skew`, `--save-progress-groups` | No campaign Active or sending, and a noted Azure point-in-time-restore time |

#### Schema Check

The deploy never changes the database schema itself. To stop code reaching the app before its schema, add the Azure connection string as the repository secret **`AZURE_DATABASE_URL`** (GitHub → **Settings** → **Secrets and variables** → **Actions**). The deploy job then runs the read-only `prisma migrate diff --exit-code` against the Azure database before deploying and fails with **Database Schema Is Behind**, listing the differences, while the database does not match `schema.prisma`. Run `npx prisma db push` and re-run the job. Removals count too: a column or table dropped from `schema.prisma` must be dropped from the database before the deploy. Without the secret the check is skipped with a **Database Schema Not Checked** warning. With it, the database firewall must admit GitHub-hosted runners, which have no fixed IP address; when the check cannot connect the deploy fails with **Database Schema Check Failed**.

---

## 🧪 Running Automated Tests

ArcReach features an automated testing architecture to validate both core logic and live endpoints. We use **Vitest** to run our TypeScript test suites.

To run the tests:

1. **Execute the unit test suite** (`tests/unit`; the database is mocked, no server needed):
   ```bash
   npm run test
   ```

2. **Run tests in interactive watch mode:**
   ```bash
   npm run test:watch
   ```

### Integration Tests

The integration tests (`tests/integration`) call the running server and write to its database: they create and delete leads, mailboxes, a campaign, lead groups, templates and a user, and change the global settings. `npm run test` leaves them out, and they refuse to run unless all of these hold:

- **`ARCREACH_INTEGRATION_TESTS=true`** is set for the run. Set it in the shell for that run only, not in `.env`.
- **`DATABASE_URL`** points at a local database (`localhost`, `127.0.0.1`, `::1` or a socket) or a test database (a name like `arcreach_test`), never the shared or production one.
- **The server uses the same database**: it must report the dev admin `admin-id-999` exactly as `DATABASE_URL` holds it.

To run them against a throwaway local database:

1. Point `DATABASE_URL` at it (e.g. `postgresql://postgres:postgres@localhost:5432/arcreach_test`), then run `npx prisma db push` and `npm run seed:dev`.
2. Save a verified Azure sender domain in **Settings**: the mailbox tests need one.
3. Start the server on that database with `npm run dev`, and in a second terminal with the same `DATABASE_URL`:
   ```bash
   ARCREACH_INTEGRATION_TESTS=true npm run test:integration
   ```
   In PowerShell: `$env:ARCREACH_INTEGRATION_TESTS='true'; npm run test:integration`

Every row the tests create is deleted in `afterAll` (their campaign, which stays Draft, is paused first), and the global settings and the admin's name and organization are put back after the settings tests, even when a test fails part way. CI sets the flag for its `arcreach_test` Postgres service container.

