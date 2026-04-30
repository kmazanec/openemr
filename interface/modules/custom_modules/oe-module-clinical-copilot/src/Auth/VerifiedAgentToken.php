<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Auth;

/**
 * The output of a successful {@see OpenEmrJwtVerifier::verify()}.
 *
 * Mirrors the shape of the agent-side `AgentPrincipal` so call sites on
 * either side of the trust boundary read equivalently.
 */
final readonly class VerifiedAgentToken
{
    /**
     * @param list<string> $scopes
     */
    public function __construct(
        public string $subject,
        public string $fhirUser,
        public array $scopes,
        public string $jti,
        public string $audience,
        public string $issuer,
    ) {
    }
}
