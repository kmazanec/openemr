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
 * The OpenEMR-side identity behind a verified agent token.
 *
 * Carries enough to (a) ACL-check the actor and (b) populate the
 * disclosure-event `actorUserId` field. Resolution from the JWT's `sub`
 * (bare users.uuid) is the seam {@see AgentActorResolver} owns.
 */
final readonly class ResolvedAgentActor
{
    public function __construct(
        public int $userId,
        public string $username,
        public string $uuid,
    ) {
    }
}
