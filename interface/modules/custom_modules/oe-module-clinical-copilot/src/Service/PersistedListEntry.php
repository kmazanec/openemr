<?php

/**
 * Result of a Tier-3 list-row write (allergy / medication_statement /
 * medical_problem / family_history). All four list-shaped fact types
 * land their canonical chart record in `lists` — one row per fact,
 * keyed by `lists.uuid`. The services need both the canonical UUID
 * (to return to the agent) and the auto-incremented row id (to fire
 * post-insert events that reference the row by id, matching legacy
 * OpenEMR conventions).
 *
 * Allergy ships first (F.5b); the other three types reuse this same
 * shape as they land. Lab Tier-3 returns {@see PersistedProcedureReport}
 * instead because the lab chain is multi-table.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Service;

final readonly class PersistedListEntry
{
    public function __construct(
        public string $listUuid,
        public int $listRowId,
    ) {
    }
}
