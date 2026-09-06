# What Cloudbreak teaches about cloud security

The central idea is simple: a service needs protection and it needs to remain useful. A rule that stops an attack may also stop a customer. Choosing the control is only part of the job; checking that legitimate work still succeeds is part of it too.

Cloudbreak makes that tradeoff visible in a three-minute mission. The player protects Storefront, Accounts, and Dispatch while keeping integrity above zero and serving at least 75 percent of customer requests.

## What the city represents

The buildings represent services. Internet uplinks represent public connections from browsers, applications, and other systems. Customers and attacks use the same connections. Real cloud environments can also use private networks and service-to-service connections; the game shows one simplified public-facing model.

Cyan capsules identify customers. Coral probes, amber swarms, and violet carriers identify authored threat types. Their colors and the warnings help the player learn the matchups. They are not an intrusion-detection system, and those labels are not given to the gateway before it decides.

## Authentication: a working key is one piece of evidence

**Key check** rejects requests with missing or invalid credentials. This stops the coral probes, which present invalid keys. It can also reject legitimate customers without keys. In the authored workload, the public Storefront includes anonymous customers.

The amber swarms and violet carriers present the same valid demonstration credential that authenticated customers use. Authentication admits them. The game makes a narrow point: passing a credential check does not prove that every request is harmless.

In real work, this distinction can matter when troubleshooting an integration that authenticates successfully but makes inappropriate requests or consumes too much capacity. Authentication, permission checks, request validation, and monitoring answer different questions. The Open Worldwide Application Security Project, or OWASP, defines authentication around verifying a claimed identity using authenticators; its guidance also treats automated-attack defenses as a set of controls. [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).

The game's credential is a fixed public demo value. It is not a password-storage system, a full identity provider, or multi-factor authentication. It does not model individual user identities, permission scopes, credential rotation, or revocation.

## Rate limiting: control volume, not intent

**Slow flow** uses a route-wide token bucket with a sustained allowance of one request per second. Each admitted request uses the same allowance, whether it belongs to a customer or an amber swarm. Excess requests receive the HTTP response **429**, meaning the rate limit refused them.

This makes the swarm much less damaging while allowing some traffic through. It cannot guarantee that the admitted traffic will be friendly. It is also a deliberately broad limit: customers compete with the swarm for capacity.

A real implementation might set different limits for customers, tenants, operations, or dependencies. The useful question is which resource needs protection and what legitimate workload must still fit. Microsoft's Azure throttling guidance discusses protecting capacity, handling traffic fairly, and distinguishing application throttling from edge defenses against volumetric attacks. [Azure Throttling pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/throttling).

Cloudbreak does not simulate bandwidth exhaustion or a distributed denial-of-service attack across real infrastructure. Its small, synthetic HTTP workload demonstrates a request-rate decision. OWASP emphasizes that availability defenses depend on the system's architecture and cannot be reduced to one universal control. [OWASP Denial of Service Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html).

## Isolation: containment costs availability

**Close bridge** rejects every request to the selected route with **503**, the game's deliberate unavailable response. Violet carriers have working keys and arrive slowly, so authentication and a modest traffic limit do not reliably stop them. Isolation is the complete barrier available in this mission.

Customers are rejected too. Keeping every bridge closed may protect integrity, but it fails the service target. Reopening a clear route restores the opportunity for useful work.

This is a simplified containment decision. Real incident response can include revoking a compromised credential, narrowing access, blocking a specific source, or isolating a smaller component. The game does not offer those tools, so it should not teach that every suspicious authenticated request requires shutting down an entire service.

Likewise, **Open** is a gameplay state, not advice to remove required authentication after an alert. A production service's baseline controls depend on its purpose, data, users, and threat model. Real systems commonly layer controls; the main game interface uses one preset at a time to make each effect easier to understand.

## What is actually enforced

The mission generator schedules a request before it reaches the visible gate. At arrival, the server issues an actual HTTP request to the game's gateway. The current policy determines the response: **200** for accepted, **401** for failed authentication, **429** for rate limited, or **503** for isolated.

The middleware checks policy and request credentials without the generator's friendly or hostile labels. After the response, the game joins those labels to calculate customer service and fictional damage. The **Inspect** panel and downloadable log expose each recorded request's identifier, route, response, reason, and measured elapsed time.

A visible approach retains its identity when a defense changes. Requests that already crossed the gate keep their decision. The two-second approach is mission timing, not a network-latency measurement. At most 54 actors form the visible sample, so a screen full of traffic is not a one-for-one display of every recorded request.

## How this connects to implementation and troubleshooting

The game invites a familiar sequence of work: identify the affected service, understand the symptom, choose a proportionate change, and check the result for both the problem traffic and legitimate customers.

In an implementation project, similar questions appear when a connector is rejected, an import exceeds a service limit, or a protective change interrupts onboarding. Documentation needs to explain what changed and what the customer should expect. Troubleshooting needs evidence beyond whether one error disappeared.

Nicholas's contributions focused on making that experience understandable: clearer control names, faster onboarding, distinct threats, visible traffic origins, readable damage feedback, and a balance that leaves room to recover from a mistake. Codex implemented the game and its verification tools.

The tests and browser recordings check whether the authored rules behave as described. They do not establish learning effectiveness, certification, or production cloud-security experience. The mission is a teaching model with fixed patterns, fictional integrity, and game credits rather than cloud billing. The primary sources linked here were checked on September 6, 2026.
