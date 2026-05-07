<?php

/**
 * Boundary between {@see MedicalProblemWriteService} and OpenEMR's
 * `lists` table for `type='medical_problem'` rows.
 *
 * The medical-problem promotion writer is single-table — like F.5b's
 * allergy writer, every past-medical-history entry is one `lists` row.
 * The writer owns its own boundary so the service stays trivially
 * testable (in-memory implementation in tests; real Doctrine connection
 * in production) and free of SQL strings.
 *
 * Idempotency check is a single read against `lists` keyed on
 * `(source_document_uuid, type='medical_problem',
 * lower(trim(title)))`. The caller computes the normalized form
 * (`lower(trim(title))`) before calling; the writer treats
 * `$normalizedTitle` as opaque and matches it against the stored
 * `lists.title` after the same normalization at SQL time, so a
 * re-promote of "Type 2 Diabetes" hits the existing
 * "type 2 diabetes" row.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Service;

interface MedicalProblemListsTableWriter
{
    /**
     * Look up an existing `lists` row that already represents this
     * medical problem (by `(source_document_uuid, lower(trim(title)))`).
     * Returns the canonical UUID + row id if found; null otherwise.
     */
    public function findExistingMedicalProblem(
        string $sourceDocumentUuid,
        string $normalizedTitle,
    ): ?PersistedListEntry;

    /**
     * Insert a `lists` row with `type='medical_problem'`, populating
     * the type-specific columns (`diagnosis`, `verification`) along
     * with the cross-list columns (`pid`, `title`, `comments`,
     * `begdate`, `source_document_uuid`, `user`, `date`, `activity`).
     * Mints a fresh `lists.uuid` (binary). Returns the canonical UUID
     * + row id.
     */
    public function insertMedicalProblem(
        MedicalProblemPromotionRequest $request,
        \DateTimeImmutable $createdAt,
    ): PersistedListEntry;
}
