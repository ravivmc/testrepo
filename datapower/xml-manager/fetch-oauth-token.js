/**
 * XML Manager scheduled GatewayScript (IBM API Connect / DataPower v10.0.8.10).
 *
 * Flow:
 *   1. Resolve TLS profile and webapi health-check URL from device name.
 *   2. Call /webapi-init-check until HTTP 200 (retry every HEALTH_CHECK_RETRY_MS).
 *   3. Fetch the OAuth token and persist it on system.dfap.*.
 *
 * Retry design (see also PR notes):
 * - Do NOT use a blocking sleep() loop. setTimeout keeps the GatewayScript engine
 *   free between attempts.
 * - Unbounded retries inside one scheduled run are unsafe: the XML Manager will
 *   fire again on the next interval and stack concurrent retry loops. Cap attempts
 *   (MAX_HEALTH_CHECK_ATTEMPTS) and skip if a refresh is already in progress.
 * - Prefer aligning the XML Manager interval with HEALTH_CHECK_RETRY_MS (20s) and
 *   treating each schedule tick as one attempt if you want retries without an
 *   in-script loop. This script still loops so the token is fetched as soon as
 *   webapi is ready, without waiting for the next schedule.
 */
var url = require("urlopen");
var system = require("system-metadata");
var sm = require("service-metadata");

var HEALTH_CHECK_RETRY_MS = 20000;
// 0 = retry until 200 (not recommended). 30 attempts ≈ 10 minutes of 20s waits.
var MAX_HEALTH_CHECK_ATTEMPTS = 30;
var HEALTH_CHECK_TIMEOUT_SEC = 10;
var TOKEN_TIMEOUT_SEC = 56;

var ident = sm.getVar("var://service/system/ident");
var deviceNameMatch = ident.match(/<device-name>(.*?)<\/device-name>/);
var deviceName = deviceNameMatch ? deviceNameMatch[1] : "Device Name Not Found";

var tls_profile;
var healthCheckTarget;

if (deviceName.indexOf("apicgw-external") !== -1 || deviceName.indexOf("dev-gke-gateway") !== -1) {
    tls_profile = "dhhs_dev_tlsp-client-dev-externalV1.0.0";
    healthCheckTarget = "https://apicgw-external-datapower.dhhs-somhub-dev-dp-ns.svc.cluster.local:9443/webapi-init-check";
} else if (deviceName.indexOf("apicgw-internal") !== -1) {
    tls_profile = "dhhs_dev_tlsp-client-dev-internalV1.0.0";
    healthCheckTarget = "https://apicgw-internal-datapower.dhhs-somhub-dev-dp-ns.svc.cluster.local:9443/webapi-init-check";
} else if (deviceName.indexOf("external") !== -1) {
    tls_profile = "dhhs_dev_tlsp-client-dev-externalV1.0.0";
    healthCheckTarget = "https://apicgw-external-datapower.dhhs-somhub-dev-dp-ns.svc.cluster.local:9443/webapi-init-check";
} else if (deviceName.indexOf("internal") !== -1) {
    tls_profile = "dhhs_dev_tlsp-client-dev-internalV1.0.0";
    healthCheckTarget = "https://apicgw-internal-datapower.dhhs-somhub-dev-dp-ns.svc.cluster.local:9443/webapi-init-check";
} else {
    console.error("oauth-token-refresh: unknown device-name '" + deviceName + "', cannot select TLS profile or health-check URL");
    throw new Error("Unknown device-name: " + deviceName);
}

function wait(ms) {
    return new Promise(function (resolve) {
        setTimeout(resolve, ms);
    });
}

function urlOpen(options) {
    return new Promise(function (resolve, reject) {
        url.open(options, function (error, response) {
            if (error) {
                reject(error);
                return;
            }
            resolve(response);
        });
    });
}

function readAsJSON(response) {
    return new Promise(function (resolve, reject) {
        response.readAsJSON(function (error, json) {
            if (error) {
                reject(error);
                return;
            }
            resolve(json);
        });
    });
}

