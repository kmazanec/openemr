<?php

/**
 * The IDs of a `procedure_report` row plus its child `procedure_result`
 * rows, returned by both
 * {@see ProcedureReportTableWriter::findExistingPanel()} and
 * {@see ProcedureReportTableWriter::insertPanel()}. The shape is the
 * same for both paths because the downstream consumer (the service
 * deciding what to fire on the post-insert event, the controller
 * shaping the JSON response) only needs the IDs — whether they came
 * from a fresh INSERT or an idempotent SELECT is communicated by which
 * method the caller called, not by the return type.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Service;

final readonly class PersistedProcedureReport
{
    /**
     * @param non-empty-list<string> $observationUuids
     */
    public function __construct(
        public string $procedureReportUuid,
        public int $procedureReportRowId,
        public array $observationUuids,
    ) {
    }
}
