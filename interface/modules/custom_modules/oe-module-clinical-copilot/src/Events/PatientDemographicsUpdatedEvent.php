<?php

/**
 * Event fired after the agent module promotes an extracted
 * demographics-delta fact to OpenEMR's standard `patient_data`
 * row through {@see \OpenEMR\Modules\ClinicalCopilot\Service\PatientDemographicsWriteService}.
 *
 * Stock OpenEMR's `PatientService::databaseUpdate()` already fires
 * its own `PatientUpdatedEvent`; the module fires this distinct
 * event so module-side listeners (eventual quality-measures,
 * exports, audit dashboards) can distinguish "agent-driven Tier-3
 * demographics update" from a normal clinician-edited form save
 * without inspecting `AgentDisclosedEvent` correlation alone.
 *
 * Carries no PHI: the changed field name + patient UUID/pid +
 * source-document linkage. The new value itself is *not* on the
 * event surface because demographics values (address, phone,
 * email) are PHI — listeners that need the actual value go through
 * the standard `PatientUpdatedEvent`'s `$updatedData` payload.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Events;

use OpenEMR\Modules\ClinicalCopilot\Service\DemographicsField;
use Symfony\Contracts\EventDispatcher\Event;

final class PatientDemographicsUpdatedEvent extends Event
{
    public const EVENT_HANDLE = 'oe-module-clinical-copilot.patient_demographics_updated';

    public function __construct(
        public readonly string $patientUuid,
        public readonly int $pid,
        public readonly string $sourceDocumentUuid,
        public readonly DemographicsField $field,
        public readonly \DateTimeImmutable $updatedAt,
    ) {
    }
}
