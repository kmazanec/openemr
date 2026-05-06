<?php

/**
 * Event fired after the agent module writes a Tier-1 DocumentReference
 * row pointing at the canonical Spaces URL. Carries no PHI; downstream
 * listeners use it to drive observability + the side-by-side PDF.js
 * cache priming.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Events;

use Symfony\Contracts\EventDispatcher\Event;

final class DocumentReferenceCreatedEvent extends Event
{
    public const EVENT_HANDLE = 'oe-module-clinical-copilot.document_reference_created';

    public function __construct(
        public readonly string $documentUuid,
        public readonly int $documentRowId,
        public readonly int $pid,
        /** `'lab_pdf' | 'intake_form'` */
        public readonly string $docType,
        public readonly string $spacesUrl,
        public readonly \DateTimeImmutable $createdAt,
    ) {
    }
}
