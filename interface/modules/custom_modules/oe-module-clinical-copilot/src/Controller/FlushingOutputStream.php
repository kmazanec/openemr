<?php

/**
 * Write-only PSR-7 stream that fans every chunk to `php://output` and
 * flushes the SAPI on each write.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Controller;

use Psr\Http\Message\StreamInterface;
use RuntimeException;

/**
 * Used as the `RequestOptions::SINK` for the agent SSE proxy: Guzzle's
 * cURL handler calls `write()` for each chunk cURL pulls off the
 * socket, and we forward the chunk to the browser immediately. Read
 * methods are unsupported — this is purely a write-side adapter for
 * piping a streaming response back through the OpenEMR SAPI.
 */
final class FlushingOutputStream implements StreamInterface
{
    private int $bytesWritten = 0;
    private bool $closed = false;

    public function write($string): int
    {
        if ($this->closed) {
            throw new RuntimeException('Cannot write to a closed stream');
        }
        echo $string;
        flush();
        $written = strlen($string);
        $this->bytesWritten += $written;
        return $written;
    }

    public function close(): void
    {
        $this->closed = true;
    }

    public function detach()
    {
        $this->closed = true;
        return null;
    }

    public function getSize(): int
    {
        return $this->bytesWritten;
    }

    public function tell(): int
    {
        return $this->bytesWritten;
    }

    public function eof(): bool
    {
        return $this->closed;
    }

    public function isSeekable(): bool
    {
        return false;
    }

    public function seek($offset, $whence = SEEK_SET): void
    {
        throw new RuntimeException('FlushingOutputStream is not seekable');
    }

    public function rewind(): void
    {
        throw new RuntimeException('FlushingOutputStream is not seekable');
    }

    public function isWritable(): bool
    {
        return !$this->closed;
    }

    public function isReadable(): bool
    {
        return false;
    }

    public function read($length): string
    {
        throw new RuntimeException('FlushingOutputStream is write-only');
    }

    public function getContents(): string
    {
        throw new RuntimeException('FlushingOutputStream is write-only');
    }

    public function getMetadata($key = null)
    {
        return $key === null ? [] : null;
    }

    public function __toString(): string
    {
        return '';
    }
}
