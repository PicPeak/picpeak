const express = require('express');
const { db } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { sanitizeDays, addDateRangeCondition } = require('../utils/sqlSecurity');
const { formatBoolean } = require('../utils/dbCompat');
const { resolveAdapter } = require('../services/trackers');
const logger = require('../utils/logger');
const { errorResponse, getPagination } = require('../utils/routeHelpers');
const router = express.Router();

/**
 * Normalise a value coming back from `DATE(timestamp)` into a YYYY-MM-DD
 * string. SQLite returns this column as a string already; Postgres' pg
 * driver auto-converts it to a JavaScript Date object, which broke the
 * old `dateObj.date === row.date` merge below — every Postgres install saw
 * an all-zero `chartData[]` even with real traffic (#661 Bug A). Always
 * normalise before comparing.
 */
function normaliseDateKey(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  // Strings might arrive with time component, slice defensively.
  return String(value).slice(0, 10);
}

// Get dashboard statistics
router.get('/stats', adminAuth, requirePermission('analytics.view'), async (req, res) => {
  try {
    // Get active events count
    const activeEvents = await db('events')
      .where('is_active', formatBoolean(true))
      .where('is_archived', formatBoolean(false))
      .count('id as count')
      .first();

    // Get events expiring within 7 days
    const sevenDaysFromNow = new Date();
    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);
    const now = new Date();
    
    const expiringEvents = await db('events')
      .where('is_active', formatBoolean(true))
      .where('is_archived', formatBoolean(false))
      .where('expires_at', '<=', sevenDaysFromNow.toISOString())
      .where('expires_at', '>', now.toISOString())
      .count('id as count')
      .first();

    // Get total photos count
    const totalPhotos = await db('photos')
      .count('id as count')
      .first();

    // Get storage usage (sum of all photo sizes)
    const storageUsed = await db('photos')
      .sum('size_bytes as total')
      .first();

    // Get total views (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const totalViews = await db('access_logs')
      .where('action', 'view')
      .where('timestamp', '>=', thirtyDaysAgo.toISOString())
      .count('id as count')
      .first();

    // Get total downloads (last 30 days) - include both single and bulk downloads
    const totalDownloads = await db('access_logs')
      .whereIn('action', ['download', 'download_all'])
      .where('timestamp', '>=', thirtyDaysAgo.toISOString())
      .count('id as count')
      .first();

    // Get archived events count
    const archivedEvents = await db('events')
      .where('is_archived', formatBoolean(true))
      .count('id as count')
      .first();

    // Get total events count (all events regardless of status) — used by the
    // events list page to render accurate "All (N)" / Total Events counters
    // when the table is server-paginated (#346).
    const totalEvents = await db('events')
      .count('id as count')
      .first();

    // Calculate trends (compare with previous 30 days)
    const sixtyDaysAgo = new Date();
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
    
    const previousViews = await db('access_logs')
      .where('action', 'view')
      .where('timestamp', '>=', sixtyDaysAgo.toISOString())
      .where('timestamp', '<', thirtyDaysAgo.toISOString())
      .count('id as count')
      .first();

    const previousDownloads = await db('access_logs')
      .whereIn('action', ['download', 'download_all'])
      .where('timestamp', '>=', sixtyDaysAgo.toISOString())
      .where('timestamp', '<', thirtyDaysAgo.toISOString())
      .count('id as count')
      .first();

    // Calculate trend percentages
    const viewsTrend = previousViews.count > 0 
      ? ((totalViews.count - previousViews.count) / previousViews.count) * 100 
      : 0;
    
    const downloadsTrend = previousDownloads.count > 0
      ? ((totalDownloads.count - previousDownloads.count) / previousDownloads.count) * 100
      : 0;

    res.json({
      activeEvents: activeEvents.count || 0,
      expiringEvents: expiringEvents.count || 0,
      totalPhotos: totalPhotos.count || 0,
      storageUsed: storageUsed.total || 0,
      totalViews: totalViews.count || 0,
      totalDownloads: totalDownloads.count || 0,
      viewsTrend: Math.round(viewsTrend * 10) / 10,
      downloadsTrend: Math.round(downloadsTrend * 10) / 10,
      archivedEvents: archivedEvents.count || 0,
      totalEvents: totalEvents.count || 0
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to fetch dashboard statistics');
  }
});

// Get recent activity
router.get('/activity', adminAuth, requirePermission('analytics.view'), async (req, res) => {
  try {
    const { limit } = getPagination(req, { limit: 10 });

    const activities = await db('activity_logs')
      .select('activity_logs.*', 'events.event_name')
      .leftJoin('events', 'activity_logs.event_id', 'events.id')
      .orderBy('activity_logs.created_at', 'desc')
      .limit(limit);

    // Format activities
    const formattedActivities = activities.map(activity => ({
      id: activity.id,
      type: activity.activity_type,
      actorType: activity.actor_type,
      actorName: activity.actor_name,
      eventName: activity.event_name,
      metadata: (() => {
        try {
          if (!activity.metadata) return {};
          if (typeof activity.metadata === 'object') return activity.metadata;
          return JSON.parse(activity.metadata);
        } catch (e) {
          logger.warn('Failed to parse metadata for activity:', activity.id, e.message);
          return {};
        }
      })(),
      createdAt: activity.created_at
    }));

    res.json(formattedActivities);
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to fetch activity log');
  }
});

// Get system health status
router.get('/health', adminAuth, requirePermission('settings.view'), async (req, res) => {
  try {
    const os = require('os');
    
    // Check database connectivity
    let dbStatus = 'healthy';
    try {
      await db.raw('SELECT 1');
    } catch (error) {
      dbStatus = 'error';
    }

    // Check email queue
    const [pendingEmails] = await db('email_queue')
      .where('status', 'pending')
      .count('* as count');
    
    const twentyFourHoursAgo = new Date();
    twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);
    
    const [failedEmails] = await db('email_queue')
      .where('status', 'failed')
      .where('scheduled_at', '>=', twentyFourHoursAgo.toISOString())
      .count('* as count');

    const emailStatus = failedEmails.count > 10 ? 'warning' : 'healthy';

    // Check disk space (simplified)
    const storageStatus = 'healthy'; // In production, check actual disk usage

    // Memory usage
    const memoryUsage = {
      total: os.totalmem(),
      free: os.freemem(),
      used: os.totalmem() - os.freemem(),
      percentage: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100)
    };

    const memoryStatus = memoryUsage.percentage > 90 ? 'warning' : 'healthy';

    // Overall health
    const statuses = [dbStatus, emailStatus, storageStatus, memoryStatus];
    let overallHealth = 'healthy';
    if (statuses.includes('error')) overallHealth = 'error';
    else if (statuses.includes('warning')) overallHealth = 'warning';

    res.json({
      overall: overallHealth,
      services: {
        database: dbStatus,
        email: emailStatus,
        storage: storageStatus,
        memory: memoryStatus
      },
      details: {
        emailQueue: {
          pending: pendingEmails.count,
          failed: failedEmails.count
        },
        memory: memoryUsage
      }
    });
  } catch (error) {
    logger.error('Health check error:', error);
    res.status(500).json({ 
      overall: 'error',
      error: 'Failed to check system health' 
    });
  }
});

