<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Cli;

use GuzzleHttp\Client;
use GuzzleHttp\ClientInterface;
use GuzzleHttp\Exception\GuzzleException;
use GuzzleHttp\RequestOptions;
use Psr\Http\Message\ResponseInterface;
use Throwable;

/**
 * Production {@see BriefingHttpClient} backed by Guzzle. Streams the
 * agent's SSE response and reduces it to a {@see BriefingHttpOutcome},
 * throwing {@see BriefingHttpException} on transport failure, non-2xx,
 * or terminal `error` events.
 *
 * The SSE wire format the agent emits is locked in
 * {@see \OpenEMR\Modules\ClinicalCopilot\Snapshot\… briefingStream.ts}:
 * `event: <type>\ndata: <json>\n\n`. We only need the `done` and `error`
 * frames, so the parser is small and deliberately doesn't attempt to be
 * a general-purpose SSE library.
 */
final readonly class GuzzleBriefingHttpClient implements BriefingHttpClient
{
    public function __construct(private ClientInterface $client = new Client())
    {
    }

    /**
     * @param array<string, mixed> $envelope
     */
    public function postBriefing(string $url, string $bearerToken, array $envelope): BriefingHttpOutcome
    {
        try {
            $response = $this->client->request('POST', $url, [
                RequestOptions::HEADERS => [
                    'Authorization' => 'Bearer ' . $bearerToken,
                    'Accept' => 'text/event-stream',
                    'Content-Type' => 'application/json',
                ],
                RequestOptions::JSON => $envelope,
                RequestOptions::STREAM => true,
                // Long enough that a 30-minute UC1 graph still fits;
                // the in-process token TTL is the operational ceiling.
                RequestOptions::READ_TIMEOUT => 600,
                RequestOptions::CONNECT_TIMEOUT => 10,
                RequestOptions::HTTP_ERRORS => false,
            ]);
        } catch (GuzzleException $e) {
            throw new BriefingHttpException(
                'agent briefing request failed at the transport layer',
                0,
                'transport_error',
                $e,
            );
        }

        $status = $response->getStatusCode();
        if ($status < 200 || $status >= 300) {
            throw new BriefingHttpException(
                'agent briefing endpoint returned non-2xx',
                $status,
                'http_' . (string) $status,
            );
        }

        return self::parseSseStream(
            $response,
            is_string($envelope['appointmentId'] ?? null) ? $envelope['appointmentId'] : '',
        );
    }

    private static function parseSseStream(
        ResponseInterface $response,
        string $appointmentIdEcho,
    ): BriefingHttpOutcome {
        $body = $response->getBody();
        $buffer = '';
        try {
            while (!$body->eof()) {
                $chunk = $body->read(8192);
                if ($chunk === '') {
                    // The PSR-7 contract permits empty reads while the
                    // remote keeps the connection open; loop back to
                    // the eof() check rather than busy-spinning here.
                    continue;
                }
                $buffer .= $chunk;
                while (($boundary = strpos($buffer, "\n\n")) !== false) {
                    $frame = substr($buffer, 0, $boundary);
                    $buffer = substr($buffer, $boundary + 2);
                    $outcome = self::frameToOutcome($frame, $appointmentIdEcho);
                    if ($outcome !== null) {
                        return $outcome;
                    }
                }
            }
        } catch (BriefingHttpException $e) {
            // Terminal `error` frames bubble through the parser as
            // typed exceptions; preserve them rather than wrapping
            // them in a generic stream-read error.
            throw $e;
        } catch (Throwable $e) {
            throw new BriefingHttpException(
                'agent briefing stream read failed',
                0,
                'stream_read_error',
                $e,
            );
        }
        // EOF with no done/error: contract violation — surface as error.
        throw new BriefingHttpException(
            'agent briefing stream ended without a done or error event',
            0,
            'stream_truncated',
        );
    }

    /**
     * Returns null when the frame is uninteresting (e.g. `meta`,
     * `assistantMessage`); a {@see BriefingHttpOutcome} when a `done`
     * event is reached. Throws {@see BriefingHttpException} on a
     * terminal `error` frame.
     */
    private static function frameToOutcome(string $frame, string $appointmentIdEcho): ?BriefingHttpOutcome
    {
        $event = null;
        $data = null;
        foreach (preg_split('/\r?\n/', trim($frame)) ?: [] as $line) {
            if (str_starts_with($line, 'event:')) {
                $event = trim(substr($line, strlen('event:')));
            } elseif (str_starts_with($line, 'data:')) {
                $data = trim(substr($line, strlen('data:')));
            }
        }
        if ($event === null || $data === null) {
            return null;
        }
        if ($event === 'error') {
            $payload = json_decode($data, true);
            $code = is_array($payload) && is_string($payload['code'] ?? null)
                ? $payload['code']
                : 'unknown';
            throw new BriefingHttpException(
                'agent briefing stream emitted error event',
                0,
                $code,
            );
        }
        if ($event !== 'done') {
            return null;
        }
        $payload = json_decode($data, true);
        $precompute = is_array($payload) ? ($payload['precompute'] ?? null) : null;
        $outcome = is_array($precompute) && is_string($precompute['outcome'] ?? null)
            ? $precompute['outcome']
            : null;
        return new BriefingHttpOutcome(
            done: true,
            precomputeOutcome: $outcome,
            appointmentId: $appointmentIdEcho,
        );
    }
}
