<?php

/**
 * Narrow agent endpoint: per-practitioner day schedule.
 *
 * 1:1 with the agent's `getTodaysSchedule` tool (added in §5.3) and
 * with the morning-prep precompute job. Returns slots ordered by
 * startAt; emits one disclosure row per slot so compliance has a
 * per-patient audit trail.
 *
 * URL surface:
 *   /interface/modules/custom_modules/oe-module-clinical-copilot/
 *     public/snapshot/schedule.php?practitioner=<uuid>&date=<YYYY-MM-DD>
 *     &site=<id>&conversation=<id?>
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

$ignoreAuth = true; // phpcs:ignore SlevomatCodingStandard.Variables.UnusedVariable -- read by globals.php
require_once __DIR__ . '/../../../../../globals.php';

use OpenEMR\Modules\ClinicalCopilot\Auth\AgentEndpointAuth;
use OpenEMR\Modules\ClinicalCopilot\Auth\SqlAgentActorResolver;
use OpenEMR\Modules\ClinicalCopilot\Auth\SystemClock;
use OpenEMR\Modules\ClinicalCopilot\Bootstrap\AgentEndpointBootstrap;
use OpenEMR\Modules\ClinicalCopilot\Controller\ScheduleController;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\ScheduleServiceDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ScheduleAdapter;
use Symfony\Component\HttpFoundation\Request;

$request = Request::createFromGlobals();
$parsed = AgentEndpointBootstrap::parseRequest($request);
$logger = AgentEndpointBootstrap::logger();
$dispatcher = AgentEndpointBootstrap::buildDispatcher($logger);
$verifier = AgentEndpointBootstrap::buildVerifier($parsed->siteId);

$practitionerParam = $request->query->get('practitioner');
$practitioner = is_string($practitionerParam) && $practitionerParam !== '' ? $practitionerParam : null;

$dateParam = $request->query->get('date');
$date = is_string($dateParam) && $dateParam !== '' ? $dateParam : null;

$controller = new ScheduleController(
    auth: new AgentEndpointAuth($verifier, new SqlAgentActorResolver(), $logger, $parsed->siteId),
    adapter: new ScheduleAdapter(new ScheduleServiceDataSource()),
    eventDispatcher: $dispatcher,
    logger: $logger,
    siteId: $parsed->siteId,
    clock: new SystemClock(),
);

$controller->handle($parsed->bearer, $practitioner, $date, $parsed->conversationId);
