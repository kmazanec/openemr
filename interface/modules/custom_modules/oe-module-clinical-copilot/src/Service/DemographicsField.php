<?php

/**
 * Closed-set enum for the three demographics-delta fields F.6
 * promotes through OpenEMR's standard demographics-update path.
 *
 * The enum is the routing primitive — every accept-click POSTs one
 * (field, value) pair from the agent middleman to {@see PromoteController},
 * which dispatches per-field through the typed
 * {@see DemographicsPromotionRequest}. The closed set keeps PHPStan's
 * exhaustiveness check honest: a future agent-side field add fails
 * static analysis until both the materializer and the writer learn
 * the new column.
 *
 * Backed by the agent middleman's wire-side string ("address", "phone",
 * "email") because the value crosses the PHP/JS boundary as JSON. The
 * three labels match the synthesizer's `DemographicsChangeDelta.field`
 * enum in `agent/src/pipeline/nodes/emitDeltas.ts`.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Service;

enum DemographicsField: string
{
    case Address = 'address';
    case Phone = 'phone';
    case Email = 'email';

    /**
     * Map the enum to the `patient_data` column it writes. Address
     * collapses to the single `street` column (per F.6's "free-text
     * pass-through" decision — see the top of
     * {@see PatientDemographicsWriteService} for the rationale on why
     * we don't parse a one-line address into structured columns).
     * Phone goes to `phone_cell`, the OpenEMR demographics widget's
     * default/primary phone column. Email goes to `email`.
     */
    public function patientDataColumn(): string
    {
        return match ($this) {
            self::Address => 'street',
            self::Phone => 'phone_cell',
            self::Email => 'email',
        };
    }
}
