# OAuth token fetch GatewayScript — how it executes

Script: `dfap-oauth.js`

This GatewayScript runs from an **XML Manager scheduled processing policy** on IBM DataPower (API Connect v10.0.8.10). The schedule interval is **120 seconds**. Each tick either skips, health-checks webapi until it is ready, or fetches an OAuth token after a successful health check.

The health check (`/webapi-init-check`) is a built-in gateway probe. It returns success or failure in **milliseconds**. It is not a slow HTTP call. The 20 second delay is the wait **between attempts**, not the time the probe takes to answer.

## Constants

| Name | Value | Meaning |
| --- | --- | --- |
| XML Manager interval | 120s | How often DataPower starts this script |
| `MAX_RETRIES` | 5 | Extra attempts after the first call (6 health checks total) |
| `RETRY_DELAY_MS` | 20000 | 20s wait after a failed health check |
| `HEALTH_CHECK_TIMEOUT_SEC` | 2 | Hang safety if `:9443` is unreachable |
| `TOKEN_TIMEOUT_SEC` | 56 | Timeout for the credentials-manager token GET |

## Execution flow

```
XML Manager fires (every 120s)
        |
        v
oauth_refresh_in_progress == true?
        |
        +-- yes --> log skip, exit (previous token fetch still running)
        |
        no
        |
        v
Set oauth_refresh_in_progress = true
        |
        v
checkWebapi()  ---- GET /webapi-init-check ----
        |
        +-- 200 ----------> fetchToken() immediately
        |                         |
        |                         +-- store system.dfap.test_* and system.dfap.dev_*
        |                         +-- clear flag
        |
        +-- 401 / 403 ----> stop this tick, clear flag
        |
        +-- other failure -> wait 20s, checkWebapi(retriesLeft - 1)
                             (until 6 attempts: t=0,20,40,60,80,100)
                             then clear flag; next XML Manager tick tries again
```

## Step by step

### 1. Overlap skip

At the top of the script:

- Skip only if a **token fetch** is in progress: `oauth_refresh_started_at` is set and newer than `TOKEN_TIMEOUT_SEC + 5s`.
- The flag is **not** set at the start of the health-check loop. A failed first run cannot leave `oauth_refresh_in_progress=true` forever.
- `clearRefreshFlag()` at the start of a normal tick also clears a leftover boolean from the older script.
- `clearRefreshFlag()` and `markRefreshStarted()` initialize `system.dfap = {}` if it does not exist yet.
- The flag is set in `fetchToken()` (`markRefreshStarted`) and cleared when that call finishes.

The schedule itself is never disabled. Skip means “this invocation returns without work.”

### 2. Resolve device, TLS profile, and health-check URL

The script reads `var://service/system/ident` and parses `<device-name>`.

| Device name contains | TLS client profile | Health-check URL |
| --- | --- | --- |
| `apicgw-external`, `dev-gke-gateway`, or `external` | `dhhs_dev_tlsp-client-dev-externalV1.0.0` | `https://apicgw-external-datapower.dhhs-somhub-dev-dp-ns.svc.cluster.local:9443/webapi-init-check` |
| `apicgw-internal` or `internal` | `dhhs_dev_tlsp-client-dev-internalV1.0.0` | `https://apicgw-internal-datapower.dhhs-somhub-dev-dp-ns.svc.cluster.local:9443/webapi-init-check` |

If the profile or URL cannot be resolved (configuration still loading from CMC), that is treated as a retryable failure.

### 3. Health check loop (`checkWebapi`)

This is the **only retry loop**. Pattern: `urlopen` callback + `handleRetry` + `setTimeout`, same as the working OAuth xml-manager script.

Each attempt:

1. GET the health-check URL with the selected TLS profile.
2. Discard the response body (only the status code matters).
3. Branch on the result:

| Health check result | Action |
| --- | --- |
| HTTP **200** | Stop looping. Call `fetchToken()` **immediately** (do not wait for t=120). |
| Connection / DNS / TCP / TLS error (including status 7) | Retry after 20s |
| Any status other than 200, 401, 403 | Retry after 20s |
| HTTP **401** or **403** | Permanent failure. Stop. Clear flag. |
| TLS profile / URL not resolved | Retry after 20s |

If `retriesLeft > 0`, `handleRetry` waits 20 seconds then calls `checkWebapi(retriesLeft - 1)`.

