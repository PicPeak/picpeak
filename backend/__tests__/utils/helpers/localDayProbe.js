'use strict';

// Child process for localCalendarDays.test.js. A jest worker cannot change
// its own time zone (process.env there is a copy), so each zone runs here with
// TZ set by the parent. The database module is stubbed: everything probed is
// pure. Prints one JSON line.

const fs = require('fs');
const path = require('path');
const Module = require('module');

const SRC = path.resolve(__dirname, '../../../src');
const dbFile = require.resolve(path.join(SRC, 'database/db'));
const stub = new Module(dbFile);
stub.filename = dbFile;
stub.loaded = true;
stub.exports = { db: () => { throw new Error('no database in the probe'); }, withRetry: (fn) => fn() };
require.cache[dbFile] = stub;

// Route-internal helpers, taken from the shipping source (as
// analyticsDateMerge.test.js does).
const { toDateOnly } = require(path.join(SRC, 'utils/dateOnly'));
function routeHelper(file, name) {
  const source = fs.readFileSync(path.join(SRC, file), 'utf8');
  const match = source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  // eslint-disable-next-line no-new-func
  return new Function('toDateOnly', `${match[0]}; return ${name};`)(toDateOnly);
}

const helpers = require(path.join(SRC, 'services/invoice/helpers'));
const { buildEventSubject } = require(path.join(SRC, 'services/webhookService'));
const { mapEventForApi } = require(path.join(SRC, 'services/eventService'));
const { withDayDates } = require(path.join(SRC, 'services/taxReportService'));
const { buildLineItemFromEntry } = require(path.join(SRC, 'services/customerHoursService'))._internal;

// What node-pg hands back for a `date` column in this zone.
const pgDate = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const issue = (trigger, offset, eventDate, base = new Date(2024, 9, 1, 15, 0)) => helpers.issueDayOf(
  helpers.computeScheduledSendAt(trigger, offset, eventDate, base),
);

const out = {
  zone: process.env.TZ,
  // Event-relative issue days, from a pg Date and from SQLite text, across
  // the European (27 Oct) and US (3 Nov) DST changes.
  beforeEventPg: issue('before_event', -10, pgDate('2024-11-05')),
  beforeEventSqlite: issue('before_event', -10, '2024-11-05'),
  afterEventPg: issue('after_event', 30, pgDate('2024-10-20')),
  afterDeliveryPg: issue('after_delivery', 0, pgDate('2024-10-20')),
  afterDeliverySqlite: issue('after_delivery', 0, '2024-10-20'),
  quoteAccepted: issue('quote_accepted', 0, null),
  // Accepted half an hour after local midnight: still that local day.
  quoteAcceptedJustAfterMidnight: issue('quote_accepted', 0, null, new Date(2024, 9, 2, 0, 30)),
  sendAtLocalMidnight: (() => {
    const at = helpers.computeScheduledSendAt('after_event', 30, pgDate('2024-10-20'));
    return [at.getHours(), at.getMinutes()];
  })(),
  dueDay: helpers.addDaysToDay('2024-10-20', 30),
  dueDayFromPg: helpers.addDaysToDay(pgDate('2024-12-20'), 30),
  localDayStart: [pgDate('2024-08-11'), '2024-08-11', '2024-08-11T00:00:00.000Z', null, 'garbage']
    .map((v) => { const d = helpers.localDayStart(v); return d ? toDateOnly(d) : d; }),
  webhookPg: buildEventSubject({ event_date: pgDate('2024-08-11') }).event_date,
  webhookSqlite: buildEventSubject({ event_date: '2024-08-11' }).event_date,
  eventApiPg: (() => {
    const e = mapEventForApi({ id: 1, event_date: pgDate('2024-08-11'), event_end_date: pgDate('2024-08-12') });
    return [e.event_date, e.event_end_date];
  })(),
  eventApiSqlite: mapEventForApi({ id: 1, event_date: 1723334400000 }).event_date,
  taxJson: (() => {
    const r = withDayDates({
      rows: [{ issueDate: pgDate('2024-08-11') }],
      costs: { rows: [{ date: pgDate('2024-08-12') }] },
      ledger: [{ date: pgDate('2024-08-13') }, { date: '2024-08-14' }],
      period: { from: '2024-08-01', to: '2024-08-31' },
    });
    return [r.rows[0].issueDate, r.costs.rows[0].date, r.ledger[0].date, r.ledger[1].date, r.period.from];
  })(),
  hoursLine: buildLineItemFromEntry({
    entry_date: pgDate('2024-08-11'), start_time: '09:00', end_time: '10:00', duration_minutes: 60, description: '',
  }, 10000).description.slice(0, 10),
  calendarDay: routeHelper('routes/adminCalendar.js', 'toIsoDateString')(pgDate('2024-08-11')),
  dashboardDay: routeHelper('routes/adminDashboard.js', 'normaliseDateKey')(pgDate('2024-08-11')),
};

process.stdout.write(`${JSON.stringify(out)}\n`);
