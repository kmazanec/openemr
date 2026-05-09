<?php

/**
 * Shared wiring helper for the narrow agent snapshot endpoints
 * (prescriptions.php, labs.php, encounters.php, patientContext.php).
 *
 * Centralizes the three pieces every endpoint needs:
 *   - JWT verifier built against the site's OAuth2 issuer
 *   - {@see EventDispatcher} with the disclosure listener attached
 *   - request parsing for bearer / pid / conversation / site
 *
 * The narrow controllers themselves take only the adapters they need,
 * so each endpoint's `.php` shim stays a few lines: parse → bootstrap
 * → construct controller → handle.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Bootstrap;

use OpenEMR\BC\ServiceContainer;
use OpenEMR\Core\OEGlobalsBag;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentSigningKey;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentTokenMinter;
use OpenEMR\Modules\ClinicalCopilot\Auth\OpenEmrJwtVerifier;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDbalConnection;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosedEvent;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosureListener;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\DbalAgentRequestLogRecorder;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\ExtendedLogDisclosureRecorder;
use Psr\Log\LoggerInterface;
use Symfony\Component\EventDispatcher\EventDispatcher;
use Symfony\Component\HttpFoundation\Request;

/**
 * Parsed request envelope for narrow snapshot endpoints.
 */
final readonly class ParsedAgentRequest
{
    public function __construct(
        public ?string $bearer,
        public ?int $pid,
        public ?string $conversationId,
        public string $siteId,
    ) {
    }
}

final class AgentEndpointBootstrap
{
    public static function parseRequest(Request $request): ParsedAgentRequest
    {
        $bearer = null;
        $authHeader = $request->headers->get('Authorization');
        if (is_string($authHeader) && str_starts_with($authHeader, 'Bearer ')) {
            $bearer = substr($authHeader, 7);
        }

        $pid = null;
        $pidParam = $request->query->get('pid');
        if (is_string($pidParam) && ctype_digit($pidParam)) {
            $pid = (int) $pidParam;
        }

        $conversationParam = $request->query->get('conversation');
        $conversationId = is_string($conversationParam) && $conversationParam !== ''
            ? $conversationParam
            : null;

        $siteIdRaw = $request->query->get('site');
        $siteId = is_string($siteIdRaw) && $siteIdRaw !== '' ? $siteIdRaw : 'default';

        return new ParsedAgentRequest($bearer, $pid, $conversationId, $siteId);
    }

    /**
     * Resolve the JWT issuer string used for both minting (in
     * `agent.php`) and verifying (in `snapshot.php` and the narrow
     * endpoint controllers via `buildVerifier()` below).
     *
     * Both sides MUST agree byte-for-byte. When `OE_AGENT_JWT_ISSUER`
     * is set on the OpenEMR container, that value wins — it pins the
     * issuer to whatever the agent service is configured to expect via
     * its own `AGENT_JWT_ISSUER` env var. Without the override we
     * compose the historical default (`site_addr_oath + webroot +
     * /oauth2/{site}`) so test fixtures and installs that haven't been
     * migrated keep working.
     *
     * Why an override is needed at all: in container deployments the
     * URL OpenEMR sees itself as (e.g. `http://openemr` on the docker
     * network) is different from the URL the *user's browser* and the
     * agent's JWKS-fetcher use (e.g. `https://localhost:9300` or
     * `https://emr.biograph.dev`). The agent service is configured
     * with the externally-facing URL, so the JWT must carry that exact
     * string in the `iss` claim — derived-from-globals is wrong on
     * any deploy where `site_addr_oath` differs from the agent's
     * `AGENT_JWT_ISSUER`. The minter side honored this via
     * `OE_AGENT_JWT_ISSUER` since 744a888b6; the verifier sides
     * (snapshot.php, AgentEndpointBootstrap::buildVerifier) were
     * missed and 401'd every snapshot read with `invalid_token` until
     * this helper centralized the logic.
     */
    public static function resolveIssuer(string $siteId): string
    {
        $override = getenv('OE_AGENT_JWT_ISSUER');
        if (is_string($override) && $override !== '') {
            return $override;
        }
        $globals = OEGlobalsBag::getInstance();
        $siteAddr = $globals->getString('site_addr_oath');
        $webroot = $globals->getWebRoot();
        return $siteAddr . $webroot . '/oauth2/' . $siteId;
    }

    public static function buildVerifier(string $siteId): OpenEmrJwtVerifier
    {
        return new OpenEmrJwtVerifier(
            publicKeyPem: AgentSigningKey::fromOAuth2KeyConfig()->publicKeyPem,
            issuer: self::resolveIssuer($siteId),
            audience: AgentTokenMinter::AGENT_CLIENT_ID,
        );
    }

    public static function buildDispatcher(LoggerInterface $logger): EventDispatcher
    {
        $connection = AgentDbalConnection::get();
        $dispatcher = new EventDispatcher();
        $dispatcher->addListener(
            AgentDisclosedEvent::EVENT_HANDLE,
            new AgentDisclosureListener(
                new ExtendedLogDisclosureRecorder($connection),
                new DbalAgentRequestLogRecorder($connection),
                $logger,
            ),
        );
        return $dispatcher;
    }

    public static function logger(): LoggerInterface
    {
        return ServiceContainer::getLogger();
    }
}
