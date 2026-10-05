import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

/**
 * Linkly API load test.
 *
 * The server rate limits link creation per client IP (CREATE_RATE_MAX, 30 per
 * 10 minutes by default) and authentication (AUTH_RATE_MAX, 20 per 15 min).
 * k6 sends every VU from a single address, so both budgets are shared across
 * the whole run and must be raised on the server before this will pass:
 *
 *   CREATE_RATE_MAX=100000 AUTH_RATE_MAX=100000 npm run loadtest
 *
 * Registering one account in setup() also keeps the list and delete endpoints
 * exercised through a real session rather than the operator key.
 */

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';
const PASSWORD = 'loadtest-password';

const listDuration = new Trend('link_list_duration');
const createDuration = new Trend('link_create_duration');
const redirectDuration = new Trend('link_redirect_duration');
const deleteDuration = new Trend('link_delete_duration');
const operationErrors = new Rate('operation_errors');

export const options = {
  stages: [
    { duration: '10s', target: 50 },
    { duration: '10s', target: 100 },
    { duration: '10s', target: 250 },
    { duration: '10s', target: 500 },
    { duration: '10s', target: 1000 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000'],
    link_list_duration: ['p<1000'],
    link_create_duration: ['p(95)<1000'],
    link_redirect_duration: ['p(95)<1000'],
    link_delete_duration: ['p(95)<1000'],
    operation_errors: ['rate<0.01'],
  },
};

/**
 * Registers once and shares the session with every VU. The address is unique
 * per run so repeated runs do not collide with the unique email constraint.
 */
export function setup() {
  const email = `k6-loadtest-${Date.now()}@loadtest.invalid`;

  const res = http.post(
    `${BASE_URL}/api/auth/register`,
    JSON.stringify({ email, password: PASSWORD }),
    { headers: { 'Content-Type': 'application/json' }, tags: { name: 'POST /api/auth/register' } }
  );

  if (res.status !== 201) {
    throw new Error(`setup failed: register returned ${res.status} — ${res.body}`);
  }

  return { email, token: res.json('token') };
}

export default function (data) {
  const auth = { Authorization: `Bearer ${data.token}` };
  let created = null;

  // --- list (own links only, via session) ---
  let res = http.get(`${BASE_URL}/api/links?limit=50`, {
    headers: auth,
    tags: { name: 'GET /api/links' },
  });
  listDuration.add(res.timings.duration);

  if (
    !check(res, {
      'LIST: status 200': (r) => r.status === 200,
      'LIST: valid JSON': (r) => {
        try {
          return Array.isArray(r.json());
        } catch {
          return false;
        }
      },
      // Listing must never hand back a guest delete secret.
      'LIST: no owner tokens': (r) => {
        try {
          return r.json().every((l) => !('ownerToken' in l));
        } catch {
          return false;
        }
      },
    })
  ) {
    operationErrors.add(1);
  }

  // --- create ---
  const destinationUrl = `https://example.com/k6-vu-${__VU}-iter-${__ITER}`;

  res = http.post(
    `${BASE_URL}/api/links`,
    JSON.stringify({ destinationUrl }),
    {
      headers: { ...auth, 'Content-Type': 'application/json' },
      tags: { name: 'POST /api/links' },
    }
  );
  createDuration.add(res.timings.duration);

  if (
    check(res, {
      'CREATE: status 201': (r) => r.status === 201,
      'CREATE: returns short code': (r) => Boolean(r.json('code')),
      // A signed-in creator is owned by the session, so no guest token.
      'CREATE: no guest token': (r) => !('ownerToken' in r.json()),
    })
  ) {
    created = res.json();
  } else {
    operationErrors.add(1);
  }

  // --- redirect ---
  if (created?.code) {
    res = http.get(`${BASE_URL}/${created.code}`, {
      redirects: 0,
      tags: { name: 'GET /:code' },
    });
    redirectDuration.add(res.timings.duration);

    if (
      !check(res, {
        'REDIRECT: status 302': (r) => r.status === 302,
        'REDIRECT: correct Location': (r) => r.headers.Location === destinationUrl,
        'REDIRECT: not cacheable': (r) => (r.headers['Cache-Control'] || '').includes('no-store'),
      })
    ) {
      operationErrors.add(1);
    }
  }

  // --- delete, authorised by the session ---
  if (created?.id) {
    res = http.del(`${BASE_URL}/api/links/${created.id}`, {
      headers: auth,
      tags: { name: 'DELETE /api/links/:id' },
    });
    deleteDuration.add(res.timings.duration);

    if (!check(res, { 'DELETE: status 200': (r) => r.status === 200 })) {
      operationErrors.add(1);
    }
  }

  sleep(0.1);
}

/** Signs the shared test account out so its session does not linger. */
export function teardown(data) {
  http.post(`${BASE_URL}/api/auth/logout`, null, {
    headers: { Authorization: `Bearer ${data.token}` },
    tags: { name: 'POST /api/auth/logout' },
  });
}