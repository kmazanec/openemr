<?php

/**
 * Browser → Agent service proxy controller.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Controller;

use GuzzleHttp\Client;
use GuzzleHttp\Exception\GuzzleException;
use GuzzleHttp\RequestOptions;
use OpenEMR\BC\ServiceContainer;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentRequest;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentTokenMinter;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentTokenMintException;
use OpenEMR\Modules\ClinicalCopilot\Auth\PolicyDecision;
use OpenEMR\Modules\ClinicalCopilot\Auth\PolicyGate;
use OpenEMR\Modules\ClinicalCopilot\Auth\SessionContext;
use Psr\Log\LoggerInterface;

/**
 * Single entry point for /agent/{action}.
 *
 * Flow per request:
 *   1. Parse the request → AgentRequest (action, site, requested patient,
 *      requested scopes resolved by the gate's allowlist).
 *   2. PolicyGate denies missing-session, wrong-site, wrong-patient, unknown
 *      action, or out-of-scope requests.
 *   3. AgentTokenMinter signs a 5-minute JWT with OpenEMR's OAuth2 keys
 *      (no self-loopback HTTP — see PRESEARCH §18).
 *   4. Streaming POST to the agent service preserving SSE framing — cURL
 *      with a WRITEFUNCTION callback so each chunk reaches the browser as
 *      it lands rather than buffering until the upstream closes.
 *   5. JSON-GET actions (history sidebar, schedule annotations) take a
 *      separate path that buffers the upstream JSON and forwards it whole.
 *
 * The controller never logs PHI. It logs the action, deny reason, upstream
 * latency, and the actor's authUserId — never request/response bodies, and
 * never the bearer token.
 */
