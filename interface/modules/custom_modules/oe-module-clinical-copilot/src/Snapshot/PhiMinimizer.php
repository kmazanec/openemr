<?php

/**
 * Architectural pin for demographic-level PHI that must never reach
 * the snapshot.
 *
 * The actual minimization happens in two places that this class does
 * NOT need to mediate:
 *  - {@see Demographics} simply does not declare the excluded fields,
 *    so they cannot be carried even if a future contributor wires a
 *    new column into the DataSource;
 *  - {@see \OpenEMR\Modules\ClinicalCopilot\Controller\AgentSnapshotController::buildSnapshot}
 *    gates each adapter call by `DataCategorySet`, so categories the
 *    request did not declare are never even fetched.
 *
 * What this class earns its keep on is the test pin against
 * `EXCLUDED_FROM_DEMOGRAPHICS`: future contributors who try to widen
 * Demographics with one of these column names trip the structural test
 * before the change merges. Earlier versions also exposed a
 * `withCategories()` runtime helper, but it duplicated the controller's
 * gating with no added safety, so it was removed.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot;

final class PhiMinimizer
{
    /**
     * Demographic-level fields that ARCHITECTURE.md §"ChartSnapshot >
     * Excluded by default" forbids from the snapshot. Pinned here as a
     * structural test target — Demographics::toArray() must not carry
     * any of these keys, and PatientAdapter must never read them. The
     * names use the column shapes a future contributor would reach for
     * in OpenEMR's `patient_data` table, so the test catches drive-by
     * widening.
     *
     * @var list<string>
     */
    public const EXCLUDED_FROM_DEMOGRAPHICS = [
        'ssn',
        'drivers_license',
        'street',
        'phone_home',
        'phone_cell',
        'phone_biz',
        'email',
        'pubpid',
        'billing',
        'occupation',
        'employer',
        'mothersname',
        'next_of_kin',
        'guardian',
    ];
}
