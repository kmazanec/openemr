<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Core\Migrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Clinical Co-Pilot — seed required OpenEMR globals for the agent path.
 *
 * The agent proxy mints a JWT whose `iss` is built from
 * `site_addr_oath` + webroot + `/oauth2/{site}`. The agent service
 * verifies that issuer against `AGENT_JWT_ISSUER` (set in compose to
 * `https://${OE_DOMAIN}/oauth2/default`). If `site_addr_oath` is empty
 * the issuer mismatches and every request 401s — which is exactly the
 * mode prod was in before this migration.
 *
 * `rest_api` and `rest_fhir_api` gate OpenEMR's OAuth2 + FHIR surface.
 * The agent path needs both: the proxy hits `/oauth2/default/jwk` for
 * the verifier's JWKS resolver, and the agent calls back to
 * `/apis/{site}/fhir/...` for the snapshot fetch.
 *
 * UPSERTs are keyed on the PK `(gl_name, gl_index)` and use
 * INSERT…ON DUPLICATE KEY UPDATE so reapplying on a DB that already
 * has the rows (manual SQL fix, prior partial run, etc.) is a no-op.
 *
 * Note: this migration assumes the production hostname `emr.biograph.dev`.
 * Other deployments must override the `site_addr_oath` value through the
 * admin UI after running migrations; the UPSERT only sets the value if
 * the row is absent or already matches our default.
 */
final class Version20260430000002 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Seed rest_api, rest_fhir_api, site_addr_oath globals for the agent path';
    }

    public function up(Schema $schema): void
    {
        // Enable REST + FHIR APIs. Idempotent: if the row exists we set
        // the value to '1' regardless of what was there. The intent of
        // this deployment is that the APIs are always on, so we don't
        // try to preserve a manual override here.
        $this->addSql(<<<'SQL'
            INSERT INTO globals (gl_name, gl_index, gl_value)
            VALUES ('rest_api', 0, '1')
            ON DUPLICATE KEY UPDATE gl_value = VALUES(gl_value)
        SQL);

        $this->addSql(<<<'SQL'
            INSERT INTO globals (gl_name, gl_index, gl_value)
            VALUES ('rest_fhir_api', 0, '1')
            ON DUPLICATE KEY UPDATE gl_value = VALUES(gl_value)
        SQL);

        // OAuth2 issuer host. The agent's AGENT_JWT_ISSUER is
        // `https://${OE_DOMAIN}/oauth2/default`; this row is the OE_DOMAIN
        // half of that contract. Only seed when the row is absent — admins
        // who set this from the UI on a non-prod deploy should keep their
        // value. The COALESCE-on-empty form means we still backfill blanks
        // (the failure mode this migration fixes).
        $this->addSql(<<<'SQL'
            INSERT INTO globals (gl_name, gl_index, gl_value)
            VALUES ('site_addr_oath', 0, 'https://emr.biograph.dev')
            ON DUPLICATE KEY UPDATE
                gl_value = IF(gl_value = '', VALUES(gl_value), gl_value)
        SQL);
    }

    public function down(Schema $schema): void
    {
        // Down-migration is a no-op. We don't roll back globals because
        // (a) the prior values are not knowable from this migration and
        // (b) reverting rest_api to '0' would break any other surface
        // the deployment relies on. Operators rolling back the schema
        // can edit globals from the admin UI.
    }
}
