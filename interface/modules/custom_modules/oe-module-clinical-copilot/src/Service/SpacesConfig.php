<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Service;

/**
 * DigitalOcean Spaces config for the OpenEMR-side IAM identity. The
 * matching agent-side parser lives at `agent/src/config/spacesEnv.ts`;
 * the env-var names are kept in sync so a single `.env` configures both
 * sides. The PHP side only ever needs the `openemr` credential set —
 * the `agent` credentials are consumed exclusively by the Node service.
 */
final readonly class SpacesConfig
{
    public function __construct(
        public string $bucket,
        public string $region,
        public string $endpoint,
        public string $accessKey,
        public string $secretKey,
    ) {
    }

    /**
     * Build from a raw env-var array (typically `$_ENV` plus `getenv()`
     * fallbacks). Throws on missing/empty required vars so misconfigured
     * environments fail loud at first request rather than silently
     * uploading nowhere.
     *
     * @param array<string, string|false> $env
     */
    public static function fromEnv(array $env): self
    {
        $bucket = self::requireString($env, 'SPACES_BUCKET');
        $region = self::requireString($env, 'SPACES_REGION');
        $accessKey = self::requireString($env, 'SPACES_OPENEMR_KEY');
        $secretKey = self::requireString($env, 'SPACES_OPENEMR_SECRET');

        return new self(
            bucket: $bucket,
            region: $region,
            endpoint: "https://{$region}.digitaloceanspaces.com",
            accessKey: $accessKey,
            secretKey: $secretKey,
        );
    }

    /**
     * @param array<string, string|false> $env
     */
    private static function requireString(array $env, string $key): string
    {
        $value = $env[$key] ?? false;
        if (!is_string($value) || trim($value) === '') {
            throw new \RuntimeException("{$key} is required and must be non-empty");
        }
        return trim($value);
    }
}
