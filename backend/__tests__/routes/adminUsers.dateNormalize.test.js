/**
 * Pin the date-field normalisation in adminUsers transformer (#485).
 *
 * The Users page crashed on native/SQLite installs because Postgres
 * returned ISO strings while SQLite returned epoch-millisecond
 * integers, and the frontend `parseISO()` blew up on numbers with
 * "e.split is not a function". The transformer now coerces every
 * shape to an ISO 8601 string before serialising.
 *
 * These tests guard the contract so a future refactor can't quietly
 * regress and re-break the same page on the same DB.
 */

const adminUsersRoute = require('../../src/routes/adminUsers');
const { toIso, transformUser, transformInvitation } = adminUsersRoute.__test;

describe('toIso', () => {
  it('passes null and undefined through unchanged', () => {
    expect(toIso(null)).toBeNull();
    expect(toIso(undefined)).toBeUndefined();
    // Empty string also short-circuits — important so an unset
    // last_login renders as "Never" instead of 1970-01-01T00:00:00Z.
    expect(toIso('')).toBe('');
  });

  it('coerces an integer epoch (SQLite shape) to an ISO 8601 string', () => {
    // 2026-05-14T10:00:00.000Z, in epoch ms.
    const epochMs = 1778752800000;
    expect(toIso(epochMs)).toBe('2026-05-14T10:00:00.000Z');
  });

  it('coerces a stringified large integer to an ISO 8601 string', () => {
    // Some SQLite drivers stringify large integers because they
    // overflow JS safe-integer in the driver's serialiser. Re-coerce
    // so the frontend doesn't try to parseISO('1778752800000').
    expect(toIso('1778752800000')).toBe('2026-05-14T10:00:00.000Z');
  });

  it('coerces a Date instance via toISOString', () => {
    const d = new Date('2026-01-01T12:34:56.000Z');
    expect(toIso(d)).toBe('2026-01-01T12:34:56.000Z');
  });

  it('passes an existing ISO string through unchanged', () => {
    const iso = '2026-05-14T10:00:00.000Z';
    expect(toIso(iso)).toBe(iso);
  });

  it('passes a non-numeric short string (e.g. truncated date) through unchanged', () => {
    // Defensive: anything that isn't a 10+ digit integer string is
    // treated as already-stringified — the date library will surface
    // the failure cleanly if it's malformed, rather than the
    // transformer silently rewriting it.
    expect(toIso('2026-05-14')).toBe('2026-05-14');
  });
});

describe('transformUser', () => {
  it('normalises last_login, created_at, updated_at coming from SQLite', () => {
    const sqliteRow = {
      id: 1,
      username: 'admin',
      email: 'admin@example.com',
      is_active: 1,
      last_login: 1778752800000,            // epoch ms
      last_login_ip: '127.0.0.1',
      created_at: 1778751144600,            // epoch ms
      updated_at: 1778751242320,            // epoch ms
      role_id: 1,
      role_name: 'super_admin',
      role_display_name: 'Super Admin',
      created_by_username: null,
    };

    const out = transformUser(sqliteRow);

    expect(out.lastLogin).toBe('2026-05-14T10:00:00.000Z');
    expect(out.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(out.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // Other fields untouched.
    expect(out.username).toBe('admin');
    expect(out.lastLoginIp).toBe('127.0.0.1');
  });

  it('leaves Postgres ISO strings intact', () => {
    const pgRow = {
      id: 2,
      username: 'second',
      email: 'second@example.com',
      is_active: true,
      last_login: '2026-05-14T10:00:00.000Z',
      created_at: '2026-05-13T08:00:00.000Z',
      updated_at: '2026-05-14T09:00:00.000Z',
    };
    const out = transformUser(pgRow);
    expect(out.lastLogin).toBe('2026-05-14T10:00:00.000Z');
    expect(out.createdAt).toBe('2026-05-13T08:00:00.000Z');
    expect(out.updatedAt).toBe('2026-05-14T09:00:00.000Z');
  });

  it('keeps last_login null when the user has never logged in', () => {
    const out = transformUser({
      id: 3, username: 'fresh', email: 'fresh@example.com',
      is_active: 1, last_login: null,
    });
    expect(out.lastLogin).toBeNull();
  });
});

describe('transformInvitation', () => {
  it('normalises expires_at and created_at from SQLite epoch-ms', () => {
    const out = transformInvitation({
      id: 9,
      email: 'invitee@example.com',
      expires_at: 1779357600000,
      created_at: 1778752800000,
      role_name: 'admin',
      invited_by: 'admin',
    });
    expect(out.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(out.createdAt).toBe('2026-05-14T10:00:00.000Z');
  });
});
