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
 *   4. Streaming Guzzle POST to the agent service preserving SSE framing.
 *   5. Pipe the response body chunk-by-chunk back to the browser.
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
            tokenMinter: new AgentTokenMinter(),
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

        try {
            $bearer = $this->tokenMinter->mint($session, $request->requestedScopes, $this->issuer);
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

        $this->streamUpstream($request, $bearer, $requestBody);
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

        try {
            $response = $this->httpClient->request('POST', $upstreamUrl, [
                RequestOptions::HEADERS => [
                    'Authorization' => 'Bearer ' . $bearer,
                    'Content-Type' => 'application/json',
                    'Accept' => 'text/event-stream',
                ],
                RequestOptions::BODY => $requestBody,
                RequestOptions::STREAM => true,
            ]);
        } catch (GuzzleException $e) {
            $this->logger->error('Agent upstream connection failed', [
                'action' => $request->action,
                'exception' => $e,
            ]);
            echo "event: error\ndata: {\"error\":\"upstream_unavailable\"}\n\n";
            return;
        }

        $body = $response->getBody();
        while (!$body->eof()) {
            $chunk = $body->read(8192);
            if ($chunk === '') {
                continue;
            }
            echo $chunk;
            flush();
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
        $this->respondError($status, strtolower($reasonName));
    }

    private function respondError(int $status, string $code): void
    {
        http_response_code($status);
        header('Content-Type: application/json');
        echo json_encode(['error' => $code], JSON_THROW_ON_ERROR);
    }
}
