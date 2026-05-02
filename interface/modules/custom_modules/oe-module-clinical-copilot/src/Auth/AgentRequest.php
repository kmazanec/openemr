<?php

/**
 * Parsed Agent proxy request: action + the patient/scope context it asks for.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Auth;

/**
 * What the browser is asking the proxy to do, parsed at the controller's edge.
 *
 * `requestedPatientPid` may be null for whole-day routes (UC5); when set, it
 * must equal the session's pid or the gate denies. `requestedScopes` are the
 * SMART scopes the proxy will mint into the bearer token.
 *
 * `extraQueryParams` carries non-PHI query parameters the upstream agent
 * route needs (cursor pagination, force-resume conversation id, etc.).
 * The entry point parses them per a fixed allowlist before constructing
 * the request — the controller blindly forwards what's here, so the
 * allowlist IS the contract. Values are already URL-decoded.
 */
final readonly class AgentRequest
{
    /**
     * @param list<string> $requestedScopes
     * @param array<string, string> $extraQueryParams
     */
    public function __construct(
        public string $action,
        public string $siteId,
        public ?string $requestedPatientPid,
        public array $requestedScopes,
        public array $extraQueryParams = [],
    ) {
    }
}
