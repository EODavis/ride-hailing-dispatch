# Mini Ride-Hailing Dispatch System

<img width="2720" height="1600" alt="ride_hailing_dispatch_architecture" src="https://github.com/user-attachments/assets/ffa4804c-f83d-4e6e-b644-ef527be65115" />



A real-time ride matching system demonstrating WebSockets, geospatial
queries, and — the actual point of the project — a correctly-solved
race condition around assigning a driver to exactly one rider under
true concurrency. Project 15 in a sequential backend engineering
learning journey, and the first project in a deliberately harder,
DevOps-infused trajectory.

## Architecture

- **Location Service** — drivers connect via WebSocket, stream their
  position, stored in Redis's geospatial index (GEOADD)
- **Dispatch Service** — riders connect via WebSocket, request a ride;
  finds nearby drivers via GEOSEARCH, and atomically claims the
  nearest available one using a Lua script (preventing double-assignment)
- **Redis** — geospatial index + atomic claim script + Pub/Sub bridge
  (Dispatch Service can't directly reach a driver's socket, which
  lives in a different process — it publishes a notification instead)

## Tech Stack

- Node.js, `ws` (raw WebSockets), `ioredis`
- Redis 7 (GEO commands + Lua scripting + Pub/Sub)
- Docker Compose

## Getting Started

```bash
docker compose up --build
```

Location Service: `ws://localhost:5001`. Dispatch Service:
`ws://localhost:5002`.

### Simulate drivers and riders

```bash
cd test-clients
npm install
node driver-client.js driver-1
node rider-client.js rider-A 6.5244 3.3792
```

## The Core Problem This Project Solves

Two ride requests can arrive for the same nearby driver at nearly the
same instant. A naive "check if available, then assign" approach has
a race window: both requests could see "available" before either
writes "claimed." This project closes that window using a Redis Lua
script (`dispatch-service/lua/claimDriver.lua`), which Redis executes
atomically — no other command can interleave mid-script. Only one of
two simultaneous claims can ever succeed.

## Project Structure

location-service/ - Driver WebSocket connections, GEO writes, pub/sub subscriber
dispatch-service/ - Rider WebSocket connections, GEO search, atomic claim, pub/sub publisher
lua/claimDriver.lua - The atomic check-and-claim script
test-clients/ - Simulated driver/rider WebSocket clients for testing

## Real Issues Hit and Fixed During This Build

- A single-character typo (`REDIS_URl` vs `REDIS_URL`) caused
  `location-service` to silently fall back to `localhost` instead of
  the Redis container, producing a misleadingly scary
  `MaxRetriesPerRequestError` stack trace that had nothing to do with
  Docker/Compose configuration — confirmed by checking the container's
  actual environment variables directly (`docker compose run --rm ... env`)
  before assuming an infrastructure problem.
  
## Payments, Resilience, and the Saga Pattern (Project 16 extension)

Once a driver is claimed, Dispatch Service charges the rider via a
new **Payment Service** — a deliberately unreliable dependency (~40%
random failure rate, random latency) used to prove the resilience
patterns below actually work, not just look correct on paper.

### Idempotency

Dispatch Service generates one `rideId` per ride and sends it as an
`Idempotency-Key` header on every payment attempt for that ride — including
retries. Payment Service caches the result of the first successful charge
per key, so a retried request can never double-charge the rider.

### Retries with exponential backoff

A failed payment attempt is retried up to 3 times, waiting 200ms, then
400ms, then 800ms between attempts — giving a struggling dependency room
to recover instead of hammering it immediately again.

### Circuit breaker

Payment calls go through an `opossum` circuit breaker. After enough
consecutive failures, the breaker **opens**: further calls fail instantly
with no network attempt at all, for a 10-second cooldown, after which
exactly one trial request (**half-open**) decides whether to close
(resume normal calls) or reopen.

### Saga compensation

If payment ultimately fails (after retries, or because the breaker is
open), the already-claimed driver is NOT left stuck — Dispatch Service
explicitly releases them back to `available` in Redis, and notifies
both the driver and rider. This is a manually-written compensating
action: there is no cross-service database transaction to roll back,
so the undo logic has to be written by hand.

## Updated Project Structure

```payment-service/          - Simulated (flaky) payment provider, idempotency cache
dispatch-service/
  payment.js                - Retry loop + circuit breaker wrapping payment calls
```
