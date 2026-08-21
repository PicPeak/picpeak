/**
 * The person-faces query must table-qualify its WHERE (#1096).
 *
 * `photo_faces` and `photos` BOTH have an event_id, so the moment the join was
 * added a bare `where({ event_id })` became ambiguous. Postgres refuses it —
 *
 *   column reference "event_id" is ambiguous
 *
 * — and the endpoint 500s, which took the Split dialog down with it on every
 * PostgreSQL install. SQLite resolves the ambiguity silently, which is why the
 * suite stayed green and this reached production.
 *
 * Two deliberate choices about HOW this is tested:
 *
 * 1. It imports the builder the route actually calls. An earlier version of
 *    this file re-declared the query locally, which meant the route could
 *    regress to the bare form while these assertions kept passing — a test
 *    that documents a bug without guarding it.
 * 2. It asserts on the emitted SQL rather than executing it. A round-trip test
 *    would run against the SQLite the suite uses and prove nothing about the
 *    engine the bug affects.
 */

process.env.NODE_ENV = 'test';

const knex = require('knex')({ client: 'pg' });
const { buildPersonFacesQuery, PERSON_FACES_LIMIT } = require('../src/routes/adminEvents/faces');

const sql = () => buildPersonFacesQuery(knex, 857, 143).toString();

describe('person faces query', () => {
  it('is the query the route runs, not a copy of it', () => {
    expect(typeof buildPersonFacesQuery).toBe('function');
    expect(sql()).toContain('from "photo_faces"');
  });

  it('qualifies event_id with its table', () => {
    // The bare form is what Postgres rejects.
    expect(sql()).toContain('"photo_faces"."event_id"');
    expect(sql()).not.toMatch(/where\s+"event_id"/i);
  });

  it('qualifies person_id too, so the join cannot shadow it either', () => {
    expect(sql()).toContain('"photo_faces"."person_id"');
    expect(sql()).not.toMatch(/and\s+"person_id"\s*=/i);
  });

  it('still joins photos for the original dimensions', () => {
    // The dimensions are what faceCropStyle scales the bbox against; without
    // the join the crop maths has nothing to work from.
    const s = sql();
    expect(s).toContain('inner join "photos"');
    expect(s).toContain('"photos"."width"');
    expect(s).toContain('"photos"."height"');
  });

  it('caps the list at the limit the UI is told about', () => {
    // The viewer reports truncation using this same number; if they drift, it
    // silently claims a person has fewer appearances than they do.
    expect(PERSON_FACES_LIMIT).toBe(500);
    expect(sql()).toContain(`limit ${PERSON_FACES_LIMIT}`);
  });
});
