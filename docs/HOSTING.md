# Cloudbreak public hosting

Cloudbreak is live at [cloudbreak.onrender.com](https://cloudbreak.onrender.com) on one free Render Node web service in Singapore, matching Ghost Protocol's hosting direction. The September 6, 2026 [public verification receipt](../captures/release/public-check/report.json) records the completed real 180-second mission, independent browser sessions, matching runtime assets, and measured audio output and mute controls. This is a checked release result, not a guarantee of uninterrupted free-tier availability.

The service contains one authored 180-second First Light mission.

## Public release result

The release task confirmed [revision d1d1ef5](https://github.com/JarthurLabs/cloudbreak/commit/d1d1ef5d76ab377f720fd7ed3379a57cb0d65b15) in Render's deployment interface before the browser check. The game health response does not report a commit identifier. The public mission ran on the unmodified server clock with ordinary pointer controls and actual API responses. It won with 79.1 integrity and 918 of 1,071 customers served, or 85.7143 percent. Its 1,964 completed HTTP records reconciled with the counters: 768 hostile requests were rejected and 125 were admitted. Browser errors were empty.

Separate browser contexts received independent owner cookies and sessions. Cross-cookie access to the other mission was rejected. The cookie flags were HttpOnly, Secure and SameSite Strict. The public city image and Firewall Drive file matched the approved local asset hashes.

The audio check captured the browser's final speaker output after the game's master gain and limiter. It measured music before play, near-silent output while muted, and music again after unmuting, without clipping. No private game hooks were used. These are decoded signal measurements, not subjective listening approval. The report contains no owner values or private identifiers.

A public cold start was **not measured**. This single completed run does not establish worldwide performance, prolonged uptime, or simultaneous-user capacity.

## Deployment configuration

Use this repository's [render.yaml](../render.yaml). It selects the free plan, a single instance, Node 24.19.0 and manual deployments. No database, paid disk, external API key or paid service is required.

- Build: `npm ci --include=dev && npm run build`.
- Start: `npm run start:cloud`.
- Health path: `/api/health`.
- `PORT`: supplied by Render; the default is 10000. The hosted entrypoint accepts integers from 1024 through 65535 and binds `0.0.0.0`.
- Public origin: Render's `RENDER_EXTERNAL_URL` supplies the exact HTTPS origin. `CLOUDBREAK_PUBLIC_ORIGIN` can override it for a chosen custom domain. Supply an origin such as `https://cloudbreak.example`, with no trailing slash, path, query or credentials. Only that origin and Host are accepted for public game requests.

Render requires the public bind address and recommends reading its supplied port. Its Node-version settings support the explicit version pin used here. See [Render web services](https://render.com/docs/web-services), [Node version selection](https://render.com/docs/node-version), and [Blueprint configuration](https://render.com/docs/blueprint-spec).

The [cloud entrypoint](../server/cloud.mjs) serves the built `dist` frontend and the API from the same origin. No frontend API URL or cross-origin browser configuration is needed. HTTPS terminates at Render's proxy. The application does not trust forwarded Host headers or turn user input into destinations.

`npm run dev` keeps the UI on loopback 5310 and gateway on loopback 5311. `npm start` serves the built frontend and gateway together on loopback 5311, with reserved fallback ports 5310 through 5319. The normal local entrypoint never opens a public listener merely because `PORT` or `NODE_ENV` is set.

## Sessions and real gateway decisions

Hosted visitors receive separate sessions, policies, rate buckets, counters and authored traffic schedules. Starting, pausing, resuming or restarting one mission does not affect another. Each API read, log download and mission action requires both its random session ID and the browser's random owner cookie. The cookie is HttpOnly, Secure, SameSite Strict, scoped to the host, and expires after six hours. It is session isolation for an anonymous portfolio game, not an account system.

The server retains at most eight sessions. Connected title screens, completed missions and paused missions are protected while heartbeats continue. At capacity, an abandoned session can be reclaimed after thirty seconds without a heartbeat; otherwise session creation returns 429. Mission time pauses after the existing 2.2-second heartbeat timeout. A hidden or disconnected tab can therefore lose an unfinished mission when its slot is needed. Reloading reconnects and creates a new session if the previous one is unavailable.

Each hosted mission keeps the existing caps of 24 authored approaches and 24 emitted HTTP requests per second, eight in flight, and 64 pending approaches. Its two-second authored approach remains separate from the actual policy decision at gate arrival. The eight-session limit bounds aggregate workload; it is not a claim that eight simultaneous players have been load-tested on Render. Local previews retain their prior shared traffic cap and single active mission behavior.

The generator issues actual HTTP requests only to three fixed routes on its own loopback server. Public callers cannot access that internal gateway: each generated fetch carries an unpredictable process-private transport token. Authentication, rate limiting and isolation still receive no role, threat type or fictional damage label. Those authored labels join the completed response afterward. There is no public dispatch endpoint, arbitrary outbound URL, file path, uploaded code, or client-supplied score/result endpoint.

The hosted request log is held in the retained session's memory. It contains only that mission's measured records and can be downloaded through the existing evidence panel. Retry replaces it; session reclamation or process restart removes it. Hosted sessions do not accumulate disk logs. Local mode continues writing its game-owned NDJSON evidence files. The browser retains the existing best score and preferences on the same origin; those settings do not restore an unfinished server mission.

Static serving is confined to real files inside `dist`, including symlink containment checks. JSON command bodies are limited to 8192 bytes; commands validate route IDs and policy fields. Hosted connections are capped at 128, request and header timeouts remain five seconds, API responses are not cached, and hosted pages prevent framing and referrer leakage. The health endpoint returns 503 if the process is stopping or the built frontend index is unavailable; it is a readiness check, not a traffic-capacity or visual-quality certificate.

## Free service limits

The public URL can remain available between visits, but free hosting is not an always-running service. Render documents spin-down after fifteen minutes without incoming traffic and a wake-up of about one minute. Those are provider descriptions, not measured Cloudbreak timings. Running missions and memory logs disappear when the process restarts, redeploys or sleeps. Free-service, bandwidth and build allowances have limits and can be shared across a workspace. No paid upgrade or payment method is required by this configuration. See [Render's free service limits](https://render.com/docs/free).

The deployed health response, actual browser controls, full mission, independent sessions, asset hashes and music controls were checked as described above. Expired-session recovery was checked separately in local browser testing. A public restart-recovery or idle cold-start observation was not part of the completed public run.

## Local release checks

Use Node 24.19.0, matching [.node-version](../.node-version). The commands below exercise the existing gameplay suite and the hosted configuration without creating a remote service.

```sh
npm ci --include=dev
npm test
npm run build
npm run check:hosting
```

[Hosting tests](../tests/hosting.test.mjs) use isolated local port 5314 and check cookie isolation, concurrent schedules, unchanged per-mission limits, real HTTP outcomes, denied gateway injection, body and policy validation, static path containment, log lifecycle and capacity reclamation. Existing approach and gateway fixtures use their own ports.

[The production check](../scripts/check-hosting.mjs) starts the actual hosted entrypoint on isolated port 5315, uses the real default clock and actual HTTP, validates the built HTML and referenced chunks, and runs two short concurrent missions. Its local requests model the public Host and Origin headers. It prints a receipt and closes its own server. It does not contact the user's gateway on 5311, run a full showcase, create fabricated results, or claim public HTTPS/browser/cold-start validation.

Local verification on September 6, 2026 passed all 53 automated tests, including the 46 existing gameplay checks and seven new hosting checks. TypeScript and the Vite production build passed on Node 24.19.0. The actual hosted-entrypoint check served all four referenced built assets and measured eight real HTTP results in each of two independent 3.612-second missions. Both isolated check servers closed successfully. The first combined test run exposed a fixture port collision; assigning the new hosting fixture its own port resolved it without changing any assertions or gameplay behavior.

Gameplay rules, waves, damage values, defense behavior, shared budget, mission duration and victory requirements are unchanged. The gateway, waves, types, defenses and normal local entrypoint remain byte-identical to the pre-hosting release baseline. The hosting change is confined to transport, public session isolation and resource lifetime.