If `retriesLeft` is 0 and the check still failed, this 120s window is done. The next XML Manager tick starts a new loop.

### 4. When health checks run inside one 120s window

Failed attempts are spaced 20 seconds apart. The last attempt is at **t=100**, so a further 20s wait would land on the next schedule.

```
t=0    t=20   t=40   t=60   t=80   t=100                 t=120
check  check  check  check  check  check                 next XML Manager tick
```

- If attempt 1 succeeds at t=0, there is only **one** health check, then the token call.
- Later attempts run **only if earlier ones failed**.
- “200 at t=100” means the **sixth attempt** succeeded in milliseconds, not that the HTTP call was slow.

### 5. Token fetch (`fetchToken`)

Runs **once**, and **only after HTTP 200**.

- GET `http://miintegrate-dev-credentials-manager.dhhs-somhub-dev-dp-ns.svc.cluster.local/token?provider=dev_isd`
- Timeout 56 seconds
- Same TLS client profile as the health check

On HTTP 200/201 with `access_token` in the JSON body, the script writes:

| Variable | Source |
| --- | --- |
| `system.dfap.test_access_token` | `json.access_token` |
| `system.dfap.test_instance_url` | `json.instance_url` |
| `system.dfap.test_issued_at` | `json.issued_at` |
| `system.dfap.dev_access_token` | `json.access_token` |
| `system.dfap.dev_instance_url` | `json.instance_url` |
| `system.dfap.dev_issued_at` | `json.issued_at` |

The token call is **not** retried in this tick. If it fails, the next 120s run health-checks again (expected 200 immediately if webapi is up) and fetches the token then.

## Example timelines

### Webapi already up

```
t=0      health check 200 (milliseconds)
t=0      token fetch starts immediately
         tokens stored, flag cleared
t=120    next run (normal)
```

### Webapi becomes ready around t=45s

```
t=0,20,40   health check fails
t=60        health check 200, token fetch starts immediately
t=120       next run (skipped only if that token fetch is still in progress)
```

### Health check first succeeds at t=100

```
t=0..80  health checks fail
t=100    health check 200, token fetch starts immediately (does not wait for t=120)
t=120    XML Manager fires; script sees flag true and skips
t=100+   token callback finishes (success or fail), flag cleared
t=240    next run proceeds normally
```

The overlap skip exists because the **token** call can take up to 56 seconds. The health check itself does not delay until t=120 after a 200.

## Testing a copy inside an API (common errors)

The XML Manager script is written for a scheduled rule (NULL input/output). A copy pasted into an API GatewayScript action can fail for reasons that are not health-check related.

### 1. `cfg` used before it is assigned (this is the likely error)

This pattern throws immediately on the first line of `checkWebapi`:

```javascript
console.error(cfg.deviceName + ": health check #" + attemptNum + "...");
var cfg = resolveDeviceConfig();
```

`var cfg` is hoisted as `undefined`, so `cfg.deviceName` is `TypeError: Cannot read property 'deviceName' of undefined` (GatewayScript processing error).

Resolve config first, then log:

```javascript
var cfg = resolveDeviceConfig();
console.error(cfg.deviceName + ": health check #" + attemptNum + "...");
```

### 2. `deviceName` is not in scope

In the 401/403 branch, `deviceName` is a local variable inside `resolveDeviceConfig()`. Use `cfg.deviceName`.

### 3. In-progress flag (older copies)

Older copies set `oauth_refresh_in_progress = true` **before** `checkWebapi()`. A synchronous throw left the flag true and every later invoke skipped. Current script sets the flag only when the token fetch starts, ignores a boolean with no timestamp, and expires a timestamp after the token timeout.

### 4. API timeouts vs 20s retries

An API transaction will not wait through t=0..100. Client/API timeouts will kill `setTimeout` retries. For an API smoke test, use `RETRY_DELAY_MS = 1000` and `MAX_RETRIES = 1`, or call the health check once with no retry.

### 5. APIs need a response body

XML Manager scheduled rules use NULL output. An API GatewayScript action usually must write `session.output` (or the next assemble step has no payload). That looks like a runtime error even if logs show success.

## What this script does not do

- It does not retry the token URL in the same tick.
- It does not disable the XML Manager schedule; it only no-ops when the in-progress flag is set.
- It does not wait until t=120 after a successful health check before fetching the token.
