<?php

/**
 * Production wiring for {@see MedicationStatementListsTableWriter}:
 * writes through Doctrine DBAL into OpenEMR's `lists` +
 * `lists_medication` tables for a `type='medication'`
 * patient-reported medication row.
 *
 * Two-table writer: a patient-reported medication is one `lists` row
 * (type='medication', title=drug name, source_document_uuid, etc.)
 * plus one sibling `lists_medication` row carrying the
 * MedicationStatement-shaped columns. Both rows land under a single
 * `Connection::beginTransaction()` / `commit()` / `rollBack()` — a
 * `lists` row without its sibling `lists_medication` sibling would
 * still be readable by the legacy chart UI (it falls back to
 * lists.title + lists.comments) but FHIR `MedicationStatement` reads
 * would miss the dosage/intent/category columns. Either both rows
 * land or neither.
 *
 * `lists_medication` columns populated:
 *
 * - `list_id` — newly-minted `lists.id`
 * - `drug_dosage_instructions` — free-text dose+frequency+route
 *   composed by the agent middleman
 * - `usage_category` (option_id) + `usage_category_title` (NOT NULL
 *   display title) — FK-shaped to
 *   `list_options.list_id='medication-usage-category'`. Defaults to
 *   `community`/`Home/Community` for patient-reported intake-form
 *   medications. Pass-through free text per the F.5b precedent
 *   (chart UI displays as-is).
 * - `request_intent` (option_id) + `request_intent_title` (NOT NULL
 *   display title) — FK-shaped to
 *   `list_options.list_id='medication-request-intent'`. Defaults to
 *   `plan`/`Plan` (the FHIR MedicationRequest intent for a chart
 *   record that documents intended use without authorizing dispense).
 * - `is_primary_record = 0` — flags this as a reported (not primary)
 *   record so the chart UI surfaces it as a `MedicationStatement`
 *   alongside the prescription-table `MedicationRequest` rows.
 * - `medication_adherence_information_source = 'patient'` — FK to
 *   `list_options.list_id='medication_adherence_information_source'`,
 *   option_id='patient'. Carries the provenance: the patient
 *   self-reported this medication on their intake form.
 *
 * Idempotency check (`findExistingMedication`) sits *outside* the
 * transaction: it is a single SELECT joining `lists` LEFT JOIN
 * `lists_medication` and does not need atomicity with anything. The
 * LEFT JOIN guarantees that an orphaned `lists` row from a prior
 * failed insert (e.g. the transaction committed `lists` then crashed
 * before `lists_medication`) is still found so the writer doesn't
 * double-insert. The idempotency match condition is
 * `(lists.source_document_uuid, lists.type='medication',
 * LOWER(TRIM(lists.title)))`.
 *
 * Row-id minting: `lists.id` and `lists_medication.id` are both
 * `bigint AUTO_INCREMENT`; we read `lists.id` back via
 * `lastInsertId()` after the first insert and use it as the FK for
 * the second insert. The UUID is minted up front and stored as
 * `BINARY(16)` per OpenEMR's convention so the post-insert event
 * carries it without a follow-up read.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Service\Production;

use Doctrine\DBAL\Connection;
use OpenEMR\Modules\ClinicalCopilot\Service\MedicationStatementListsTableWriter;
use OpenEMR\Modules\ClinicalCopilot\Service\MedicationStatementPromotionRequest;
use OpenEMR\Modules\ClinicalCopilot\Service\PersistedListEntry;
use Ramsey\Uuid\Uuid;

final readonly class DbalMedicationStatementListsTableWriter implements MedicationStatementListsTableWriter
{
    private const LIST_TYPE = 'medication';
    private const IS_PRIMARY_RECORD_REPORTED = 0;
    private const ADHERENCE_INFORMATION_SOURCE_PATIENT = 'patient';

    public function __construct(private Connection $connection)
    {
    }

    public function findExistingMedication(
        string $sourceDocumentUuid,
        string $normalizedDrugName,
    ): ?PersistedListEntry {
        // LEFT JOIN so a `lists` row whose sibling `lists_medication`
        // row was never inserted (e.g. a prior transaction that
        // rolled back partially) is still found and the writer
        // doesn't double-insert. Match on the same normalization the
        // caller used: lower + trim of `lists.title`. Using
        // LOWER(TRIM(title)) on both sides keeps the lookup correct
        // even if a previous writer stored the title with mixed case
        // or trailing whitespace.
        $sql = <<<'SQL'
            SELECT l.id, l.uuid
            FROM lists l
            LEFT JOIN lists_medication lm ON lm.list_id = l.id
            WHERE l.source_document_uuid = ?
              AND l.type = ?
              AND LOWER(TRIM(l.title)) = ?
            ORDER BY l.id ASC
            LIMIT 1
        SQL;

        $row = $this->connection->fetchAssociative(
            $sql,
            [$sourceDocumentUuid, self::LIST_TYPE, $normalizedDrugName],
        );
        if ($row === false) {
            return null;
        }

        $rowIdRaw = $row['id'];
        if (!is_int($rowIdRaw) && !(is_string($rowIdRaw) && ctype_digit($rowIdRaw))) {
            throw new \RuntimeException('lists.id is not an integer value');
        }
        $listRowId = (int) $rowIdRaw;

        $uuidBin = $row['uuid'];
        if (!is_string($uuidBin) || strlen($uuidBin) !== 16) {
            throw new \RuntimeException('lists.uuid is not a 16-byte BINARY value');
        }
        $listUuid = Uuid::fromBytes($uuidBin)->toString();

        return new PersistedListEntry(listUuid: $listUuid, listRowId: $listRowId);
    }

    public function insertMedication(
        MedicationStatementPromotionRequest $request,
        \DateTimeImmutable $createdAt,
    ): PersistedListEntry {
        $listUuid = Uuid::uuid4();
        $createdAtSql = $createdAt->format('Y-m-d H:i:s');

        $this->connection->beginTransaction();
        try {
            $this->connection->insert('lists', [
                'uuid' => $listUuid->getBytes(),
                'type' => self::LIST_TYPE,
                'title' => $request->drugName,
                'pid' => $request->pid,
                'date' => $createdAtSql,
                'activity' => 1,
                'comments' => $request->comments,
                'begdate' => $request->onsetDate,
                'source_document_uuid' => $request->sourceDocumentUuid,
                'user' => (string) $request->promotedByUserId,
            ]);

            // Doctrine declares `lastInsertId(): string|int` in this
            // DBAL version. Narrow the string variant to "numeric
            // string" so an unexpected non-digit value (which would
            // silently coerce to 0 in `(int)$x`) becomes a typed
            // runtime failure instead.
            $insertedIdRaw = $this->connection->lastInsertId();
            if (is_string($insertedIdRaw) && !ctype_digit($insertedIdRaw)) {
                throw new \RuntimeException('lists.lastInsertId is not numeric');
            }
            $listRowId = (int) $insertedIdRaw;

            $this->connection->insert('lists_medication', [
                'list_id' => $listRowId,
                'drug_dosage_instructions' => $request->dosageInstructions,
                'usage_category' => $request->usageCategory,
                'usage_category_title' => $request->usageCategoryTitle,
                'request_intent' => $request->requestIntent,
                'request_intent_title' => $request->requestIntentTitle,
                'is_primary_record' => self::IS_PRIMARY_RECORD_REPORTED,
                'medication_adherence_information_source' => self::ADHERENCE_INFORMATION_SOURCE_PATIENT,
            ]);

            $this->connection->commit();
        } catch (\Throwable $e) {
            $this->connection->rollBack();
            throw $e;
        }

        return new PersistedListEntry(
            listUuid: $listUuid->toString(),
            listRowId: $listRowId,
        );
    }
}
