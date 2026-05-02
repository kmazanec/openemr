<?php

/**
 * Closed set of reasons the Agent proxy can refuse a request.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Auth;

enum PolicyDenyReason
{
    case MissingSession;
    case SiteMismatch;
    case PatientMismatch;
    case MissingPatient;
    case ScopeNotPermitted;
    case UnknownAction;
    // §5.2 self-only writes: the acting user attempted to write a settings
    // row that does not belong to them. Distinct from PatientMismatch
    // (which is patient-shaped) so log readers can tell the cases apart.
    case NotOwnRow;
}