function discardResponse(response) {
    try {
        if (response && typeof response.discard === "function") {
            response.discard();
        }
    } catch (e) {
        // ignore; connection is closed when the callback returns
    }
}

function shouldRetryHealthStatus(statusCode) {
    // Fail fast on client errors that will never become 200 without a config change.
    // Retry connection issues (handled in catch) and 5xx / 429 / unexpected codes.
    if (statusCode === 404 || statusCode === 401 || statusCode === 403) {
        return false;
    }
    return statusCode !== 200;
}

async function waitForWebapiReady() {
    var attempt = 0;
    var lastError;

    while (MAX_HEALTH_CHECK_ATTEMPTS === 0 || attempt < MAX_HEALTH_CHECK_ATTEMPTS) {
        attempt++;
        try {
            var response = await urlOpen({
                target: healthCheckTarget,
                method: "GET",
                headers: {
                    "Accept": "application/json"
                },
                timeout: HEALTH_CHECK_TIMEOUT_SEC,
                sslClientProfile: tls_profile
            });
            var statusCode = response.statusCode;
            discardResponse(response);

            if (statusCode === 200) {
                console.error("oauth-token-refresh: webapi-init-check 200 on attempt " + attempt);
                return;
            }

            lastError = "HTTP " + statusCode;
            if (!shouldRetryHealthStatus(statusCode)) {
                throw new Error("webapi-init-check returned non-retryable status " + statusCode);
            }
            console.error("oauth-token-refresh: webapi-init-check " + statusCode + " on attempt " + attempt + ", retrying in " + HEALTH_CHECK_RETRY_MS + "ms");
        } catch (error) {
            lastError = error;
            if (error && error.message && error.message.indexOf("non-retryable") !== -1) {
                throw error;
            }
            console.error("oauth-token-refresh: webapi-init-check error on attempt " + attempt + ": " + error + ", retrying in " + HEALTH_CHECK_RETRY_MS + "ms");
        }

        if (MAX_HEALTH_CHECK_ATTEMPTS !== 0 && attempt >= MAX_HEALTH_CHECK_ATTEMPTS) {
            break;
        }
        await wait(HEALTH_CHECK_RETRY_MS);
    }

    throw new Error("webapi-init-check did not return 200 after " + attempt + " attempts; last error: " + lastError);
}

async function fetchAndStoreToken() {
    var response = await urlOpen({
        target: "http://miintegrate-dev-credentials-manager.dhhs-somhub-dev-dp-ns.svc.cluster.local/token?provider=dev_isd",
        method: "GET",
        headers: {
            "Accept": "application/json"
        },
        timeout: TOKEN_TIMEOUT_SEC,
        sslClientProfile: tls_profile
    });

    if (response.statusCode !== 200) {
        var code = response.statusCode;
        discardResponse(response);
        throw new Error("token endpoint returned HTTP " + code);
    }

    var json = await readAsJSON(response);

    system.dfap.test_access_token = json.access_token;
    system.dfap.test_instance_url = json.instance_url;
    system.dfap.test_issued_at = json.issued_at;

    system.dfap.dev_access_token = json.access_token;
    system.dfap.dev_instance_url = json.instance_url;
    system.dfap.dev_issued_at = json.issued_at;

    console.error("oauth-token-refresh: stored access token for test and dev catalogs");
}

async function main() {
    if (system.dfap && system.dfap.oauth_refresh_in_progress) {
        console.error("oauth-token-refresh: skip, a refresh is already in progress");
        return;
    }

    system.dfap.oauth_refresh_in_progress = true;
    try {
        await waitForWebapiReady();
        await fetchAndStoreToken();
    } finally {
        system.dfap.oauth_refresh_in_progress = false;
    }
}

main().catch(function (error) {
    console.error("oauth-token-refresh: failed: " + error);
    throw error;
});
