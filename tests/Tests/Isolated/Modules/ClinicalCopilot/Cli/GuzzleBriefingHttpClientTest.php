<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Cli;

use GuzzleHttp\Client;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Psr7\Response;
use GuzzleHttp\Psr7\Utils;
use OpenEMR\Modules\ClinicalCopilot\Cli\BriefingHttpException;
use OpenEMR\Modules\ClinicalCopilot\Cli\GuzzleBriefingHttpClient;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\RequestInterface;

require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Cli/BriefingHttpClient.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Cli/BriefingHttpException.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Cli/BriefingHttpOutcome.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Cli/GuzzleBriefingHttpClient.php';

final class GuzzleBriefingHttpClientTest extends TestCase
{
    public function testParsesPrecomputeDoneEventIntoOutcome(): void
    {
        $body = $this->sseStream(
            $this->frame('meta', ['conversationId' => 'c-1']),
            $this->frame('assistantMessage', ['message' => ['segments' => []]]),
            $this->frame('done', [
                'persistedAt' => '2026-05-02T12:00:00Z',
                'precompute' => ['appointmentId' => 'apt-1', 'outcome' => 'inserted'],
            ]),
        );
        $sent = new RecordedHistory();
        $client = $this->buildClient(new Response(200, [], $body), $sent);

        $outcome = $client->postBriefing(
            'http://agent.test/v1/agent/briefing',
            'tok-abc',
            ['appointmentId' => 'apt-1', 'precompute' => true],
        );

        $this->assertTrue($outcome->done);
        $this->assertSame('inserted', $outcome->precomputeOutcome);
        $this->assertSame('apt-1', $outcome->appointmentId);

        $this->assertCount(1, $sent->container);
        $request = $sent->container[0]['request'] ?? null;
        $this->assertInstanceOf(RequestInterface::class, $request);
        $this->assertSame('Bearer tok-abc', $request->getHeaderLine('Authorization'));
        $this->assertSame('text/event-stream', $request->getHeaderLine('Accept'));
    }

    public function testThrowsOnTerminalErrorFrame(): void
    {
        $body = $this->sseStream(
            $this->frame('error', ['code' => 'briefing_failed']),
        );
        $sent = new RecordedHistory();
        $client = $this->buildClient(new Response(200, [], $body), $sent);

        $this->expectException(BriefingHttpException::class);
        try {
            $client->postBriefing(
                'http://agent.test/v1/agent/briefing',
                'tok-abc',
                ['appointmentId' => 'apt-1'],
            );
        } catch (BriefingHttpException $e) {
            $this->assertSame('briefing_failed', $e->errorCode);
            throw $e;
        }
    }

    public function testThrowsOnNon2xxStatus(): void
    {
        $sent = new RecordedHistory();
        $client = $this->buildClient(new Response(503, [], 'service down'), $sent);

        $this->expectException(BriefingHttpException::class);
        try {
            $client->postBriefing(
                'http://agent.test/v1/agent/briefing',
                'tok-abc',
                ['appointmentId' => 'apt-1'],
            );
        } catch (BriefingHttpException $e) {
            $this->assertSame(503, $e->status);
            $this->assertSame('http_503', $e->errorCode);
            throw $e;
        }
    }

    public function testThrowsOnTruncatedStream(): void
    {
        // Stream ends after assistantMessage with no done/error.
        $body = $this->sseStream(
            $this->frame('meta', ['conversationId' => 'c-1']),
            $this->frame('assistantMessage', ['message' => ['segments' => []]]),
        );
        $sent = new RecordedHistory();
        $client = $this->buildClient(new Response(200, [], $body), $sent);

        $this->expectException(BriefingHttpException::class);
        try {
            $client->postBriefing(
                'http://agent.test/v1/agent/briefing',
                'tok-abc',
                ['appointmentId' => 'apt-1'],
            );
        } catch (BriefingHttpException $e) {
            $this->assertSame('stream_truncated', $e->errorCode);
            throw $e;
        }
    }

    public function testHandlesPartialChunkBoundaries(): void
    {
        // Concatenate two frames, then split into chunks across the
        // event boundary and across `data:` lines so the parser must
        // cope with split reads.
        $full = $this->frame('meta', ['conversationId' => 'c-1'])
            . $this->frame('done', [
                'persistedAt' => '2026-05-02T12:00:00Z',
                'precompute' => ['appointmentId' => 'apt-1', 'outcome' => 'overwritten'],
            ]);
        // GuzzleHttp\Psr7\Utils::streamFor delivers the whole payload
        // when read in one call, so to exercise the chunking branch we
        // wrap a stream that yields N bytes per read() call.
        $sent = new RecordedHistory();
        $client = $this->buildClient(new Response(200, [], $this->chunkedStreamFor($full, 7)), $sent);

        $outcome = $client->postBriefing(
            'http://agent.test/v1/agent/briefing',
            'tok-abc',
            ['appointmentId' => 'apt-1'],
        );
        $this->assertSame('overwritten', $outcome->precomputeOutcome);
    }

