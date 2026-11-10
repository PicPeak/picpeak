'use strict';

/**
 * Calendar days stay on their day in every server zone.
 *
 * node-pg reads a `date` column as a Date at LOCAL midnight, and several
 * places turned that (or another local-midnight Date) into a day with
 * toISOString / getUTC*, which is the day before east of UTC: the admin
 * calendar, the dashboard day buckets, hour-entry invoice lines, the tax
 * report JSON, the event API and webhook event_date, and invoice issue and
 * due days. Event-relative sends also drifted by an hour across DST.
 *
 * A jest worker cannot change its own time zone, so each zone runs
 * helpers/localDayProbe.js in a child node with TZ set.
 */
const path = require('path');
const { execFileSync } = require('child_process');

const PROBE = path.join(__dirname, 'helpers', 'localDayProbe.js');

describe.each(['Europe/Berlin', 'America/New_York', 'Asia/Tokyo', 'Pacific/Honolulu', 'UTC'])('with TZ=%s', (zone) => {
  let out;
  beforeAll(() => {
    out = JSON.parse(execFileSync(process.execPath, [PROBE], {
      env: { ...process.env, TZ: zone },
      encoding: 'utf8',
    }).trim().split('\n').pop());
  });

  it('runs in the zone', () => {
    expect(out.zone).toBe(zone);
  });

  it('issues event-relative invoices on the event day moved by whole days, across DST', () => {
    expect(out.beforeEventPg).toBe('2024-10-26');
    expect(out.beforeEventSqlite).toBe('2024-10-26');
    expect(out.afterEventPg).toBe('2024-11-19');
    expect(out.afterDeliveryPg).toBe('2024-11-03');
    expect(out.afterDeliverySqlite).toBe('2024-11-03');
    // The send itself stays at local midnight, not an hour off after DST.
    expect(out.sendAtLocalMidnight).toEqual([0, 0]);
  });

  it('issues an accepted-quote invoice on the local day of acceptance', () => {
    expect(out.quoteAccepted).toBe('2024-10-01');
    expect(out.quoteAcceptedJustAfterMidnight).toBe('2024-10-02');
  });

  it('counts due days as calendar days', () => {
    expect(out.dueDay).toBe('2024-11-19');
    expect(out.dueDayFromPg).toBe('2025-01-19');
  });

  it('reads an event day from a pg Date, SQLite text or an ISO string', () => {
    expect(out.localDayStart).toEqual(['2024-08-11', '2024-08-11', '2024-08-11', null, null]);
  });

  it('sends pg dates as their day in the event API, webhooks and the tax report JSON', () => {
    expect(out.webhookPg).toBe('2024-08-11');
    expect(out.webhookSqlite).toBe('2024-08-11');
    expect(out.eventApiPg).toEqual(['2024-08-11', '2024-08-12']);
    // A SQLite value is passed through as stored.
    expect(out.eventApiSqlite).toBe(1723334400000);
    expect(out.taxJson).toEqual(['2024-08-11', '2024-08-12', '2024-08-13', '2024-08-14', '2024-08-01']);
  });

  it('keeps the day in hour-entry lines, the calendar and the dashboard buckets', () => {
    expect(out.hoursLine).toBe('2024-08-11');
    expect(out.calendarDay).toBe('2024-08-11');
    expect(out.dashboardDay).toBe('2024-08-11');
  });
});
