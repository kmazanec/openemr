<?php

/**
 * Production-wired {@see ChartDocumentsDataSource} reading from
 * OpenEMR's `documents` + `categories` tables.
 *
 * Surfaces every Clinical-Copilot-categorized document for a patient
 * regardless of extraction state. The agent filters on its own
 * `extraction_artifacts` table to drop already-processed documents
 * before injecting the rest into the briefing's `pendingUploads` —
 * keeping each side responsible for its own database.
 *
 * Why we trust the leaf category name to determine `doc_type`: the
 * categories were created by {@see DbalDocumentTableWriter::ensureCategory},
 * which is the only path that writes into the `Clinical Copilot`
 * subtree. Hand-uploaded documents land elsewhere (the legacy
 * Documents UI puts them under `Categories`, `Patient Information`,
 * etc.); the agent never asks about those.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production;

use OpenEMR\Common\Database\QueryUtils;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ChartDocumentsDataSource as ChartDocumentsDataSourceContract;

final readonly class ChartDocumentsDataSource implements ChartDocumentsDataSourceContract
{
    /** Mirrors {@see DbalDocumentTableWriter::ROOT_CATEGORY_NAME}. */
    private const ROOT_CATEGORY_NAME = 'Clinical Copilot';

    private const LEAF_LAB = 'Lab PDF';
    private const LEAF_INTAKE = 'Intake Form';

    /** Set of file extensions the agent's rasterizer accepts (must stay in sync with `agent/src/pipeline/nodes/rasterize.ts`). */
    private const ALLOWED_EXTS = ['pdf', 'png', 'jpg', 'jpeg', 'tiff', 'tif'];

    public function listForPid(int $pid): array
    {
        $rows = QueryUtils::fetchRecords(
            "SELECT LOWER(HEX(d.uuid)) AS uuid_hex,
                    leaf.name        AS leaf_name,
                    d.url            AS url,
                    d.name           AS filename,
                    d.mimetype       AS mimetype
               FROM documents d
               JOIN categories_to_documents cd
                 ON cd.document_id = d.id
               JOIN categories leaf
                 ON leaf.id = cd.category_id
               JOIN categories root
                 ON root.id = leaf.parent
              WHERE d.foreign_id = ?
                AND d.deleted = 0
                AND root.name = ?
                AND leaf.name IN (?, ?)
              ORDER BY d.date DESC",
            [
                $pid,
                self::ROOT_CATEGORY_NAME,
                self::LEAF_LAB,
                self::LEAF_INTAKE,
            ],
            true,
        );

        $out = [];
        foreach ($rows as $row) {
            $hex = is_string($row['uuid_hex'] ?? null) ? $row['uuid_hex'] : '';
            if (strlen($hex) !== 32) {
                continue;
            }
            $canonicalUuid = sprintf(
                '%s-%s-%s-%s-%s',
                substr($hex, 0, 8),
                substr($hex, 8, 4),
                substr($hex, 12, 4),
                substr($hex, 16, 4),
                substr($hex, 20, 12),
            );

            $leaf = is_string($row['leaf_name'] ?? null) ? $row['leaf_name'] : '';
            $docType = $leaf === self::LEAF_LAB ? 'lab_pdf' : ($leaf === self::LEAF_INTAKE ? 'intake_form' : null);
            if ($docType === null) {
                continue;
            }

            $url = is_string($row['url'] ?? null) ? $row['url'] : '';
            $filename = is_string($row['filename'] ?? null) ? $row['filename'] : '';
            $mimetype = is_string($row['mimetype'] ?? null) ? $row['mimetype'] : '';
            $canonicalExt = $this->deriveExt($url, $filename, $mimetype);
            if ($canonicalExt === null) {
                // Skip documents whose extension we can't infer — the
                // rasterizer would reject them anyway and we'd rather
                // omit the entry than ship a half-shaped one.
                continue;
            }

            $out[] = [
                'document_uuid' => $canonicalUuid,
                'doc_type' => $docType,
                'canonical_ext' => $canonicalExt,
            ];
        }
        return $out;
    }

    private function deriveExt(string $url, string $filename, string $mimetype): ?string
    {
        $candidates = [$url, $filename];
        foreach ($candidates as $cand) {
            if ($cand === '') {
                continue;
            }
            $lastDot = strrpos($cand, '.');
            if ($lastDot === false) {
                continue;
            }
            $ext = strtolower(substr($cand, $lastDot + 1));
            // Strip query strings / fragments that occasionally ride
            // on `documents.url` for legacy storage backends.
            $ext = preg_replace('/[^a-z0-9]+.*$/', '', $ext) ?? '';
            if ($ext !== '' && in_array($ext, self::ALLOWED_EXTS, true)) {
                return $ext;
            }
        }
        // Fall back to the mimetype when neither the URL nor the
        // filename surfaced a usable extension.
        return match ($mimetype) {
            'application/pdf' => 'pdf',
            'image/png' => 'png',
            'image/jpeg' => 'jpg',
            'image/tiff' => 'tiff',
            default => null,
        };
    }
}
