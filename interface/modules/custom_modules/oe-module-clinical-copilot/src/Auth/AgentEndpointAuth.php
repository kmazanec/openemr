<?php

/**
 * Shared bearer-auth + scope check used by every narrow agent
 * snapshot endpoint (medications, labs, encounters, patientContext).
 *
 * Each narrow controller maps 1:1 to a single OpenEMR endpoint and
 * runs only its own adapter. The work that is genuinely shared —
 * verifying the JWT, resolving the fhirUser to a user row, re-checking
 * patient ACL, and confirming the JWT carries the SMART scope this
 * endpoint requires — lives here so the controllers stay tight.
 *
 * The narrow endpoints deliberately do NOT accept a `categories=`
 * query parameter. Each verifies a single fixed scope, so a token
 * that lacks it fails fast with `scope_not_permitted`.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Auth;

use Psr\Log\LoggerInterface;

final readonly class AgentEndpointAuth
{
    public function __construct(
        private OpenEmrJwtVerifier $verifier,
        private AgentActorResolver $actorResolver,
        private LoggerInterface $logger,
        private string $siteId,
    ) {
    }

    /**
     * Verify the bearer token, resolve the actor, ACL-check, and
     * confirm the JWT carries `$requiredScope`. Returns the verified
     * token + actor on success. On failure, writes the error envelope
     * to PHP's output buffer with the appropriate HTTP status and
     * returns null.
     */
    public function authorize(?string $bearerToken, string $requiredScope): ?AuthorizedAgentRequest
    {
        if ($bearerToken === null || $bearerToken === '') {
            $this->respondError(401, 'missing_token');
            return null;
        }

        try {
            $verified = $this->verifier->verify($bearerToken);
        } catch (AgentTokenVerificationException $e) {
            $this->logger->warning('Agent narrow endpoint token rejected', [
                'reason' => $e->getMessage(),
                'siteId' => $this->siteId,
            ]);
            $this->respondError(401, 'invalid_token');
            return null;
        }

        $actor = $this->actorResolver->resolve($verified->subject);
        if ($actor === null) {
            $this->logger->warning('Agent narrow endpoint fhirUser unresolved', [
                'sub' => $verified->subject,
            ]);
            $this->respondError(403, 'fhir_user_unresolved');
            return null;
        }

        // ACL re-check at the endpoint per ARCHITECTURE.md §"Repeat
        // explicit checks at agent endpoints" — the proxy already ran
        // PolicyGate before minting, but a request that bypassed the
        // proxy must still hit the same gate.
        if (!$this->actorResolver->mayReadPatients($actor)) {
            $this->logger->warning('Agent narrow endpoint ACL denied', [
                'sub' => $verified->subject,
            ]);
            $this->respondError(403, 'acl_denied');
            return null;
        }

        if (!in_array($requiredScope, $verified->scopes, strict: true)) {
            $this->respondError(403, 'scope_not_permitted');
            return null;
        }

        return new AuthorizedAgentRequest($verified, $actor);
    }

    private function respondError(int $status, string $code): void
    {
        if (!headers_sent()) {
            http_response_code($status);
            header('Content-Type: application/json');
        }
        echo json_encode(['error' => $code], JSON_THROW_ON_ERROR);
    }
}
