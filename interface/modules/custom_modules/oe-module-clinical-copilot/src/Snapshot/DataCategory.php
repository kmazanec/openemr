<?php

/**
 * Closed set of clinical data categories the PHI minimizer recognizes.
 *
 * Mirrors ARCHITECTURE.md §"Verification > Claim Ledger" — the same set
 * the verifier uses when categorizing claims. Demographics is
 * deliberately not a category: patient identity is the request's trust
 * anchor and is always carried.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot;

enum DataCategory: string
{
    case Diagnosis = 'diagnosis';
    case Medication = 'medication';
    case Allergy = 'allergy';
    case Lab = 'lab';
    case Encounter = 'encounter';
    case Appointment = 'appointment';
}
