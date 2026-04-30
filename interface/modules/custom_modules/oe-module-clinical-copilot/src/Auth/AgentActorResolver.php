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
 * Maps a JWT subject (bare users.uuid) to an OpenEMR-side actor and
 * answers the patient-access ACL question for that actor.
 *
 * Production wiring uses {@see SqlAgentActorResolver} which queries
 * `users` and calls {@see \AclMain::aclCheckCore}. Tests inject a
 * deterministic in-memory implementation.
 */
interface AgentActorResolver
{
    public function resolve(string $userUuid): ?ResolvedAgentActor;

    public function mayReadPatients(ResolvedAgentActor $actor): bool;
}
