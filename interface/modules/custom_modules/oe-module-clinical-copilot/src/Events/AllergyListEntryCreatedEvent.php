<?php

/**
 * Event fired after the agent module promotes an extracted allergy
 * fact to a real `lists` row with `type='allergy'`. Stock OpenEMR has
 * no `lists.post_insert` Symfony event today; the module attaches its
 * own listeners to {@see EVENT_HANDLE}, same convention as the lab
 * Tier-3 path's {@see ProcedureReportCreatedEvent}.
 *
 * Carries no PHI: row id + UUID + non-PHI metadata only. The
 * `substance` field is included because the listener wiring (eventual
 * quality-measures / exports) needs it to route the row, and "allergy
 * substance" is itself low-sensitivity given allergy-list visibility
 * in stock OpenEMR.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Events;

use Symfony\Contracts\EventDispatcher\Event;

final class AllergyListEntryCreatedEvent extends Event
{
    public const EVENT_HANDLE = 'oe-module-clinical-copilot.allergy_list_entry_created';

    public function __construct(
        public readonly string $listUuid,
        public readonly int $listRowId,
        public readonly int $pid,
        public readonly string $sourceDocumentUuid,
        public readonly string $substance,
        public readonly \DateTimeImmutable $createdAt,
    ) {
    }
}
