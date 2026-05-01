<?php

/**
 * Result of {@see AgentEndpointAuth::authorize()} on success: the
 * verified JWT plus the resolved actor row. Carrying both together
 * means downstream controller code does not have to thread two
 * parameters through every helper.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Auth;

final readonly class AuthorizedAgentRequest
{
    public function __construct(
        public VerifiedAgentToken $verified,
        public ResolvedAgentActor $actor,
    ) {
    }
}
