<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Controller\DocumentView;

/**
 * Pure value object the public shim resolves a `Document` into before
 * handing it to {@see DocumentViewResponder}.
 *
 * The responder doesn't depend on the legacy `Document` class — it
 * works against this DTO so tests can construct fixtures inline
 * without bringing the whole OpenEMR `Document` machinery into the
 * isolated suite.
 *
 * `foreignId === 0` means the document is not chart-attached. The
 * responder's session-pid cross-chart defense refuses those.
 */
final readonly class ResolvedDocument
{
    public function __construct(
        public int $foreignId,
        public string $mimeType,
        public string $bytes,
    ) {
    }
}
