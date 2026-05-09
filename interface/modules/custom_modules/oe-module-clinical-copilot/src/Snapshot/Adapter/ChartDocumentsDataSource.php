<?php

/**
 * Reads Clinical-Copilot-categorized chart documents for a patient.
 * Production wiring lives in {@see Production\ChartDocumentsDataSource}.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter;

interface ChartDocumentsDataSource
{
    /**
     * Returns one row per Clinical-Copilot-categorized document for a
     * patient, regardless of whether the agent has already extracted it
     * (the agent filters on its own DB to drop already-processed
     * documents). Rows are ordered newest-first so the caller's "process
     * unprocessed docs" loop hits recent uploads first.
     *
     * Each row carries:
     *   - `document_uuid` — canonical 36-char UUID (the BINARY(16) in
     *     `documents.uuid`, decoded).
     *   - `doc_type` — `'lab_pdf'` or `'intake_form'`, derived from the
     *     leaf category name on `categories_to_documents`.
     *   - `canonical_ext` — file extension the rasterizer expects
     *     (`pdf` / `png` / `jpg` / `jpeg` / `tiff` / `tif`), derived
     *     from `documents.url` (the canonical legacy filename).
     *
     * @return list<array{document_uuid: string, doc_type: string, canonical_ext: string}>
     */
    public function listForPid(int $pid): array;
}
