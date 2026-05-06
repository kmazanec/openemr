<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Service\Production;

use GuzzleHttp\ClientInterface;
use GuzzleHttp\Exception\GuzzleException;
use GuzzleHttp\Psr7\Request;
use OpenEMR\Modules\ClinicalCopilot\Auth\ClockInterface;
use OpenEMR\Modules\ClinicalCopilot\Service\SpacesConfig;
use OpenEMR\Modules\ClinicalCopilot\Service\SpacesUploadService;
use Psr\Log\LoggerInterface;

/**
 * SigV4-signed PUT against DigitalOcean Spaces (S3-compatible).
 * Implemented over the project's existing Guzzle client so we don't
 * pull in `aws/aws-sdk-php` and its ~50 transitive packages for a
 * single-call use case.
 *
 * Region in the credential scope is the DO region literal (e.g.
 * `nyc3`); DO Spaces accepts S3-compatible SigV4 with that region in
 * `<region>.digitaloceanspaces.com` exactly the way AWS S3 does.
 *
 * Failure mode: any non-2xx response or transport failure throws
 * {@see \RuntimeException}. The caller logs the exception and surfaces
 * a generic error to the panel (raw provider messages never leave the
 * boundary — see CLAUDE.md "Never expose `$e->getMessage()` in
 * user-facing output").
 */
final readonly class SigV4SpacesUploadService implements SpacesUploadService
{
    private const SERVICE = 's3';
    private const SIGNED_HEADERS = 'host;x-amz-content-sha256;x-amz-date';

    public function __construct(
        private SpacesConfig $config,
        private ClientInterface $httpClient,
        private ClockInterface $clock,
        private LoggerInterface $logger,
    ) {
    }

    public function upload(
        int $pid,
        string $documentUuid,
        string $extension,
        string $bytes,
        string $contentType,
    ): string {
        if ($pid <= 0) {
            throw new \DomainException('pid must be positive');
        }
        if ($documentUuid === '' || $extension === '' || $contentType === '') {
            throw new \DomainException('documentUuid, extension, contentType must all be non-empty');
        }
        if ($bytes === '') {
            throw new \DomainException('refusing to upload zero bytes');
        }

        $key = "{$pid}/{$documentUuid}.{$extension}";
        $url = "{$this->config->endpoint}/{$this->config->bucket}/{$key}";
        $host = parse_url($this->config->endpoint, PHP_URL_HOST);
        if (!is_string($host) || $host === '') {
            throw new \RuntimeException('Spaces endpoint missing host');
        }

        $now = $this->clock->now()->setTimezone(new \DateTimeZone('UTC'));
        $amzDate = $now->format('Ymd\THis\Z');
        $shortDate = $now->format('Ymd');
        $payloadHash = hash('sha256', $bytes);

        $canonicalRequest = $this->canonicalRequest(
            method: 'PUT',
            canonicalUri: '/' . $this->config->bucket . '/' . $this->encodeKeyPath($key),
            host: $host,
            amzDate: $amzDate,
            payloadHash: $payloadHash,
        );

        $credentialScope = "{$shortDate}/{$this->config->region}/" . self::SERVICE . '/aws4_request';
        $stringToSign = "AWS4-HMAC-SHA256\n{$amzDate}\n{$credentialScope}\n" . hash('sha256', $canonicalRequest);

        $signingKey = $this->deriveSigningKey($shortDate);
        $signature = hash_hmac('sha256', $stringToSign, $signingKey);

        $authorization = sprintf(
            'AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s',
            $this->config->accessKey,
            $credentialScope,
            self::SIGNED_HEADERS,
            $signature,
        );

        $request = new Request('PUT', $url, [
            'Host' => $host,
            'Content-Type' => $contentType,
            'X-Amz-Content-Sha256' => $payloadHash,
            'X-Amz-Date' => $amzDate,
            'Authorization' => $authorization,
        ], $bytes);

        try {
            $response = $this->httpClient->send($request, [
                'http_errors' => false,
                'connect_timeout' => 10.0,
                'timeout' => 60.0,
            ]);
        } catch (GuzzleException $e) {
            $this->logger->error('Spaces upload transport failed', [
                'pid' => $pid,
                'documentUuid' => $documentUuid,
                'exception' => $e,
            ]);
            throw new \RuntimeException('Spaces upload failed', 0, $e);
        }

        $status = $response->getStatusCode();
        if ($status < 200 || $status >= 300) {
            // S3 error bodies carry a `<Code>` element; we log it but
            // never echo it to the caller. The panel surfaces a generic
            // typed message instead.
            $this->logger->error('Spaces upload rejected', [
                'pid' => $pid,
                'documentUuid' => $documentUuid,
                'status' => $status,
                'body' => substr((string) $response->getBody(), 0, 512),
            ]);
            throw new \RuntimeException("Spaces upload failed with status {$status}");
        }

        return "s3://{$this->config->bucket}/{$key}";
    }

    private function canonicalRequest(
        string $method,
        string $canonicalUri,
        string $host,
        string $amzDate,
        string $payloadHash,
    ): string {
        $canonicalHeaders = "host:{$host}\nx-amz-content-sha256:{$payloadHash}\nx-amz-date:{$amzDate}\n";
        return "{$method}\n{$canonicalUri}\n\n{$canonicalHeaders}\n" . self::SIGNED_HEADERS . "\n{$payloadHash}";
    }

    private function deriveSigningKey(string $shortDate): string
    {
        $kDate = hash_hmac('sha256', $shortDate, 'AWS4' . $this->config->secretKey, binary: true);
        $kRegion = hash_hmac('sha256', $this->config->region, $kDate, binary: true);
        $kService = hash_hmac('sha256', self::SERVICE, $kRegion, binary: true);
        return hash_hmac('sha256', 'aws4_request', $kService, binary: true);
    }

    /**
     * Encode each path segment per RFC 3986 (S3 SigV4 expects the
     * canonical-URI path encoded except for the segment separators).
     * Our keys are `<pid>/<uuid>.<ext>` — alphanumerics and `-` only
     * once UUID + extension are minted — so this is conservative
     * defense rather than load-bearing today.
     */
    private function encodeKeyPath(string $key): string
    {
        $parts = explode('/', $key);
        return implode('/', array_map(rawurlencode(...), $parts));
    }
}