    /**
     * Guzzle's `Middleware::history` records each round-trip into the
     * passed-by-ref container; PHPStan's by-ref type rules don't
     * match the upstream signature exactly, so the helper takes a
     * `RecordedHistory` wrapper that preserves typing for callers
     * while letting the middleware mutate the inner array.
     */
    private function buildClient(Response $response, RecordedHistory $sent): GuzzleBriefingHttpClient
    {
        $mock = new MockHandler([$response]);
        $stack = HandlerStack::create($mock);
        $stack->push(self::buildHistoryMiddleware($sent));
        $guzzle = new Client(['handler' => $stack]);
        return new GuzzleBriefingHttpClient($guzzle);
    }

    /**
     * Inline replacement for `Middleware::history()` whose by-ref
     * contract widens the typed property on {@see RecordedHistory}.
     * Records each round-trip into the wrapper as a typed row.
     */
    private static function buildHistoryMiddleware(RecordedHistory $sent): callable
    {
        return static fn(callable $handler): callable => static function (RequestInterface $request, array $options) use ($handler, $sent) {
            /** @var \GuzzleHttp\Promise\PromiseInterface $promise */
            $promise = $handler($request, $options);
            return $promise->then(
                static function ($value) use ($request, $options, $sent) {
                    $sent->container[] = [
                        'request' => $request,
                        'response' => $value,
                        'error' => null,
                        'options' => $options,
                    ];
                    return $value;
                },
            );
        };
    }

    /**
     * @param array<string, mixed> $payload
     */
    private function frame(string $event, array $payload): string
    {
        $payload['type'] = $event;
        return "event: {$event}\ndata: " . json_encode($payload, JSON_THROW_ON_ERROR) . "\n\n";
    }

    private function sseStream(string ...$frames): \Psr\Http\Message\StreamInterface
    {
        return Utils::streamFor(implode('', $frames));
    }

    private function chunkedStreamFor(string $payload, int $chunkSize): \Psr\Http\Message\StreamInterface
    {
        return new ChunkedReadStream($payload, $chunkSize);
    }
}

final class ChunkedReadStream implements \Psr\Http\Message\StreamInterface
{
    private int $cursor = 0;

    public function __construct(
        private readonly string $payload,
        private readonly int $chunkSize,
    ) {
    }

    public function __toString(): string
    {
        return $this->payload;
    }

    public function close(): void
    {
    }

    public function detach()
    {
        return null;
    }

    public function getSize(): int
    {
        return strlen($this->payload);
    }

    public function tell(): int
    {
        return $this->cursor;
    }

    public function eof(): bool
    {
        return $this->cursor >= strlen($this->payload);
    }

    public function isSeekable(): bool
    {
        return false;
    }

    public function seek(int $offset, int $whence = SEEK_SET): void
    {
        throw new \RuntimeException('not seekable');
    }

    public function rewind(): void
    {
        $this->cursor = 0;
    }

    public function isWritable(): bool
    {
        return false;
    }

    public function write(string $string): int
    {
        throw new \RuntimeException('not writable');
    }

    public function isReadable(): bool
    {
        return true;
    }

    public function read(int $length): string
    {
        $remaining = strlen($this->payload) - $this->cursor;
        if ($remaining <= 0) {
            return '';
        }
        $take = min($this->chunkSize, $length, $remaining);
        $slice = substr($this->payload, $this->cursor, $take);
        $this->cursor += $take;
        return $slice;
    }

    public function getContents(): string
    {
        $rest = substr($this->payload, $this->cursor);
        $this->cursor = strlen($this->payload);
        return $rest;
    }

    public function getMetadata(?string $key = null)
    {
        return $key === null ? [] : null;
    }
}

/**
 * Wrapper around the by-ref container Guzzle's history middleware
 * mutates. Lets the test assert against a typed `list<array>` while
 * the middleware is happy with a looser upstream contract.
 */
final class RecordedHistory
{
    /** @var list<array<int|string, mixed>> */
    public array $container = [];
}
