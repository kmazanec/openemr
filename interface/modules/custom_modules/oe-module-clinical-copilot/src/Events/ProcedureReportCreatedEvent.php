<?php

/**
 * Event fired after the agent module promotes an extracted lab panel
 * to a real `procedure_report` row. Architecture spec calls for
 * "fires `procedure_report.post_insert` event so existing OpenEMR
 * consumers (quality measures, exports, alerts) see the lab as a
 * normal chart update."
 *
 * Stock OpenEMR has no `procedure_report.post_insert` Symfony event
 * today, and forking core for one event listener is the wrong trade.
 * The W2 module's listeners attach to {@see EVENT_HANDLE} instead —
 * same convention used by {@see DocumentReferenceCreatedEvent} for
 * the matching W2 Tier-1 path.
 *
 * Carries no PHI: row IDs + UUID + non-PHI metadata only.
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

final class ProcedureReportCreatedEvent extends Event
{
    public const EVENT_HANDLE = 'oe-module-clinical-copilot.procedure_report_created';

    /**
     * @param non-empty-list<string> $observationUuids 36-char canonical UUIDs, one per analyte.
     */
    public function __construct(
        public readonly string $procedureReportUuid,
        public readonly int $procedureReportRowId,
        public readonly array $observationUuids,
        public readonly int $pid,
        public readonly string $sourceDocumentUuid,
        public readonly ?string $panelCode,
        public readonly string $collectionDate,
        public readonly \DateTimeImmutable $createdAt,
    ) {
    }
}
