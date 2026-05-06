<?php

/**
 * Boundary for UUID minting in {@see DocumentReferenceWriteService}.
 * Production wires {@see UuidRegistryDocumentUuidGenerator} which goes
 * through OpenEMR's `UuidRegistry`; tests inject a deterministic stub
 * so the assertion compares a known value rather than a freshly
 * minted random one.
 *
 * The pair (`canonical`, `binary`) lets callers pick either form
 * without round-tripping a binary blob through string concat.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Service;

interface DocumentUuidGenerator
{
    public function generate(): GeneratedDocumentUuid;
}

final readonly class GeneratedDocumentUuid
{
    public function __construct(
        /** Lowercase 36-char form (`8-4-4-4-12`). */
        public string $canonical,
        /** 16-byte binary form for `documents.uuid` (BINARY(16)). */
        public string $binary,
    ) {
    }
}
