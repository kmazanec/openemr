<?php

/**
 * Event fired after the agent module promotes an extracted
 * family-history fact to a real `lists` row with
 * `type='family_history'`. Stock OpenEMR has no `lists.post_insert`
 * Symfony event today; the module attaches its own listeners to
 * {@see EVENT_HANDLE}, same convention as the allergy Tier-3 path's
 * {@see AllergyListEntryCreatedEvent}.
 *
 * Carries no PHI: row id + UUID + non-PHI metadata only. The composite
 * `title` (e.g. "Mother — Type 2 diabetes") is included because the
 * listener wiring (eventual quality-measures / exports) needs it to
 * route the row, and family-history relations / conditions are
 * displayed alongside other low-sensitivity chart-summary data in
 * stock OpenEMR.
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

final class FamilyHistoryListEntryCreatedEvent extends Event
{
    public const EVENT_HANDLE = 'oe-module-clinical-copilot.family_history_list_entry_created';

    public function __construct(
        public readonly string $listUuid,
        public readonly int $listRowId,
        public readonly int $pid,
        public readonly string $sourceDocumentUuid,
        public readonly string $title,
        public readonly \DateTimeImmutable $createdAt,
    ) {
    }
}
