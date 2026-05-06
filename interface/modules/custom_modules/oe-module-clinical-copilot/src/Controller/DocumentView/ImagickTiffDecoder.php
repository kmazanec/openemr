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

use Imagick;
use ImagickException;

/**
 * Production {@see TiffDecoder} backed by PHP's `ext-imagick`.
 *
 * `ext-imagick` is already a hard composer dependency for OpenEMR
 * (`composer.json` line 24: `"ext-imagick": "*"`). The decode is one
 * `readImageBlob` + `setImageFormat('png')` + `getImageBlob` chain.
 * Image-typed canonicals in the agent pipeline are uniformly single-
 * page (the rasterizer treats every image MIME as `pageCount: 1`,
 * see `agent/src/pipeline/nodes/rasterize.ts`'s image-passthrough
 * branch), so we don't need to set an iterator index — decoding the
 * whole TIFF as one PNG matches the bbox coordinate space the vision
 * pipeline recorded.
 */
final readonly class ImagickTiffDecoder implements TiffDecoder
{
    public function decodeToPng(string $tiffBytes): string
    {
        $im = new Imagick();
        try {
            $im->readImageBlob($tiffBytes);
            $im->setImageFormat('png');
            $png = $im->getImageBlob();
        } catch (ImagickException $e) {
            throw new TiffDecodeException(
                'Imagick refused to decode TIFF bytes',
                previous: $e,
            );
        } finally {
            $im->clear();
        }
        return $png;
    }
}