final readonly class AgentProxyController
{
    /** @var array<string, string> */
    private const SSE_HEADERS = [
        'Content-Type' => 'text/event-stream',
        'Cache-Control' => 'no-cache, no-transform',
        'Connection' => 'keep-alive',
        // Caddy/nginx-style hint to disable proxy-side buffering. Caddy honors
        // X-Accel-Buffering to keep SSE chunks flowing without batching.
        'X-Accel-Buffering' => 'no',
    ];

    /**
     * Read-only JSON actions: proxied as upstream GET with the original
     * query string preserved, and the response is a single buffered JSON
     * body rather than an SSE stream. Anything not listed here defaults
     * to the streaming POST path used by `briefing` and `echo`.
     *
     * @var list<string>
     */
    private const JSON_GET_ACTIONS = ['latest_conversation', 'conversation_history', 'schedule_briefings'];

    /**
     * Per-action whitelist of additional query parameters the proxy
     * forwards to the upstream agent. `pid` is always forwarded
     * separately (when the request names a patient); only opt-in
     * params live here.
     *
     * The presence of an entry implicitly trusts the value was sniffed
     * for shape at the entry point — `agent.php` URL-decodes via
     * Symfony's Request and re-encodes here.
     *
     * @var array<string, list<string>>
     */
    public const EXTRA_QUERY_PARAM_ALLOWLIST = [
        // §4.7 force-resume mode of the resume route.
        'latest_conversation' => ['conversation'],
        // §4.7 history sidebar pagination.
        'conversation_history' => ['limit', 'before_updated_at', 'before_id'],
        // §5.4 schedule-view annotations: keyed by (practitioner, day).
        'schedule_briefings' => ['practitioner_uuid', 'date'],
    ];

    public function __construct(
        private PolicyGate $policyGate,
        private AgentTokenMinter $tokenMinter,
        private Client $httpClient,
        private LoggerInterface $logger,
        private string $agentBaseUrl,
        private string $issuer,
    ) {
    }

    public static function fromEnvironment(string $agentBaseUrl, string $issuer): self
    {
        return new self(
            policyGate: new PolicyGate(),
            tokenMinter: AgentTokenMinter::fromOpenEmr(),
            httpClient: new Client([
                RequestOptions::CONNECT_TIMEOUT => 5.0,
                // No total request timeout — SSE streams are long-lived.
                RequestOptions::HTTP_ERRORS => false,
            ]),
            logger: ServiceContainer::getLogger(),
            agentBaseUrl: rtrim($agentBaseUrl, '/'),
            issuer: $issuer,
        );
    }

    public function dispatch(SessionContext $session, AgentRequest $request, string $requestBody): void
    {
        $decision = $this->policyGate->evaluate($session, $request);

        if (!$decision->allowed) {
            $this->respondDeny($decision, $session, $request);
            return;
        }

        // PolicyGate has already enforced that fhirUser is non-null before
        // we reach this point. The PHPStan-narrow assertion makes the
        // contract explicit; if it ever fails it means the gate's invariant
        // was broken.
        if ($session->fhirUser === null) {
            $this->respondError(500, 'fhir_user_unresolved');
            return;
        }

        try {
            $bearer = $this->tokenMinter->mint($session->fhirUser, $request->requestedScopes, $this->issuer);
        } catch (AgentTokenMintException $e) {
            $this->logger->error('Agent token mint failed', [
                'action' => $request->action,
                'authUserId' => $session->authUserId,
                'exception' => $e,
            ]);
            $this->respondError(503, 'token_mint_failed');
            return;
        }

        $this->logger->info('Agent proxy request authorized', [
            'action' => $request->action,
            'authUserId' => $session->authUserId,
            'site' => $session->siteId,
            'hasPatient' => $request->requestedPatientPid !== null,
        ]);

        if (in_array($request->action, self::JSON_GET_ACTIONS, strict: true)) {
            $this->proxyJsonGet($request, $bearer);
            return;
        }
        $this->streamUpstream($request, $bearer, $requestBody);
    }

    /**
     * Read-only JSON actions: GET upstream with the same query string the
     * browser supplied (only `pid` and similar non-PHI parameters live
     * there), buffer the response, and pass it through with the upstream
     * status code. No SSE framing — the panel consumes this with a plain
     * `fetch().json()`.
     */
    private function proxyJsonGet(AgentRequest $request, string $bearer): void
    {
        $upstreamUrl = $this->agentBaseUrl . '/v1/agent/' . rawurlencode($request->action);
        // Build the upstream query string from `pid` plus any
        // action-allowlisted extras. The allowlist is checked at the
        // entry point (agent.php), so `extraQueryParams` here is
        // already filtered — but we re-check defensively to keep this
        // controller a single point of truth.
        $allowedExtras = self::EXTRA_QUERY_PARAM_ALLOWLIST[$request->action] ?? [];
        $queryParts = [];
        if ($request->requestedPatientPid !== null) {
            $queryParts[] = 'pid=' . rawurlencode($request->requestedPatientPid);
        }
        foreach ($request->extraQueryParams as $name => $value) {
            if (!in_array($name, $allowedExtras, strict: true)) {
                continue;
            }
            $queryParts[] = rawurlencode($name) . '=' . rawurlencode($value);
        }
        if ($queryParts !== []) {
            $upstreamUrl .= '?' . implode('&', $queryParts);
        }

        try {
            $response = $this->httpClient->request('GET', $upstreamUrl, [
                RequestOptions::HEADERS => [
                    'Authorization' => 'Bearer ' . $bearer,
                    'Accept' => 'application/json',
                ],
            ]);
        } catch (GuzzleException $e) {
            $this->logger->error('Agent upstream connection failed', [
                'action' => $request->action,
                'exception' => $e,
            ]);
            $this->respondError(502, 'upstream_unavailable');
            return;
        }

        $status = $response->getStatusCode();
        $body = (string) $response->getBody();
        http_response_code($status);
        header('Content-Type: application/json');
        echo $body;
    }

    private function streamUpstream(AgentRequest $request, string $bearer, string $requestBody): void
    {
        $upstreamUrl = $this->agentBaseUrl . '/v1/agent/' . rawurlencode($request->action);

        // Disable PHP output buffering so each chunk reaches the browser as
        // it arrives — without this, the SSE stream batches at the FPM
        // boundary and the UI sees nothing until the upstream closes.
        while (ob_get_level() > 0) {
            ob_end_flush();
        }

        foreach (self::SSE_HEADERS as $name => $value) {
            header($name . ': ' . $value);
        }

        // Sink the upstream response into a PSR-7 stream that fans
        // each cURL chunk to `php://output` and immediately calls
        // `flush()` so Apache pushes it to the browser. Guzzle wires
        // `CURLOPT_WRITEFUNCTION` to call `$sink->write()` for every
        // chunk cURL pulls off the socket, which gives us per-chunk
        // delivery — reading from `getBody()` afterwards (the previous
        // implementation) only returned data once cURL had finished
        // the whole transfer, collapsing the SSE feed into a single
        // end-of-stream burst and breaking the per-stage progress UI.
        $sink = new FlushingOutputStream();
        try {
            $this->httpClient->request('POST', $upstreamUrl, [
                RequestOptions::HEADERS => [
                    'Authorization' => 'Bearer ' . $bearer,
                    'Content-Type' => 'application/json',
                    'Accept' => 'text/event-stream',
                ],
                RequestOptions::BODY => $requestBody,
                RequestOptions::SINK => $sink,
            ]);
        } catch (GuzzleException $e) {
            $this->logger->error('Agent upstream connection failed', [
                'action' => $request->action,
                'exception' => $e,
            ]);
            // SSE headers already flushed above — use the in-stream envelope.
            $this->emitStreamError('upstream_unavailable');
        }
    }

    private function respondDeny(PolicyDecision $decision, SessionContext $session, AgentRequest $request): void
    {
        // PolicyDecision::deny() always sets a reason; the gate's allow path
        // never calls this method.
        $reasonName = $decision->reason !== null ? $decision->reason->name : 'unknown';

        $this->logger->warning('Agent proxy denied request', [
            'action' => $request->action,
            'authUserId' => $session->authUserId,
            'reason' => $reasonName,
        ]);

        $status = $reasonName === 'MissingSession' ? 401 : 403;
        $this->respondError($status, strtolower((string) $reasonName));
    }

    /**
     * Pre-stream errors: HTTP status + JSON body. Once any SSE byte has
     * gone out, this will not produce a valid response — the stream is
     * already open and the browser is in `EventSource` mode. Use
     * {@see emitStreamError()} after `streamUpstream` has flushed headers.
     */
    private function respondError(int $status, string $code): void
    {
        if (headers_sent()) {
            // We are mid-stream and the client is consuming SSE. Switch to
            // the in-stream envelope so the UI sees a typed error rather
            // than a hung connection.
            $this->emitStreamError($code);
            return;
        }
        http_response_code($status);
        header('Content-Type: application/json');
        echo json_encode(['error' => $code], JSON_THROW_ON_ERROR);
    }

    /**
     * In-stream errors (after SSE headers have flushed). The browser's
     * EventSource will fire a typed `error` event; the data payload
     * matches the JSON shape used pre-stream so consumers can share a
     * single decoder.
     */
    private function emitStreamError(string $code): void
    {
        $payload = json_encode(['error' => $code], JSON_THROW_ON_ERROR);
        echo "event: error\ndata: {$payload}\n\n";
    }
}
