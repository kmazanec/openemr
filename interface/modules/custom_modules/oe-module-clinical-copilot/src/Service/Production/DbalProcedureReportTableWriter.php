<?php

/**
 * Production wiring for {@see ProcedureReportTableWriter}: writes
 * through Doctrine DBAL into OpenEMR's `procedure_order` /
 * `procedure_order_code` / `procedure_report` / `procedure_result`
 * tables.
 *
 * The transaction guards the four-row insert chain: a
 * `procedure_report` without its parent `procedure_order_code` is
 * unreadable by `ObservationLabService::search()` (which JOINs
 * order → order_code → report), and orphaned `procedure_result` rows
 * collapse the panel back to "no results visible" in the UI. Either
 * the whole chain lands or none of it does.
 *
 * Idempotency check (`findExistingPanel`) sits *outside* the
 * transaction: it is a single SELECT against `procedure_report` and
 * does not need atomicity with anything. The caller (the service)
 * uses the result to decide whether to insert at all.
 *
 * Row-id minting: `procedure_order` / `procedure_report` /
 * `procedure_result` all use `bigint AUTO_INCREMENT`, so we let the
 * DB mint and read back via `lastInsertId()` after each insert. UUIDs
 * are minted up-front (before the inserts) so the post-insert event
 * carries them without a follow-up read.
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
use OpenEMR\Modules\ClinicalCopilot\Service\ObservationResult;
use OpenEMR\Modules\ClinicalCopilot\Service\PersistedProcedureReport;
use OpenEMR\Modules\ClinicalCopilot\Service\ProcedureReportTableWriter;
use Ramsey\Uuid\Uuid;

final readonly class DbalProcedureReportTableWriter implements ProcedureReportTableWriter
{
    private const REPORT_STATUS_FINAL = 'final';
    private const REVIEW_STATUS_REVIEWED = 'reviewed';
    private const ORDER_STATUS_COMPLETE = 'complete';
    private const ORDER_INTENT_ORDER = 'order';
    private const PROCEDURE_ORDER_TYPE = 'laboratory_test';
    // Result-data-type key from sql/database.sql comment block on
    // procedure_result.result_data_type:
    //   'N' = Numeric, 'S' = String, 'F' = Formatted, 'E' = External,
    //   'L' = Long text. We always promote as 'S' (string) so the
    //   value column can carry e.g. "5.7%", "non-reactive", "12.3"
    //   verbatim — no client-side number coercion that would lose the
    //   unit-suffix or the qualitative-result variants.
    private const RESULT_DATA_TYPE_STRING = 'S';
    private const PROCEDURE_SOURCE_ORIGINAL = '1';

    public function __construct(private Connection $connection)
    {
    }

    public function findExistingPanel(
        string $sourceDocumentUuid,
        ?string $panelCode,
        string $collectionDate,
    ): ?PersistedProcedureReport {
        // Find the procedure_report row keyed on the W2 idempotency
        // tuple. `panel_code` is mapped to procedure_order_code's
        // `procedure_code` rather than living on procedure_report
        // directly, so the lookup joins through. NULL-safe equality on
        // panel_code (= NULL never matches; <=> does).
        $sql = <<<'SQL'
            SELECT pr.procedure_report_id, pr.uuid AS report_uuid
            FROM procedure_report pr
            INNER JOIN procedure_order_code poc
                ON poc.procedure_order_id = pr.procedure_order_id
                AND poc.procedure_order_seq = pr.procedure_order_seq
            WHERE pr.source_document_uuid = ?
              AND pr.date_collected = ?
              AND ((poc.procedure_code = ? AND ? IS NOT NULL)
                   OR (poc.procedure_code = '' AND ? IS NULL))
            ORDER BY pr.procedure_report_id ASC
            LIMIT 1
        SQL;

        $row = $this->connection->fetchAssociative(
            $sql,
            [$sourceDocumentUuid, $collectionDate, $panelCode ?? '', $panelCode, $panelCode],
        );
        if ($row === false) {
            return null;
        }

        $reportUuidBin = $row['report_uuid'];
        if (!is_string($reportUuidBin) || strlen($reportUuidBin) !== 16) {
            throw new \RuntimeException('procedure_report.uuid is not a 16-byte BINARY value');
        }
        $reportUuidCanonical = Uuid::fromBytes($reportUuidBin)->toString();

        $reportRowIdRaw = $row['procedure_report_id'];
        if (!is_int($reportRowIdRaw) && !(is_string($reportRowIdRaw) && ctype_digit($reportRowIdRaw))) {
            throw new \RuntimeException('procedure_report.procedure_report_id is not an integer value');
        }
        $reportRowId = (int) $reportRowIdRaw;

        $resultRows = $this->connection->fetchAllAssociative(
            'SELECT uuid FROM procedure_result WHERE procedure_report_id = ? ORDER BY procedure_result_id ASC',
            [$reportRowId],
        );
        if ($resultRows === []) {
            throw new \RuntimeException('procedure_report has no procedure_result rows');
        }
        /** @var non-empty-list<string> $observationUuids */
        $observationUuids = [];
        foreach ($resultRows as $r) {
            $bin = $r['uuid'];
            if (!is_string($bin) || strlen($bin) !== 16) {
                throw new \RuntimeException('procedure_result.uuid is not a 16-byte BINARY value');
            }
            $observationUuids[] = Uuid::fromBytes($bin)->toString();
        }

        return new PersistedProcedureReport(
            procedureReportUuid: $reportUuidCanonical,
            procedureReportRowId: $reportRowId,
            observationUuids: $observationUuids,
        );
    }

    public function insertPanel(
        int $pid,
        string $sourceDocumentUuid,
        ?string $panelCode,
        string $collectionDate,
        array $results,
        int $promotedByUserId,
        \DateTimeImmutable $createdAt,
    ): PersistedProcedureReport {
        $orderUuidCanonical = Uuid::uuid4()->toString();
        $reportUuidCanonical = Uuid::uuid4()->toString();
        /** @var non-empty-list<string> $resultUuidsCanonical */
        $resultUuidsCanonical = [];
        foreach ($results as $_) {
            $resultUuidsCanonical[] = Uuid::uuid4()->toString();
        }

        $orderUuidBinary = Uuid::fromString($orderUuidCanonical)->getBytes();
        $reportUuidBinary = Uuid::fromString($reportUuidCanonical)->getBytes();

        $createdAtSql = $createdAt->format('Y-m-d H:i:s');

        $this->connection->beginTransaction();
        try {
            $this->connection->insert('procedure_order', [
                'uuid' => $orderUuidBinary,
                'provider_id' => $promotedByUserId,
                'patient_id' => $pid,
                'encounter_id' => 0,
                'date_collected' => $collectionDate,
                'date_ordered' => $createdAtSql,
                'order_priority' => '',
                'order_status' => self::ORDER_STATUS_COMPLETE,
                'activity' => 1,
                'control_id' => '',
                'lab_id' => 0,
                'specimen_type' => '',
                'specimen_location' => '',
                'specimen_volume' => '',
                'clinical_hx' => '',
                'order_diagnosis' => '',
                'order_abn' => 'not_required',
                'collector_id' => 0,
                'procedure_order_type' => self::PROCEDURE_ORDER_TYPE,
                'order_intent' => self::ORDER_INTENT_ORDER,
            ]);
            $procedureOrderId = (int) $this->connection->lastInsertId();

            $procedureOrderSeq = 1;
            $this->connection->insert('procedure_order_code', [
                'procedure_order_id' => $procedureOrderId,
                'procedure_order_seq' => $procedureOrderSeq,
                'procedure_code' => $panelCode ?? '',
                'procedure_name' => $panelCode ?? '',
                'procedure_source' => self::PROCEDURE_SOURCE_ORIGINAL,
                'do_not_send' => 0,
            ]);

            $this->connection->insert('procedure_report', [
                'uuid' => $reportUuidBinary,
                'procedure_order_id' => $procedureOrderId,
                'procedure_order_seq' => $procedureOrderSeq,
                'date_collected' => $collectionDate,
                'date_report' => $createdAtSql,
                'source' => $promotedByUserId,
                'specimen_num' => '',
                'report_status' => self::REPORT_STATUS_FINAL,
                'review_status' => self::REVIEW_STATUS_REVIEWED,
                'source_document_uuid' => $sourceDocumentUuid,
            ]);
            $procedureReportId = (int) $this->connection->lastInsertId();

            foreach ($results as $idx => $result) {
                $resultUuidBinary = Uuid::fromString($resultUuidsCanonical[$idx])->getBytes();
                $this->connection->insert('procedure_result', [
                    'uuid' => $resultUuidBinary,
                    'procedure_report_id' => $procedureReportId,
                    'result_data_type' => self::RESULT_DATA_TYPE_STRING,
                    'result_code' => $panelCode ?? '',
                    'result_text' => $result->analyteName,
                    'date' => $createdAtSql,
                    'facility' => '',
                    'units' => $result->unit,
                    'result' => $result->value,
                    'range' => self::formatRange($result),
                    'abnormal' => self::mapAbnormalFlag($result->abnormalFlag),
                    'result_status' => self::REPORT_STATUS_FINAL,
                ]);
            }

            $this->connection->commit();
        } catch (\Throwable $e) {
            $this->connection->rollBack();
            throw $e;
        }

        return new PersistedProcedureReport(
            procedureReportUuid: $reportUuidCanonical,
            procedureReportRowId: $procedureReportId,
            observationUuids: $resultUuidsCanonical,
        );
    }

    private static function formatRange(ObservationResult $r): string
    {
        if ($r->refRangeLow === null && $r->refRangeHigh === null) {
            return '';
        }
        return ($r->refRangeLow ?? '') . '-' . ($r->refRangeHigh ?? '');
    }

    /**
     * Map the agent's abnormal-flag vocabulary
     * (`high|low|critical_high|critical_low|normal`) into the
     * `procedure_result.abnormal` column's vocabulary
     * (`no|yes|high|low` per the schema comment). `critical_*` map to
     * the directional flag (the criticality is a UI concern, not a
     * column the chart UI understands), and `normal` maps to `'no'`.
     */
    private static function mapAbnormalFlag(?string $flag): string
    {
        return match ($flag) {
            null, 'normal' => 'no',
            'high', 'critical_high' => 'high',
            'low', 'critical_low' => 'low',
            default => 'yes',
        };
    }
}
