/**
 * XML Manager scheduled GatewayScript (IBM API Connect / DataPower v10.0.8.10).
 *
 * XML Manager interval: 120 seconds.
 *
 * Retry pattern matches the working OAuth xml-manager script (urlopen callback +
 * setTimeout recursion). The retry loop is the webapi health check, not the token
 * call. After HTTP 200 from /webapi-init-check, the credentials-manager token is
 * fetched once and stored on system.dfap.*.
 *
 * Health checks run every 20s through the 120s window (t=0,20,40,60,80,100).
 * The next wait is not scheduled at t=120 so this tick does not collide with
 * the next scheduled run. If a late 200 starts a token fetch that crosses 120s,
 * the next tick skips via oauth_refresh_in_progress.
 */
var url = require("urlopen");
var system = require("system-metadata");
var sm = require("service-metadata");

// Extra attempts after the first call. 5 => 6 checks at 0/20/40/60/80/100s.
var MAX_RETRIES = 5;
var RETRY_DELAY_MS = 20000;
var HEALTH_CHECK_TIMEOUT_SEC = 10;
var TOKEN_TIMEOUT_SEC = 56;

function resolveDeviceConfig() {
    var ident = sm.getVar("var://service/system/ident");
    var deviceNameMatch = ident ? ident.match(/<device-name>(.*?)<\/device-name>/) : null;
    var deviceName = deviceNameMatch ? deviceNameMatch[1] : "Device Name Not Found";
    var tls_profile;
    var healthCheckTarget;

    if (deviceName.includes("apicgw-external") || deviceName.includes("dev-gke-gateway") || deviceName.includes("external")) {
        tls_profile = "dhhs_dev_tlsp-client-dev-externalV1.0.0";
        healthCheckTarget = "https://apicgw-external-datapower.dhhs-somhub-dev-dp-ns.svc.cluster.local:9443/webapi-init-check";
    } else if (deviceName.includes("apicgw-internal") || deviceName.includes("internal")) {
        tls_profile = "dhhs_dev_tlsp-client-dev-internalV1.0.0";
        healthCheckTarget = "https://apicgw-internal-datapower.dhhs-somhub-dev-dp-ns.svc.cluster.local:9443/webapi-init-check";
    }

    return {
        deviceName: deviceName,
        tls_profile: tls_profile,
        healthCheckTarget: healthCheckTarget
    };
}

function discardResponse(response) {
    try {
        if (response && typeof response.discard === "function") {
            response.discard();
        }
    } catch (e) {
        // connection closes when the callback returns
    }
}

function clearRefreshFlag() {
    system.dfap.oauth_refresh_in_progress = false;
}

function checkWebapi(retriesLeft) {
    var attemptNum = MAX_RETRIES - retriesLeft + 1;
    console.error("WebAPI init-check attempt #" + attemptNum + ". Retries left: " + retriesLeft);

    var cfg = resolveDeviceConfig();

    if (!cfg.tls_profile || !cfg.healthCheckTarget) {
        console.warn("TLS profile / health-check URL not yet determined for device: " + cfg.deviceName + ". Configuration may be pending. Retrying...");
        handleRetry(retriesLeft, "TLS Profile Not Found");
        return;
    }

    var options = {
        target: cfg.healthCheckTarget,
        method: "GET",
        headers: {
            "Accept": "application/json"
        },
        timeout: HEALTH_CHECK_TIMEOUT_SEC,
        sslClientProfile: cfg.tls_profile
    };

    try {
        url.open(options, function (error, response) {
            if (error) {
                var errStr = JSON.stringify(error);
                console.error("Health-check connection error: " + errStr);

                if (errStr.indexOf("7") !== -1 || errStr.indexOf("TLS") !== -1 || errStr.indexOf("credential") !== -1) {
                    handleRetry(retriesLeft, "TLS Profile Not Available (Status 7)");
                } else {
                    handleRetry(retriesLeft, "General Connection Failure");
                }
                return;
            }

            var statusCode = response.statusCode;
            discardResponse(response);

            if (statusCode === 401 || statusCode === 403) {
                console.error("Permanent authentication error on webapi-init-check (" + statusCode + "). Aborting retries.");
                clearRefreshFlag();
                return;
            }

            if (statusCode !== 200) {
                console.error("webapi-init-check status " + statusCode + ". Retrying...");
                handleRetry(retriesLeft, "Health Check Status " + statusCode);
                return;
            }

            console.error("webapi-init-check 200 on attempt #" + attemptNum + ". Fetching OAuth token.");
            fetchToken(cfg.tls_profile);
        });
    } catch (e) {
        var catchStr = e.toString();
        console.error("Synchronous exception during health-check url.open: " + catchStr);
        if (catchStr.indexOf("TLS") !== -1 || catchStr.indexOf("credential") !== -1) {
            handleRetry(retriesLeft, "TLS Profile Exception (NULL Credentials)");
        } else {
            handleRetry(retriesLeft, "Unexpected Script Exception");
        }
    }
}

function fetchToken(tls_profile) {
    var options = {
        target: "http://miintegrate-dev-credentials-manager.dhhs-somhub-dev-dp-ns.svc.cluster.local/token?provider=dev_isd",
        method: "GET",
        headers: {
            "Accept": "application/json"
        },
        timeout: TOKEN_TIMEOUT_SEC,
        sslClientProfile: tls_profile
    };

    try {
        url.open(options, function (error, response) {
            if (error) {
                console.error("Token connection error: " + JSON.stringify(error));
                clearRefreshFlag();
                return;
            }

            var statusCode = response.statusCode;
            if (statusCode !== 200 && statusCode !== 201) {
                console.error("Token endpoint returned status " + statusCode + ". Not retrying (health check already succeeded).");
                discardResponse(response);
                clearRefreshFlag();
                return;
            }

            response.readAsJSON(function (readError, json) {
                if (readError) {
                    console.error("Error reading token JSON: " + JSON.stringify(readError));
                    clearRefreshFlag();
                    return;
                }

                if (!json || !json.access_token) {
                    console.error("Token response missing access_token: " + JSON.stringify(json));
                    clearRefreshFlag();
                    return;
                }

                system.dfap.test_access_token = json.access_token;
                system.dfap.test_instance_url = json.instance_url;
                system.dfap.test_issued_at = json.issued_at;

                system.dfap.dev_access_token = json.access_token;
                system.dfap.dev_instance_url = json.instance_url;
                system.dfap.dev_issued_at = json.issued_at;

                console.error("Successfully updated OAuth tokens in system.dfap for test and dev catalogs.");
                clearRefreshFlag();
            });
        });
    } catch (e) {
        console.error("Synchronous exception during token url.open: " + e.toString());
        clearRefreshFlag();
    }
}

function handleRetry(retriesLeft, reason) {
    if (retriesLeft > 0) {
        console.warn("Retry reason: " + reason + ". Retrying health check in " + (RETRY_DELAY_MS / 1000) + " seconds...");
        setTimeout(function () {
            checkWebapi(retriesLeft - 1);
        }, RETRY_DELAY_MS);
    } else {
        console.error("No more retries in this 120s window. Last error: " + reason + ". Next XML Manager tick will try again.");
        clearRefreshFlag();
    }
}

if (system.dfap && system.dfap.oauth_refresh_in_progress) {
    console.error("oauth-token-refresh: skip, a refresh from the previous tick is still running");
} else {
    system.dfap.oauth_refresh_in_progress = true;
    checkWebapi(MAX_RETRIES);
}