// Get analytics data for charts
router.get('/analytics', adminAuth, requirePermission('analytics.view'), async (req, res) => {
  try {
    const days = sanitizeDays(req.query.days || 7);
    
    // Generate date range
    const dates = [];
    for (let i = days - 1; i >= 0; i--) {
      dates.push({
        date: new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        views: 0,
        downloads: 0,
        uniqueVisitors: 0
      });
    }

    // Calculate the start date for queries
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startDateStr = startDate.toISOString();

    // Get views per day
    const viewsData = await db('access_logs')
      .select(db.raw('DATE(timestamp) as date'), db.raw('COUNT(*) as count'))
      .where('action', 'view')
      .where('timestamp', '>=', startDateStr)
      .groupByRaw('DATE(timestamp)');

    // Get downloads per day - include both single and bulk downloads
    const downloadsData = await db('access_logs')
      .select(db.raw('DATE(timestamp) as date'), db.raw('COUNT(*) as count'))
      .whereIn('action', ['download', 'download_all'])
      .where('timestamp', '>=', startDateStr)
      .groupByRaw('DATE(timestamp)');

    // Get unique visitors per day
    const visitorsData = await db('access_logs')
      .select(db.raw('DATE(timestamp) as date'), db.raw('COUNT(DISTINCT ip_address) as count'))
      .where('timestamp', '>=', startDateStr)
      .groupByRaw('DATE(timestamp)');

    // Merge data into dates array. row.date is normalised because Postgres
    // returns DATE() as a JS Date while SQLite returns a string (#661 Bug A).
    // Counts come back as strings on Postgres too, so coerce via Number.
    viewsData.forEach(row => {
      const key = normaliseDateKey(row.date);
      const dateObj = dates.find(d => d.date === key);
      if (dateObj) dateObj.views = Number(row.count) || 0;
    });

    downloadsData.forEach(row => {
      const key = normaliseDateKey(row.date);
      const dateObj = dates.find(d => d.date === key);
      if (dateObj) dateObj.downloads = Number(row.count) || 0;
    });

    visitorsData.forEach(row => {
      const key = normaliseDateKey(row.date);
      const dateObj = dates.find(d => d.date === key);
      if (dateObj) dateObj.uniqueVisitors = Number(row.count) || 0;
    });

    // Get top galleries by views with additional metrics
    const topGalleries = await db('access_logs')
      .select('events.id', 'events.event_name', 'events.slug')
      .select(db.raw('COUNT(CASE WHEN action = \'view\' THEN 1 END) as views'))
      .select(db.raw('COUNT(DISTINCT CASE WHEN action = \'view\' THEN ip_address END) as uniqueVisitors'))
      .select(db.raw('COUNT(CASE WHEN action IN (\'download\', \'download_all\') THEN 1 END) as downloads'))
      .join('events', 'access_logs.event_id', 'events.id')
      .where('access_logs.timestamp', '>=', startDateStr)
      .groupBy('events.id', 'events.event_name', 'events.slug')
      .orderBy('views', 'desc')
      .limit(5);

    // Device breakdown — prefer the operator's analytics tracker (Umami /
    // Rybbit) when configured (#661 Bug C + #663 Phase 1). The local
    // access_logs heuristic below produces 0% on installs where guest user
    // agents don't reliably contain "Mobile" / "Tablet" tokens; the tracker
    // adapters track devices natively. Falls back to access_logs when no
    // tracker is configured (provider=none/custom), the upstream call fails,
    // or the response shape doesn't match what we expect.
    let devices = { desktop: 0, mobile: 0, tablet: 0 };
    let devicesSource = 'access_logs';

    const adapter = await resolveAdapter();
    if (adapter) {
      try {
        const trackerDevices = await adapter.fetchDeviceBreakdown({
          startMs: startDate.getTime(),
          endMs: Date.now(),
        });
        if (trackerDevices) {
          devices = trackerDevices;
          devicesSource = adapter.provider;
        }
      } catch (err) {
        logger.warn(`Analytics: ${adapter.provider} device-breakdown fetch failed; falling back to access_logs`, {
          error: err.message,
        });
      }
    }

    if (devicesSource === 'access_logs') {
      // Local heuristic on access_logs user_agent. Coarse — `LIKE` doesn't
      // cover every UA shape (some Android browsers, embedded webviews, etc.)
      // — and counts come back as strings on Postgres, hence Number() below.
      const deviceData = await db('access_logs')
        .select(
          db.raw(`
            CASE
              WHEN user_agent LIKE '%Mobile%' THEN 'mobile'
              WHEN user_agent LIKE '%Tablet%' OR user_agent LIKE '%iPad%' THEN 'tablet'
              ELSE 'desktop'
            END as device_type
          `),
          db.raw('COUNT(*) as count')
        )
        .where('timestamp', '>=', startDateStr)
        .whereNotNull('user_agent')
        .groupBy('device_type');

      const totalDevices = deviceData.reduce((sum, d) => sum + (Number(d.count) || 0), 0);
      if (totalDevices > 0) {
        deviceData.forEach(d => {
          devices[d.device_type] = Math.round(((Number(d.count) || 0) / totalDevices) * 100);
        });
      }
    }

    // Calculate totals for the period (matching /stats logic)
    const totalViews = await db('access_logs')
      .where('action', 'view')
      .where('timestamp', '>=', startDateStr)
      .count('id as count')
      .first();

    const totalDownloadsCount = await db('access_logs')
      .whereIn('action', ['download', 'download_all'])
      .where('timestamp', '>=', startDateStr)
      .count('id as count')
      .first();

    const totalUniqueVisitors = await db('access_logs')
      .where('timestamp', '>=', startDateStr)
      .countDistinct('ip_address as count')
      .first();

    res.json({
      chartData: dates,
      topGalleries,
      devices,
      devicesSource,
      totals: {
        views: totalViews?.count || 0,
        downloads: totalDownloadsCount?.count || 0,
        uniqueVisitors: totalUniqueVisitors?.count || 0
      }
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to fetch analytics data');
  }
});

/**
 * CRM overview stats — quote / invoice counts by status, rolling
 * revenue windows, outstanding payments. Used by the CRM Overview
 * tab at /admin/clients/overview.
 *
 * Permission gate: `bills.view` OR `quotes.view` — either CRM
 * sub-feature unlocks the headline numbers.
 *
 * Currency handling: aggregates sum naively across currencies.
 * Multi-currency installs get a `currency` field set to the
 * business profile's default; admins running mixed-currency books
 * should treat the headline figure as approximate. A multi-currency
 * breakdown can be added later.
 */
router.get('/crm-stats', adminAuth, async (req, res) => {
  try {
    // Either CRM permission is enough — both sub-features stand
    // alone (one studio may bill manually but quote via picpeak,
    // another might invoice but not quote). Permissions aren't
    // attached to req.admin synchronously; we have to ask the DB
    // via userHasAnyPermission so our inline check matches the
    // behaviour of the requirePermission middleware used elsewhere.
    const { userHasAnyPermission } = require('../middleware/permissions');
    const canSeeBills  = await userHasAnyPermission(req.admin.id, ['bills.view']);
    const canSeeQuotes = await userHasAnyPermission(req.admin.id, ['quotes.view']);
    if (!canSeeBills && !canSeeQuotes) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const monthCutoff   = new Date(now -  30 * DAY);
    const quarterCutoff = new Date(now -  90 * DAY);
    const yearCutoff    = new Date(now - 365 * DAY);
    // Calendar year-to-date (Jan 1 of the current year, local time) —
    // the dashboard's revenue "year" tile can toggle between this and
    // the trailing-365-day window.
    const calendarYearCutoff = new Date(new Date(now).getFullYear(), 0, 1);

    // ---- quotes: counts by status ---------------------------------
    let quoteCounts = { draft: 0, sent: 0, accepted: 0, declined: 0, expired: 0, converted: 0 };
    if (canSeeQuotes) {
      try {
        const rows = await db('quotes').select('status').count('id as count').groupBy('status');
        for (const r of rows) {
          if (r.status in quoteCounts) quoteCounts[r.status] = Number(r.count) || 0;
        }
      } catch (e) {
        // Table may not exist on installs without CRM migrations.
        // Treat as all-zero so the page still renders.
      }
    }

    // ---- invoices: counts by status -------------------------------
    let invoiceCounts = { scheduled: 0, sent: 0, paid: 0, overdue: 0, cancelled: 0 };
    let revenueMonthMinor = 0;
    let revenueQuarterMinor = 0;
    let revenueYearMinor = 0;
    let revenueCalendarYearMinor = 0;
    let outstandingTotalMinor = 0;
    let outstandingCount = 0;

    if (canSeeBills) {
      try {
        // Same exclusions as the outstanding calc — Stornorechnungen
        // and monthly drafts skew the per-status counts (Sent
        // includes both real outstanding invoices and credit-note
        // rows; Scheduled includes mid-period accumulators that the
        // admin doesn't think of as "queued invoices" yet).
        const rows = await db('invoices')
          .andWhere(function() {
            this.whereNot('kind', 'storno').orWhereNull('kind');
          })
          .andWhere(function() {
            this.where('is_monthly_draft', false).orWhereNull('is_monthly_draft');
          })
          .select('status').count('id as count').groupBy('status');
        for (const r of rows) {
          if (r.status in invoiceCounts) invoiceCounts[r.status] = Number(r.count) || 0;
        }

        // Revenue windows: sum of `paid_amount_minor` for invoices marked
        // PAID whose payment date (`paid_at`) falls inside the window —
        // cash-basis recognition (revenue counts when the money arrives).
        // Using paid_amount (not total) so partial payments are tracked
        // accurately. Stornos excluded — never status='paid' in normal flow,
        // the guard is defensive.
        //
        // `paid_at` is admin-controllable, so an old/imported invoice lands
        // in the right window without any special-casing here: the mark-paid
        // dialog takes an optional payment date (backdate to when the money
        // actually arrived) and the historical-import route anchors paid_at
        // to the invoice's issue_date.
        const winSum = async (cutoff) => {
          const row = await db('invoices')
            .where('status', 'paid')
            .where('paid_at', '>=', cutoff)
            .andWhere(function() {
              this.whereNot('kind', 'storno').orWhereNull('kind');
            })
            .sum('paid_amount_minor as total')
            .first();
          return Number(row?.total || 0);
        };
        revenueMonthMinor        = await winSum(monthCutoff);
        revenueQuarterMinor      = await winSum(quarterCutoff);
        revenueYearMinor         = await winSum(yearCutoff);
        revenueCalendarYearMinor = await winSum(calendarYearCutoff);

        // Outstanding: every invoice that's been sent but not fully
        // paid (sent + overdue). Outstanding = total - paid. We sum
        // the gap per row rather than `total - sum(paid)` so partial
        // payments contribute correctly.
        //
        // Exclusions:
        //   - kind='storno' rows. Stornorechnungen carry status='sent'
        //     and total_amount_minor < 0; without the filter they slip
        //     through the status check and inflate `invoiceCount` by 1
        //     per Storno (the per-row gap math correctly returns 0 for
        //     the amount, but the row still counts). They're
        //     accounting-side credit notes, not money the customer
        //     owes.
        //   - is_monthly_draft=true rows. Drafts ship via the monthly
        //     cycle and aren't owed money until they leave draft state.
        const openRows = await db('invoices')
          .whereIn('status', ['sent', 'overdue'])
          .andWhere(function() {
            this.whereNot('kind', 'storno').orWhereNull('kind');
          })
          .andWhere(function() {
            // Belt-and-braces: a Storno is uniquely identified by
            // having `cancels_invoice_id` set (migration 114). Even
            // if `kind` is somehow NULL on a Storno row, this catches
            // it. NULL on regular invoices passes through unchanged.
            this.whereNull('cancels_invoice_id');
          })
          .andWhere(function() {
            this.where('is_monthly_draft', false).orWhereNull('is_monthly_draft');
          })
          .andWhere('total_amount_minor', '>=', 0)
          .select('total_amount_minor', 'paid_amount_minor', 'late_fee_amount_minor');
        for (const r of openRows) {
          const total = Number(r.total_amount_minor || 0) + Number(r.late_fee_amount_minor || 0);
          const paid  = Number(r.paid_amount_minor || 0);
          const gap   = Math.max(0, total - paid);
          if (gap > 0) {
            outstandingTotalMinor += gap;
            outstandingCount += 1;
          }
        }
      } catch (e) {
        // Table missing — treat as empty (same as quotes above).
      }
    }

    // Default currency for the headline figure. Pull from
    // business_profile.default_currency when present; the renderer
    // accepts the same fallback chain we use elsewhere.
    let currency = 'CHF';
    try {
      const profile = await db('business_profile').where({ id: 1 }).first();
      if (profile?.default_currency) currency = String(profile.default_currency).toUpperCase();
    } catch (_) { /* leave default */ }

    res.json({
      currency,
      quotes: quoteCounts,
      invoices: invoiceCounts,
      revenue: {
        monthMinor:        revenueMonthMinor,
        quarterMinor:      revenueQuarterMinor,
        yearMinor:         revenueYearMinor,
        calendarYearMinor: revenueCalendarYearMinor,
      },
      outstanding: {
        totalMinor: outstandingTotalMinor,
        invoiceCount: outstandingCount,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to load CRM stats');
  }
});

module.exports = router;