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
 * TIFF -> PNG decode seam for `DocumentViewResponder`.
 *
 * Production wiring is `ImagickTiffDecoder` (uses PHP's `ext-imagick`,
 * which is already a hard composer dependency). Tests inject a stub so
 * the responder's branch logic can be exercised without `\Imagick` on
 * the host (the isolated suite is portable across CI machines that
 * may or may not have ImageMagick installed).
 */
interface TiffDecoder
{
    /**
     * Decode the given TIFF bytes to PNG bytes. Throws
     * {@see TiffDecodeException} on any decoder-side failure.
     */
    public function decodeToPng(string $tiffBytes): string;
}
