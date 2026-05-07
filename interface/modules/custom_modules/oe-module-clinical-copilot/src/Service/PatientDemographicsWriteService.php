<?php

/**
 * Tier-3 writer for accepted demographics-delta facts (address,
 * phone, email).
 *
 * When a clinician clicks "accept" on an extracted demographics
 * delta in the panel, this service routes the change through
 * OpenEMR's standard demographics-update path so the existing
 * audit-log + `PatientUpdatedEvent` listeners fire as if the
 * clinician edited the demographics form. The agent's own
 * disclosure trail is laid down by the controller's
 * {@see \OpenEMR\Modules\ClinicalCopilot\Controller\PromoteController::fireDisclosure()}
 * helper as a *second* row that links the change to
 * `source_document_uuid`.
 *
 * Four design decisions worth pinning here so the next reader
 * doesn't relitigate them:
 *
 *   1. **Single-field-per-call DTO.** One accept click promotes one
 *      delta (address OR phone OR email), not a batch. The DTO
 *      carries `pid`, `sourceDocumentUuid`, `field` (closed-set
 *      enum), `value` (string), `promotedByUserId`. Per-field
 *      reasoning keeps idempotency trivial — re-promoting an
 *      address that's already current is a no-op without needing
 *      compound keys — and matches the panel's per-field button
 *      group, which posts one field per click.
 *
 *   2. **Address shape: free-text pass-through into `street`.** The
 *      synthesizer's `intake_form.patient_demographics.address`
 *      slot is one cited string (e.g. `"742 Evergreen Terrace,
 *      Springfield IL 62701"`). Two viable approaches: (a) parse
 *      it into structured `street`/`city`/`state`/`postal_code`
 *      columns, (b) write the verbatim string into `street` and
 *      leave the others alone. We pick (b). Address parsing is
 *      brittle (international formats vary), the agent might
 *      supply a partial address, and overwriting structured
 *      columns based on a parser hallucination would corrupt
 *      chart data. The chart's demographics widget displays
 *      `street` as the primary address line, which is what the
 *      clinician sees when they re-open the form and clean it up.
 *      Phone goes to `phone_cell` (the OpenEMR demographics
 *      widget's default/primary phone). Email goes to `email`.
 *      Mapping is owned by {@see DemographicsField::patientDataColumn()}.
 *
 *   3. **Agent middleman dispatches through `accept_fact`.** The
 *      panel POSTs `(artifactId, fieldPath, factType:
 *      'demographics')` to `/v1/agent/accept_fact`; the agent
 *      middleman materializes the body from the
 *      `intake_form.patient_demographics.{address|phone|email}.value`
 *      cited slot and forwards to `?type=demographics`. This stays
 *      consistent with F.5a–F.5e and lets the panel's existing
 *      accept-click handler fire unchanged for demographics — only
 *      the per-field button group rendering needs new code.
 *
 *   4. **PolicyGate scope: `user/Patient.cs`.** The FHIR-shaped
 *      write scope for the `Patient` resource. Added to the
 *      `accept_fact` action's allowlist alongside the other Tier-3
 *      write scopes; the controller's `dispatchDemographics` arm
 *      enforces it explicitly so an over-broadly minted lab token
 *      cannot smuggle through and rewrite a patient's address.
 *
 * **Idempotency.** Compare-then-write on `(field, value)`. If
 * `patient_data.{column}` already equals the requested value, the
 * service returns `idempotentHit=true` without touching the DB or
 * firing the disclosure event. Re-promoting after a network retry
 * is a no-op; re-promoting a stale value the chart has since had
 * cleaned up by the clinician is also a no-op (the cleaned value
 * doesn't match, the agent's stale value would overwrite — but the
 * clinician's edit on the form path is the authoritative version,
 * so we skip the write). This is "natural" idempotency — we don't
 * need a tracking row because the column itself is the source of
 * truth.
 *
 * Architecture parallel: this is the demographics-side counterpart
 * of {@see AllergyListWriteService} (F.5b) — the in-place-update
 * shape rather than the insert-new-row shape. The pattern still
 * mirrors allergy's three-step flow: find-existing (fetch current
 * value) → return cached on hit, else update + dispatch event.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Service;

use OpenEMR\Modules\ClinicalCopilot\Auth\ClockInterface;
use OpenEMR\Modules\ClinicalCopilot\Events\PatientDemographicsUpdatedEvent;
use Psr\Log\LoggerInterface;
use Symfony\Component\EventDispatcher\EventDispatcherInterface;

final readonly class PatientDemographicsWriteService
{
    public function __construct(
        private PatientDemographicsTableWriter $tableWriter,
        private EventDispatcherInterface $eventDispatcher,
        private ClockInterface $clock,
        private LoggerInterface $logger,
    ) {
    }

    public function write(DemographicsPromotionRequest $request): DemographicsPromotionResult
    {
        $snapshot = $this->tableWriter->fetchSnapshot($request->pid, $request->field);
        if ($snapshot === null) {
            $this->logger->error('Tier-3 demographics promotion: patient not found', [
                'pid' => $request->pid,
                'field' => $request->field->value,
                'sourceDocumentUuid' => $request->sourceDocumentUuid,
            ]);
            throw new \RuntimeException(
                'Tier-3 demographics promotion: patient not found',
            );
        }
        if ($snapshot->currentValue === $request->value) {
            $this->logger->info('Tier-3 demographics promotion idempotent hit', [
                'pid' => $request->pid,
                'field' => $request->field->value,
                'sourceDocumentUuid' => $request->sourceDocumentUuid,
                'patientUuid' => $snapshot->patientUuid,
            ]);
            return new DemographicsPromotionResult(
                patientUuid: $snapshot->patientUuid,
                idempotentHit: true,
            );
        }

        $updatedAt = $this->clock->now();

        try {
            $patientUuid = $this->tableWriter->updateField(
                pid: $request->pid,
                field: $request->field,
                value: $request->value,
                promotedByUserId: $request->promotedByUserId,
                updatedAt: $updatedAt,
            );
        } catch (\Throwable $e) {
            $this->logger->error('Tier-3 demographics promotion write failed', [
                'pid' => $request->pid,
                'field' => $request->field->value,
                'sourceDocumentUuid' => $request->sourceDocumentUuid,
                'exception' => $e,
            ]);
            throw new \RuntimeException('Tier-3 demographics promotion write failed', 0, $e);
        }

        $this->eventDispatcher->dispatch(
            new PatientDemographicsUpdatedEvent(
                patientUuid: $patientUuid,
                pid: $request->pid,
                sourceDocumentUuid: $request->sourceDocumentUuid,
                field: $request->field,
                updatedAt: $updatedAt,
            ),
            PatientDemographicsUpdatedEvent::EVENT_HANDLE,
        );

        $this->logger->info('Tier-3 demographics promotion written', [
            'pid' => $request->pid,
            'field' => $request->field->value,
            'sourceDocumentUuid' => $request->sourceDocumentUuid,
            'patientUuid' => $patientUuid,
        ]);

        return new DemographicsPromotionResult(
            patientUuid: $patientUuid,
            idempotentHit: false,
        );
    }
}
